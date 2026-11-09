import { CliExitError } from '@webpieces/rules-config';
import { NativeProcessApi } from '@webpieces/tooling-common';
import * as fs from 'fs';
import { injectable, bindingScopeValues } from 'inversify';
import { GitExec } from './git-exec';
import { PredictedPr, PrNumberPredictor } from './pr-number-predictor';

/**
 * The description a caller hands the publisher. `body` is ALREADY written to `bodyFile`, rendered with
 * whatever URL was known before publishing ('' for a brand-new PR); `render` renders the same
 * description for a given self-link URL, so the create path can re-render it with the PREDICTED URL just
 * before `gh pr create` (issue #1418). Data-only.
 */
export class PrBodyDraft {
    bodyFile: string;
    body: string;
    render: (prUrl: string) => string;

    constructor(bodyFile: string, body: string, render: (prUrl: string) => string) {
        this.bodyFile = bodyFile;
        this.body = body;
        this.render = render;
    }
}

// Which PR the gated body landed on. Data-only.
export class PublishedPr {
    // The PR that already existed and was edited; '' when this run had to create one.
    number: string;
    // True only on the create path, when `gh pr create` itself failed — there is no PR to merge.
    createFailed: boolean;
    /**
     * The description exactly as it went up (without the file's trailing newline). A caller compares its
     * final render — with the REAL URL — against this, and back-fills only when they differ.
     */
    body: string;
    // The number the create path predicted ('' on the update path, or when the prediction failed).
    predictedNumber: string;

    constructor(number: string, createFailed: boolean, body: string, predictedNumber: string) {
        this.number = number;
        this.createFailed = createFailed;
        this.body = body;
        this.predictedNumber = predictedNumber;
    }
}

/**
 * Owns the ONE ordering constraint that lets the webpieces gate be a single required check: the PR body
 * — which carries `HMAC(gateSalt, HEAD_sha)` — is written BEFORE the push.
 *
 * WHY the order matters. Pushing first fires `pull_request:synchronize`, and CI (`wp-check-pr`) reads the
 * PR body it finds at that instant. If the body edit has not landed yet, that read sees the PREVIOUS
 * run's token, which is bound to the parent sha, and the check goes red on a timing coin-flip. #485
 * papered over this by also posting a `webpieces/pr-gate` commit status, whose newest post supersedes an
 * older one — recovery rather than prevention, and it left consumers with two entries on every PR and no
 * way to tell which one to mark required.
 *
 * The sha is already known locally: nothing about minting `HMAC(gateSalt, git rev-parse HEAD)` needs the
 * remote to have the commit. So write the body first and the `synchronize` read can only ever see the
 * right token. A brand-new PR is unaffected either way — `gh pr create` composes the body after the push,
 * so the `opened` event already sees the final body.
 *
 * A brand-new PR's description also wants its OWN link, which does not exist until GitHub assigns a
 * number. Right before `gh pr create` (after the push, to keep the race window small) the publisher
 * PREDICTS that number and renders the body with the predicted URL (issue #1418), so a correct guess
 * creates the PR with its final description and fires one `opened` event instead of `opened` + `edited`.
 *
 * THIS IS THE ONLY PUSH IN THE PR FLOW. `wp-start-upsert-pr` used to push twice (its own `ensurePushed`,
 * and the force-push inside the 3-point merge finalize), which put code on the remote before summary.json
 * and the checklists had even run, and fired `synchronize` against a PR body still carrying the previous
 * run's token. Both are gone — the merge finalize now takes `MergeEndOptions.pushRemote=false` in the PR
 * flow. So the single `synchronize` of a cycle arrives strictly after the body edit below, and can only
 * ever read the correct token.
 *
 * `@injectable(bindingScopeValues.Singleton)` so it is drawn in the DI design and injected by type.
 */
@injectable(bindingScopeValues.Singleton)
export class GatedPrPublisher {
    constructor(
        private readonly gitExec: GitExec,
        private readonly processes: NativeProcessApi,
        private readonly predictor: PrNumberPredictor,
    ) {}

