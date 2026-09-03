import { spawnSync } from 'child_process';
import { injectable, bindingScopeValues } from 'inversify';
import { CliExitError } from '@webpieces/rules-config';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

/**
 * The untracked files a branch switch is about to leave exactly where they are — carried out of the gate
 * so the caller can SAY so, rather than surprise anyone with files that appear to have followed them.
 */
export class UntrackedFiles {
    constructor(readonly paths: readonly string[]) {}

    isEmpty(): boolean {
        return this.paths.length === 0;
    }

    /** The human-facing block, or '' when there is nothing to say. */
    render(): string {
        if (this.isEmpty()) return '';
        const list = this.paths.map((path: string): string => `  ${path}\n`).join('');
        return 'These untracked files are not on any branch, so the checkout leaves them exactly where\n'
            + 'they are — nothing about them changed:\n'
            + list;
    }
}

/**
 * The clean-tree gate for `wp-sync-main`: refuse when TRACKED work would ride onto main, and
 * only then.
 *
 * ─── WHY UNTRACKED FILES ARE NOT A REASON TO REFUSE ───────────────────────────────────────────────────
 * The hazard the gate exists for is real but narrow: `git checkout` carries uncommitted changes to
 * TRACKED files across the switch, and main is the one place nobody wants to discover their work. An
 * untracked file has none of that. It is not on any branch, the switch does not move it, and no branch
 * can end up holding it — so refusing on one blocks a routine, safe operation.
 *
 * Worse, it was a refusal the user could not clear without deleting their file. The message prescribed
 * "commit them on this branch, or stash them", and a plain `git stash` does NOT take untracked files
 * (that needs `-u`) — so a user who did exactly what the error said got the identical refusal back. That
 * is the shape this repo treats as a defect in its own right: a cure that does not resolve the state it
 * is prescribed for. Reported from the field, where a generated `design.html` sitting untracked made the
 * command permanently unusable in that clone.
 *
 * Now the refusal only ever names tracked changes, so `git stash` — the cure it prints — always resolves
 * it, by construction.
 *
 * That is true about the FILES and not about the CHECKOUT: git itself aborts a switch when an untracked
 * file sits at a path the destination branch TRACKS. Letting untracked files through is what makes that
 * abort reachable, and `MainCheckout` is where it is handled — it reacts to git's own refusal by stashing
 * with `-u`, retrying, and shouting about it. This gate does not predict that case, deliberately: git's
 * rules for it are the authority, and re-deriving them here would drift from the git actually installed.
 *
 * ─── WHY `--untracked-files=no` AND `ls-files -z` RATHER THAN PARSING `??` ─────────────────────────────
 * The decision half asks git the tracked-only question directly, so no line of porcelain output is ever
 * parsed to make it. The reporting half asks `ls-files --others --exclude-standard -z`, which emits bare
 * NUL-separated paths — no `?? ` prefix to strip and, crucially, no quoting: porcelain v1 wraps paths
 * containing special characters in quotes with C-style escapes, so a hand-parser would hand back a
 * mangled name for exactly the paths a human most needs to read correctly.
 */
@injectable(bindingScopeValues.Singleton)
export class WorkingTreeGate {
    /**
     * Throw when tracked files are modified or staged; otherwise hand back the untracked files that were
     * deliberately allowed through, for the caller to mention.
     */
    assertNoTrackedChanges(repoRoot: string): UntrackedFiles {
        const tracked = this.git(repoRoot, ['status', '--porcelain', '--untracked-files=no']);
        if (tracked !== null && tracked.trim() !== '') {
            throw new CliExitError(1,
                `${SEP}❌ Uncommitted changes to tracked files\n${SEP}\n`
                + 'Going to main would carry them along. Commit them on this branch, or `git stash` them\n'
                + '(everything listed below is tracked, which is exactly what a plain stash takes), then\n'
                + 're-run. The webpieces tooling never commits your work for you.\n\n'
                + `${tracked}`);
        }
        return this.untrackedFiles(repoRoot);
    }

    private untrackedFiles(repoRoot: string): UntrackedFiles {
        const output = this.git(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']);
        if (output === null) return new UntrackedFiles([]);
        return new UntrackedFiles(output.split('\0').filter((path: string): boolean => path !== ''));
    }

    /** Captured git output, or null when git could not be run or exited non-zero. */
    private git(repoRoot: string, args: string[]): string | null {
        const result = spawnSync('git', ['-C', repoRoot, ...args], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        });
        if (result.error !== undefined || result.status !== 0) return null;
        return result.stdout;
    }
}
