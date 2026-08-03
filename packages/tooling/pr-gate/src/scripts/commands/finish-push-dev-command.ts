import { RepoRootFinder, writeTemplate } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

import { PushDevStateStore } from '../workflow/push-dev-state';
import { DevResolveRunner } from '../workflow/dev-resolve-runner';

/** What `wp-finish-push-dev` was asked to do. Data-only (per CLAUDE.md). */
export class FinishPushDevOptions {
    /** Throw the whole resolve away and restore the original checkout. */
    abort = false;

    constructor(abort = false) {
        this.abort = abort;
    }
}

/**
 * `wp-finish-push-dev` — stage ② of the dev-deploy flow, needed ONLY when a merge stopped.
 *
 * It mirrors `wp-start-update` → `wp-finish-update` on purpose: the repo already has a two-phase
 * start/finish idiom for exactly this shape ("the tool merges, you resolve, the tool commits"), and a
 * `--continue` idiom invented here would be a second vocabulary for one concept. A clean `wp-push-dev
 * --resolve` finalizes itself and this command is never needed.
 *
 * The command owns the commit because the AI cannot make it: `redirect-how-to-merge-main` blocks
 * `git merge --continue` and `merge-in-progress-guard` blocks `git commit`. Editing the conflicted files
 * and `git add`-ing them is the AI's whole job, and neither is blocked.
 */
@injectable(bindingScopeValues.Singleton)
export class FinishPushDevCommand {
    constructor(
        private readonly repoRootFinder: RepoRootFinder,
        private readonly store: PushDevStateStore,
        private readonly runner: DevResolveRunner,
    ) {}

    async run(opts: FinishPushDevOptions): Promise<void> {
        const repoRoot = this.repoRootFinder.resolveRepoRoot(process.cwd());
        writeTemplate(repoRoot, 'webpieces.git-workflow.md');
        // Refuses with the one-command publish form when nothing is in flight, so a mistaken call here
        // does not read as "the flow is broken".
        const state = this.store.require(repoRoot);

        if (opts.abort) {
            this.runner.abort(repoRoot, state);
            return Promise.resolve();
        }
        // Refuses (and re-prints the unresolved files) before committing anything, then resumes the
        // queue — a LATER ref can conflict too, so this may legitimately stop again.
        this.runner.resume(repoRoot, state);
        return Promise.resolve();
    }
}
