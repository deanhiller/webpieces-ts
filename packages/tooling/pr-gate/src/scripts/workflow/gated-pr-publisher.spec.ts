import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { GateTokenService } from '@webpieces/rules-config';
import { specTempDirs } from '@webpieces/tooling-testkit';
import { ProcessResultDto } from '@webpieces/tooling-common';
import { CapturedOutput, PrGateFeature } from '../../__tests__/feature-harness';
import { GatedPrPublisher, PrBodyDraft, PublishedPr } from './gated-pr-publisher';

/**
 * The production publisher from the shipped container (#1381), with `gh` and git SCRIPTED. `order` is
 * the sequence in which the program reached the outside world — that sequence IS the invariant under
 * test: the gated body goes up BEFORE the push.
 */

const SALT = 's3cr3t';
const PARENT_SHA = 'a'.repeat(40);
const NEW_HEAD_SHA = 'b'.repeat(40);
const BRANCH = 'dean/feature';

let feature: PrGateFeature;
let output: CapturedOutput;
let dir = '';
let order: string[] = [];
let bodyAtEdit = '';
// What the PR-number prediction query answers: the newest issue/PR/discussion number and the repo URL.
let predictAnswer = new ProcessResultDto(0, '41\thttps://github.com/o/r\n', '');

let bodyAtCreate = '';

// The body wp-finish-upsert-pr hands the publisher: the dashboard (with its self-link, '' when unknown)
// plus the token for the LOCAL head sha.
function renderBody(headSha: string, prUrl: string): string {
    return `# dashboard\n${prUrl}\n\n${new GateTokenService().gateTokenMarker(SALT, headSha)}`;
}

function gatedDraft(headSha: string, knownUrl = ''): PrBodyDraft {
    const file = path.join(dir, 'pr-body.md');
    const body = renderBody(headSha, knownUrl);
    fs.writeFileSync(file, body + '\n');
    return new PrBodyDraft(file, body, (prUrl: string): string => renderBody(headSha, prUrl));
}

/** Script GitHub and the remote: whether a PR is open, and whether the edit, push and create succeed. */
function world(existingPr: string, editOk = true, pushOk = true, createOk = true): void {
    feature.processes.respondToPrefix('gh', ['pr', 'list', '--head', BRANCH], (): ReturnType<typeof feature.processes.ok> => {
        order.push('findOpenPr');
        return feature.processes.ok(existingPr === '' ? '' : `${existingPr}\n`);
    });
    feature.processes.respondToPrefix('gh', ['pr', 'edit'], (call): ReturnType<typeof feature.processes.ok> => {
        order.push('editPr');
        bodyAtEdit = fs.readFileSync(call.args[call.args.indexOf('--body-file') + 1], 'utf8');
        return editOk ? feature.processes.ok() : feature.processes.fail(1, 'HTTP 401');
    });
    feature.processes.respondToPrefix('gh', ['pr', 'create'], (call): ReturnType<typeof feature.processes.ok> => {
        order.push('createPr');
        bodyAtCreate = fs.readFileSync(call.args[call.args.indexOf('--body-file') + 1], 'utf8');
        return createOk ? feature.processes.ok() : feature.processes.fail(1, 'HTTP 422');
    });
    feature.processes.respondToPrefix('gh', ['api', 'graphql'], (): ReturnType<typeof feature.processes.ok> => {
        order.push('predict');
        return predictAnswer;
    });
    feature.git.respond(['ls-remote', '--exit-code', '--heads', 'origin', BRANCH],
        existingPr === '' ? feature.git.fail(2) : feature.git.ok());
    feature.git.respondToPrefix(['push'], (): ReturnType<typeof feature.git.ok> => {
        order.push('push');
        return pushOk ? feature.git.ok() : feature.git.fail(1, 'rejected');
    });
}

function publish(headSha: string = NEW_HEAD_SHA, retry?: string, knownUrl = ''): Promise<PublishedPr> {
    return feature.container.get(GatedPrPublisher).publish(BRANCH, 'My PR title', gatedDraft(headSha, knownUrl), retry);
}

