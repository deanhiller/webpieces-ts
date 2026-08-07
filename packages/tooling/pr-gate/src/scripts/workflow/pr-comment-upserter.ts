import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { injectable, bindingScopeValues } from 'inversify';

/** One marker-keyed PR comment to upsert. Data-only, per CLAUDE.md. */
export class PrCommentRequest {
    /** The PR number. '' means "no PR resolved" and the upsert is a silent no-op. */
    prNumber = '';
    /** Hidden HTML-comment marker that identifies THIS tool's comment among all comments on the PR. */
    marker = '';
    /** The full comment body, marker included. */
    body = '';
    /** Directory to stage the JSON payload in — `gh api --input` needs a file. */
    payloadDir = '';
    /** Payload filename, unique per comment kind so two upserts in one run cannot clobber each other. */
    payloadName = '';
    /** Human words for the progress/warning lines, e.g. 'checklist review comment'. */
    label = '';
}

/** What an upsert did, so the caller can report it without re-deriving anything. */
export class PrCommentResult {
    /** '' when nothing was posted (no PR number, or `gh` failed). */
    commentId: string;
    /** True when an existing comment was PATCHed rather than a new one POSTed. */
    updated: boolean;
    ok: boolean;

    constructor(commentId: string, updated: boolean, ok: boolean) {
        this.commentId = commentId;
        this.updated = updated;
        this.ok = ok;
    }
}

/**
 * Upserts a hidden-marker-keyed comment on a PR: find ours, PATCH it if it exists, POST it if not.
 *
 * ONE implementation for BOTH of the gated flow's comments — the full dashboard (1st) and the reviewer
 * checklist (2nd). It exists because the PR description became the git-log body: everything long-form or
 * machine-facing moved into comments, so what had been one inline block of gh plumbing inside
 * FinishUpsertPrCommand became something two callers needed. Per the repo's consolidate-don't-duplicate
 * rule that is one parameterized class, not a copied private method.
 *
 * Idempotency is the whole contract. `wp-finish-upsert-pr` re-runs on every push, and a PR that
 * accumulated a new dashboard comment per push would be unreadable — worse, `wp-check-pr` would have
 * several gate tokens to choose between, and picking the wrong one is a red check on good code.
 *
 * NEVER FATAL by itself. Every caller reaches this after the PR is already up, so a `gh` hiccup warns and
 * returns `ok: false`; it is the CALLER's job to decide whether that matters. It matters for the
 * dashboard comment (it carries the token) and does not for the checklist comment, and those two
 * judgements do not belong in here.
 */
@injectable(bindingScopeValues.Singleton)
export class PrCommentUpserter {
    upsert(request: PrCommentRequest): PrCommentResult {
        if (request.prNumber === '') return new PrCommentResult('', false, false);

        fs.mkdirSync(request.payloadDir, { recursive: true });
        const payload = path.join(request.payloadDir, request.payloadName);
        fs.writeFileSync(payload, JSON.stringify({ body: request.body }));

        const existing = this.findCommentId(request.prNumber, request.marker);
        const args = existing !== ''
            ? ['api', '--method', 'PATCH', `repos/{owner}/{repo}/issues/comments/${existing}`, '--input', payload]
            : ['api', '--method', 'POST', `repos/{owner}/{repo}/issues/${request.prNumber}/comments`, '--input', payload];
        if (this.gh(args) !== 0) {
            process.stderr.write(`⚠️  Could not post the ${request.label} (non-fatal here — see the caller).\n`);
            return new PrCommentResult(existing, existing !== '', false);
        }
        process.stdout.write(`   ${existing !== '' ? 'updated' : 'posted'} the ${request.label} ✓\n`);
        return new PrCommentResult(existing, existing !== '', true);
    }

    /**
     * The id of THIS tool's comment on the PR, found by hidden marker, or '' when absent.
     *
     * Takes the FIRST match. A PR should never have two, but if an older release ever left a duplicate,
     * consistently patching the earliest keeps the comment in a stable position in the thread — which is
     * what the PR body's "1st comment / 2nd comment" pointer relies on.
     */
    protected findCommentId(prNumber: string, marker: string): string {
        const res = spawnSync('gh', [
            'api', '--paginate', `repos/{owner}/{repo}/issues/${prNumber}/comments`,
            '--jq', `.[] | select(.body | contains("${marker}")) | .id`,
        ], { encoding: 'utf8' });
        if (res.status !== 0) return '';
        return (res.stdout ?? '').trim().split('\n')[0] ?? '';
    }

    // The gh seam, protected so specs can drive the upsert with no gh, no network and no PR.
    protected gh(args: string[]): number {
        return spawnSync('gh', args, { encoding: 'utf8' }).status ?? -1;
    }
}
