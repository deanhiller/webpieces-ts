import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { GateTokenService } from '@webpieces/rules-config';
import { specTempDirs } from '@webpieces/tooling-testkit';
import { CapturedOutput, PrGateFeature } from '../../__tests__/feature-harness';
import { GatedPrPublisher, PublishedPr } from './gated-pr-publisher';

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

// The body wp-finish-upsert-pr hands the publisher: the dashboard plus the token for the LOCAL head sha.
function gatedBodyFile(headSha: string): string {
    const file = path.join(dir, 'pr-body.md');
    fs.writeFileSync(file, `# dashboard\n\n${new GateTokenService().gateTokenMarker(SALT, headSha)}\n`);
    return file;
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
    feature.processes.respondToPrefix('gh', ['pr', 'create'], (): ReturnType<typeof feature.processes.ok> => {
        order.push('createPr');
        return createOk ? feature.processes.ok() : feature.processes.fail(1, 'HTTP 422');
    });
    feature.git.respond(['ls-remote', '--exit-code', '--heads', 'origin', BRANCH],
        existingPr === '' ? feature.git.fail(2) : feature.git.ok());
    feature.git.respondToPrefix(['push'], (): ReturnType<typeof feature.git.ok> => {
        order.push('push');
        return pushOk ? feature.git.ok() : feature.git.fail(1, 'rejected');
    });
}

function publish(headSha: string = NEW_HEAD_SHA, retry?: string): Promise<PublishedPr> {
    return feature.container.get(GatedPrPublisher).publish(BRANCH, 'My PR title', gatedBodyFile(headSha), retry);
}

beforeEach(async (): Promise<void> => {
    feature = await PrGateFeature.create();
    output = CapturedOutput.start();
    dir = specTempDirs.make('wp-gated-publisher-');
    order = [];
    bodyAtEdit = '';
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

        expect(order).toEqual(['findOpenPr', 'push', 'createPr']);
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
