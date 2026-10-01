import { CliExitError } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { GatedPrPublisher } from './gated-pr-publisher';
import { GitExec } from './git-exec';

/**
 * The gated publisher for a `/hotfix/` branch: the same body-before-push ordering, with a push that can
 * NEVER rewrite the remote branch.
 *
 * The normal flow pushes with `--force-with-lease`, because its 3-point squash rewrites history on every
 * update. A hotfix branch is never rewritten — it only ever grows by the fix commits added on top of the
 * production sha — so its push is a plain fast-forward. If the remote branch has diverged (somebody else
 * pushed to it), the push FAILS instead of overwriting their commits, and nothing is lost.
 *
 * The push runs as a CHILD PROCESS of `wp-upsert-hotfix-pr`, which the PreToolUse hook never sees, so
 * `pr-creation-or-push-guard` keeps refusing every hand-typed `git push` exactly as before.
 */
@injectable(bindingScopeValues.Singleton)
export class HotfixPrPublisher extends GatedPrPublisher {
    constructor(private readonly hotfixGit: GitExec) {
        super(hotfixGit);
    }

    /** Fast-forward-only push of HEAD to origin/<branch>, run in `cwd`. Throws on any failure. */
    pushFastForward(cwd: string, branch: string): void {
        const out = this.hotfixGit.tryGit(['push', '-u', 'origin', `HEAD:${branch}`], cwd);
        if (out.ok) return;
        throw new CliExitError(
            1,
            `❌ git push of the hotfix branch '${branch}' failed (exit ${String(out.status)}). A hotfix push is\n` +
                '   fast-forward only — it never forces — so a remote branch that has diverged is refused rather\n' +
                '   than overwritten.\n' +
                `   git said: ${out.stderr === '' ? '(nothing)' : out.stderr}`,
        );
    }

    protected override push(baseBranch: string): void {
        this.pushFastForward(process.cwd(), baseBranch);
    }
}