beforeEach(async (): Promise<void> => {
    feature = await PrGateFeature.create();
    output = CapturedOutput.start();
    dir = specTempDirs.make('wp-gated-publisher-');
    order = [];
    bodyAtEdit = '';
    bodyAtCreate = '';
    predictAnswer = new ProcessResultDto(0, '41\thttps://github.com/o/r\n', '');
});

afterEach((): void => {
    output.stop();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('existing PR — the body is written BEFORE the push', () => {
    it('edits the PR, THEN pushes (the ordering that removes the synchronize race)', async () => {
        world('42');
        const result = await publish();

        expect(order).toEqual(['findOpenPr', 'editPr', 'push']);
        expect(result.number).toBe('42');
        expect(result.createFailed).toBe(false);
        // An existing remote branch is pushed with a lease — the 3-point squash rewrites history.
        expect(feature.git.commandLines()).toContain(`git push --force-with-lease origin HEAD:${BRANCH}`);
    });

    it('never creates a second PR when one already exists', async () => {
        world('42');
        await publish();
        expect(order).not.toContain('createPr');
    });

    it('the body already on the PR when the push fires carries HMAC(salt, NEW head) — a synchronize read landing immediately after the push verifies', async () => {
        world('42');
        await publish(NEW_HEAD_SHA);

        // What CI would read at the instant `synchronize` arrives is exactly what gh pr edit received.
        const tokens = new GateTokenService();
        expect(tokens.verifyGateToken(bodyAtEdit, SALT, NEW_HEAD_SHA)).toBe(true);
        // ...and it is NOT the previous run's token, which is what the old push-first order exposed.
        expect(tokens.verifyGateToken(bodyAtEdit, SALT, PARENT_SHA)).toBe(false);
    });

    it('passes the title through to gh pr edit', async () => {
        world('42');
        await publish();
        const edit = feature.processes.callsStartingWith('gh', ['pr', 'edit'])[0];
        expect(edit.args).toEqual(['pr', 'edit', '42', '--title', 'My PR title', '--body-file', path.join(dir, 'pr-body.md')]);
    });
});

describe('gh pr edit fails', () => {
    it('aborts BEFORE pushing, so the remote is left wholly untouched', async () => {
        world('42', false);
        await expect(publish()).rejects.toThrowError(/gh pr edit failed on PR #42/);
        expect(order).toEqual(['findOpenPr', 'editPr']);
        expect(order).not.toContain('push');
    });

    it('names the human caller when the shared publisher is used by wp-human-post-pr', async () => {
        world('42', false);
        await expect(publish(NEW_HEAD_SHA, 'pnpm wp-human-post-pr')).rejects.toThrowError(/pnpm wp-human-post-pr/);
    });
});

describe('push fails after the body edit landed', () => {
    it('throws rather than reporting a published PR — the gate check goes red, never falsely green', async () => {
        world('42', true, false);
        await expect(publish()).rejects.toThrowError(/Failed to push branch/);
        expect(order).toEqual(['findOpenPr', 'editPr', 'push']);
        // Nothing after the push ran, so no merge/auto-merge can be kicked off on the stale remote head.
        expect(order).not.toContain('createPr');
    });
});

describe('no existing PR — create path', () => {
    it('pushes FIRST, then creates (gh pr create needs the remote ref, and `opened` sees the final body)', async () => {
        world('');
        const result = await publish();

        expect(order).toEqual(['findOpenPr', 'push', 'predict', 'createPr']);
        expect(order).not.toContain('editPr');
        expect(result.number).toBe('');
        expect(result.createFailed).toBe(false);
        // A brand-new remote branch is pushed with -u, never forced.
        expect(feature.git.commandLines()).toContain(`git push -u origin HEAD:${BRANCH}`);
    });

    it('reports createFailed so the caller does not claim a PR that was never opened', async () => {
        world('', true, true, false);
        expect((await publish()).createFailed).toBe(true);
    });

    it('a push failure with no PR yet just propagates — nothing was edited, so no extra explanation', async () => {
        world('', true, false);
        await expect(publish()).rejects.toThrowError(/Failed to push new branch/);
        expect(order).toEqual(['findOpenPr', 'push']);
    });
});

describe('create path — the new PR number is PREDICTED so the body carries its own link (#1418)', () => {
    it('predicts newest+1 AFTER the push and creates the PR with the predicted link already in the body', async () => {
        world('');
        const result = await publish();

        // After the push (the race window is the few seconds between predict and create), never before.
        expect(order).toEqual(['findOpenPr', 'push', 'predict', 'createPr']);
        expect(result.predictedNumber).toBe('42');
        expect(bodyAtCreate).toBe(renderBody(NEW_HEAD_SHA, 'https://github.com/o/r/pull/42') + '\n');
        // What went up is reported back byte for byte, so the caller's final render can be compared to it.
        expect(result.body + '\n').toBe(bodyAtCreate);
        // The gate token is still the one for the local head — the prediction only touches the self-link.
        expect(new GateTokenService().verifyGateToken(bodyAtCreate, SALT, NEW_HEAD_SHA)).toBe(true);
    });

    it('queries the shared issue/PR/discussion counter of the current repo', async () => {
        world('');
        await publish();
        const call = feature.processes.callsStartingWith('gh', ['api', 'graphql'])[0];
        expect(call.args).toContain('owner={owner}');
        expect(call.args).toContain('name={repo}');
        const query = call.args.find((a: string): boolean => a.startsWith('query=')) ?? '';
        expect(query).toMatch(/issues\(first: 1/);
        expect(query).toMatch(/pullRequests\(first: 1/);
        expect(query).toMatch(/discussions\(first: 1/);
    });

    it('a correct guess: reportPredictedLink says so', async () => {
        world('');
        const result = await publish();
        feature.container.get(GatedPrPublisher).reportPredictedLink(result, '42');
        expect(output.stdout).toContain('PR link predicted #42 ✓');
    });

    it('a wrong guess (predicted N, GitHub assigned N+1): reportPredictedLink names both and the back-fill', async () => {
        world('');
        const result = await publish();
        feature.container.get(GatedPrPublisher).reportPredictedLink(result, '43');
        expect(output.stdout).toContain('PR link predicted #42, got #43: back-filling the real link');
    });

    it('a failed prediction warns, creates with the body as drafted, and never fails the run', async () => {
        world('');
        predictAnswer = new ProcessResultDto(1, '', 'GraphQL: Field discussions does not exist');
        const result = await publish();

        expect(result.createFailed).toBe(false);
        expect(result.predictedNumber).toBe('');
        expect(bodyAtCreate).toBe(renderBody(NEW_HEAD_SHA, '') + '\n');
        expect(output.stderr).toContain("Could not predict the new PR's number (GraphQL: Field discussions does not exist)");
        feature.container.get(GatedPrPublisher).reportPredictedLink(result, '42');
        expect(output.stdout).not.toContain('PR link predicted');
    });

    it('an unparseable answer is treated as no prediction', async () => {
        world('');
        predictAnswer = new ProcessResultDto(0, 'null\t\n', '');
        const result = await publish();
        expect(result.predictedNumber).toBe('');
        expect(output.stderr).toContain("unexpected answer 'null'");
    });

    it('an empty repo (no issue, PR or discussion yet) predicts #1', async () => {
        world('');
        predictAnswer = new ProcessResultDto(0, '0\thttps://github.com/o/r\n', '');
        expect((await publish()).predictedNumber).toBe('1');
        expect(bodyAtCreate).toContain('https://github.com/o/r/pull/1\n');
    });

    it('the UPDATE path never predicts — the URL is already known', async () => {
        world('42');
        const result = await publish(NEW_HEAD_SHA, undefined, 'https://github.com/o/r/pull/42');
        expect(order).not.toContain('predict');
        expect(result.predictedNumber).toBe('');
        expect(result.body).toBe(renderBody(NEW_HEAD_SHA, 'https://github.com/o/r/pull/42'));
    });
});
