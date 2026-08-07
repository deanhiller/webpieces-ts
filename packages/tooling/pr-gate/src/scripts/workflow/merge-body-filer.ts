import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    DotWebpieces, MERGE_BODY_FILE, PrBodyOrigin, PrBodyStore, WEBPIECES_STATE_HOME_ENV, dotWebpieces,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

/** Everything needed to file one gated squash body. Data-only, per CLAUDE.md. */
export class MergeBodyRequest {
    treeRoot = '';
    branch = '';
    feature = '';
    prNumber = '';
    prUrl = '';
    body = '';
}

/**
 * Files the gated squash-commit body where LANDING can find it, and returns the path to hand `gh`.
 *
 * MACHINE-GLOBAL, keyed by the PR's own identity —
 * `~/.webpieces/prs/<host>/<owner>/<repo>/<n>/merge-commit-body.md`. It used to be written into the
 * rendering worktree's `pr-review/<branch>/`, which made landing work only while the branch never moved
 * trees: the gated flow ran in the primary clone, landing happened from a linked worktree, and
 * `wp-land-pr` found nothing and said "Nothing to land" at a perfectly good PR. See PrBodyStore for why
 * the PR's identity — not the tree, not the branch — is the right key.
 *
 * There is deliberately NO second write to the old in-repo path. Per CLAUDE.md this is a hard cut: two
 * homes for the receipt is two answers to "which bytes land", and the stale one wins in exactly the
 * situation that broke. `wp-land-pr` prints a LOUD one-time signpost if it finds a body left by an older
 * release, and never reads it.
 *
 * Separate from FinishUpsertPrCommand because it is the WRITE half of a two-command contract whose read
 * half lives in LandPrCommand — the pair is the thing that has to stay true, and a private method inside
 * a 600-line command is not something the read half's spec can hold still next to.
 */
@injectable(bindingScopeValues.Singleton)
export class MergeBodyFiler {
    constructor(
        private readonly prBodies: PrBodyStore,
        private readonly dotDir: DotWebpieces = dotWebpieces,
    ) {}

    /**
     * @returns the file to pass as `gh pr merge --body-file`. Never ''.
     *
     * The temp file is the ONE case the store cannot serve: `gh pr view` gave no number back (or the
     * remote could not be parsed), so there is no key to file under. This process still holds the bytes
     * and can merge with them right now; a later `wp-land-pr` correctly reports the PR as not found on
     * this machine, because no durable receipt was ever filed. Saying so beats pretending otherwise.
     */
    file(request: MergeBodyRequest): string {
        const origin = new PrBodyOrigin();
        origin.treeRoot = request.treeRoot;
        origin.primaryRoot = this.dotDir.primaryRoot(request.treeRoot);
        origin.branch = request.branch;
        origin.feature = request.feature;
        origin.prNumber = request.prNumber;
        origin.prUrl = request.prUrl;
        origin.writtenAt = new Date().toISOString();

        const stored = this.prBodies.write(request.treeRoot, request.prNumber, request.body, origin);
        if (stored !== null) {
            process.stdout.write(`   merge body → ${stored.bodyFile}\n`);
            this.warnIfDegraded(request.treeRoot);
            return stored.bodyFile;
        }

        const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-merge-body-')), MERGE_BODY_FILE);
        fs.writeFileSync(tmp, request.body);
        process.stderr.write(
            '   ⚠️  could not file the merge body under this PR\'s identity (no PR number read back, or the\n' +
            '       git remote could not be parsed). It was written to a temp file for THIS run only, so\n' +
            '       `pnpm wp-land-pr` will report the PR as not found on this machine.\n');
        return tmp;
    }

    // A degraded home is a receipt written INSIDE the clone — which is the thing that was broken. It
    // still works from here, so it is a warning, not a failure; it is never silent.
    private warnIfDegraded(treeRoot: string): void {
        const home = this.prBodies.home(treeRoot);
        if (!home.degraded) return;
        process.stderr.write(
            `   ⚠️  that path is INSIDE this clone (${home.reason}), so \`pnpm wp-land-pr\` will only find\n` +
            `       it from this clone. Set ${WEBPIECES_STATE_HOME_ENV} to a writable directory.\n`);
    }
}