    /**
     * Land the draft's body on the PR for `baseBranch` and push, in the gate-safe order.
     *
     * @param draft the rendered dashboard ALREADY carrying the gate token for the LOCAL head sha
     */
    async publish(
        baseBranch: string,
        title: string,
        draft: PrBodyDraft,
        retryCommand = 'pnpm wp-finish-upsert-pr',
    ): Promise<PublishedPr> {
        const bodyFile = draft.bodyFile;
        const existing = await this.findOpenPr(baseBranch);

        // 1. Body FIRST, so a `synchronize` read arriving the instant after the push finds the right token.
        if (existing !== '') {
            process.stdout.write(
                `Updating PR #${existing} (body before push, so CI cannot read a stale token)...\n`,
            );
            await this.editPrOrAbort(existing, title, bodyFile, retryCommand);
            // Say the consequence BEFORE the push can fail: from here the PR advertises a token for the
            // local HEAD, so a failed push leaves the PR pointing at the old commit and the gate check goes
            // RED. That is the deliberate fail-CLOSED direction, and it self-corrects on the next good run.
            process.stdout.write(
                '   body updated. Pushing now — if this push FAILS, the PR advertises a token for a commit\n' +
                    '   the remote does not have, so the webpieces gate check goes RED (never falsely green)\n' +
                    `   until you fix the push and re-run ${retryCommand}.\n`,
            );
        }

        // 2. THEN push. Nothing was pushed above, so an edit failure left the remote wholly untouched.
        await this.push(baseBranch);

        // 3. Only a brand-new PR is created, and only after the push — `gh pr create` needs the remote ref.
        if (existing !== '') return new PublishedPr(existing, false, draft.body, '');

        // 4. Predict the new PR's number and render its self-link into the body BEFORE creating it, so a
        //    correct guess needs no follow-up `gh pr edit` (one `opened` event, no cancelled CI run).
        const predicted = await this.predictor.predict();
        const body = this.bodyFor(draft, predicted);
        process.stdout.write(predicted.number === '' ? 'Creating PR...\n' : `Creating PR (predicted #${predicted.number})...\n`);
        return new PublishedPr('', !(await this.createPr(baseBranch, title, bodyFile)), body, predicted.number);
    }

    /**
     * Say how the create path's predicted self-link turned out, given the number GitHub REALLY assigned.
     * Silent on the update path and when there was no prediction (the predictor already warned). A miss
     * costs exactly what every create cost before #1418: the caller back-fills the real link.
     */
    reportPredictedLink(published: PublishedPr, realNumber: string): void {
        if (published.predictedNumber === '' || realNumber === '') return;
        if (published.predictedNumber === realNumber) {
            process.stdout.write(`   PR link predicted #${realNumber} ✓\n`);
            return;
        }
        process.stdout.write(`   PR link predicted #${published.predictedNumber}, got #${realNumber}: back-filling the real link\n`);
    }

    // The body to create the PR with: re-rendered with the predicted URL when there is one, else the
    // draft as the caller wrote it. Rewrites `bodyFile` only when the bytes change.
    private bodyFor(draft: PrBodyDraft, predicted: PredictedPr): string {
        if (predicted.url === '') return draft.body;
        const body = draft.render(predicted.url);
        if (body !== draft.body) fs.writeFileSync(draft.bodyFile, body + '\n');
        return body;
    }

    // Edit the PR body/title, aborting BEFORE the push if `gh` failed. Warning-and-continuing here would
    // push code that the PR body does not vouch for; aborting leaves the PR on its previous body, whose
    // token is still valid for the sha the remote still has. Nothing is half-done either way.
    private async editPrOrAbort(
        prNumber: string,
        title: string,
        bodyFile: string,
        retryCommand: string,
    ): Promise<void> {
        if (await this.editPr(prNumber, title, bodyFile)) return;
        throw new CliExitError(
            1,
            `❌ gh pr edit failed on PR #${prNumber} — NOTHING was pushed, so the PR and the remote branch are\n` +
                `   both unchanged and still consistent. Fix gh (auth / network / permissions) and re-run\n` +
                `   ${retryCommand}. The new body is in:\n     ${bodyFile}`,
        );
    }

    // The open PR whose head is `baseBranch`, or '' when there is none (or `gh` failed — treated the same,
    // so the create path then fails loudly rather than silently editing the wrong PR).
    private async findOpenPr(baseBranch: string): Promise<string> {
        const result = await this.processes.run(
            'gh',
            ['pr', 'list', '--head', baseBranch, '--json', 'number', '--jq', '.[0].number'],
        );
        return result.ok ? result.stdout.trim() : '';
    }

    private async editPr(prNumber: string, title: string, bodyFile: string): Promise<boolean> {
        const result = await this.processes.passThrough(
            'gh', ['pr', 'edit', prNumber, '--title', title, '--body-file', bodyFile],
        );
        return result.ok;
    }

    private async createPr(baseBranch: string, title: string, bodyFile: string): Promise<boolean> {
        return (
            await this.processes.passThrough(
                'gh',
                [
                    'pr',
                    'create',
                    '--head',
                    baseBranch,
                    '--base',
                    'main',
                    '--title',
                    title,
                    '--body-file',
                    bodyFile,
                ],
            )
        ).ok;
    }

    // Throws (CliExitError, via runGitChecked) when the push fails — deliberately NOT caught here: the
    // consequence is already printed above, and swallowing it would report a PR that was never updated.
    protected push(baseBranch: string): Promise<void> {
        return this.gitExec.ensurePushed(baseBranch);
    }
}
