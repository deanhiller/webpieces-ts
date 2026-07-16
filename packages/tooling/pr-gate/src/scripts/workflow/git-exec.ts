import { spawnSync } from 'child_process';
import { CliExitError, RepoRootFinder } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
// The AI-facing doc the failure messages point at (generated under `.webpieces/instruct-ai`, at the
// REPO ROOT — resolved absolute so the AI opens it regardless of the cwd it reads the message from).
const GIT_WORKFLOW_DOC_NAME = 'webpieces.git-workflow.md';

/** Shared git precondition checks + push logic for the PR/merge workflow. */
@injectable(bindingScopeValues.Singleton)
export class GitExec {
    constructor(private readonly repoRootFinder: RepoRootFinder) {}

    // Tracked changes (staged + unstaged) AND untracked files, EXCLUDING gitignored paths — so
    // `.webpieces/` tooling artifacts never count. Empty string = fully committed.
    uncommittedFiles(cwd: string): string {
        return this.gitQuery(['status', '--porcelain'], cwd, 'Failed to run `git status --porcelain` to check the working tree.');
    }

    // Untracked files only (respects .gitignore). Empty string = none.
    untrackedFiles(cwd: string): string {
        return this.gitQuery(['ls-files', '--others', '--exclude-standard'], cwd, 'Failed to list untracked files (git ls-files --others).');
    }

    /**
     * Precondition for every PR/merge entry point: the working tree must be fully committed. The
     * webpieces tooling deliberately does NOT `git add`/`commit` the developer's work for them. Aborts
     * with instructions if anything is uncommitted (tracked or untracked, excluding gitignored).
     */
    assertCleanTree(cwd: string): void {
        const dirty = this.uncommittedFiles(cwd);
        if (dirty === '') return;
        throw new CliExitError(1,
            '\n' + SEP +
            '❌ ERROR: You have uncommitted or untracked changes\n' +
            SEP + '\n' +
            'The webpieces PR tooling will NOT commit your work for you. Commit your\n' +
            'changes, and either commit or delete any untracked files, then re-run.\n\n' +
            'Working tree (git status --porcelain):\n' +
            dirty + '\n\n' +
            `See ${this.repoRootFinder.docPathFrom(cwd, GIT_WORKFLOW_DOC_NAME)} for the full merge + PR process.\n` +
            SEP,
        );
    }

    /**
     * Narrower guard for the merge-resolve commit point, where tracked resolutions are legitimately in
     * the tree but untracked files must NOT be swept into the squash commit. Lists any untracked files
     * and aborts so the AI commits or deletes them explicitly.
     */
    assertNoUntracked(cwd: string): void {
        const untracked = this.untrackedFiles(cwd);
        if (untracked === '') return;
        throw new CliExitError(1,
            '\n' + SEP +
            '❌ ERROR: Untracked files present during merge finalize\n' +
            SEP + '\n' +
            'The tooling will not sweep untracked files into the squash commit. Commit\n' +
            'or delete these, then re-run:\n\n' +
            untracked + '\n\n' +
            `See ${this.repoRootFinder.docPathFrom(cwd, GIT_WORKFLOW_DOC_NAME)} for the full merge + PR process.\n` +
            SEP,
        );
    }

    /**
     * Run a git command that is expected to succeed; abort the process with a clear message if it
     * fails. Used for fetch/pull/checkout/commit where silently continuing on failure would operate on
     * stale or wrong state.
     */
    runGitChecked(args: string[], errMsg: string): void {
        const result = spawnSync('git', args, { stdio: 'inherit' });
        if (result.status !== 0) {
            throw new CliExitError(1, `❌ ${errMsg} (git ${args.join(' ')} exited ${String(result.status)})`);
        }
    }

    /**
     * Push HEAD to origin/<currentBranch>. Uses --force-with-lease for an existing remote branch (the
     * 3-point squash rewrites history) and -u for a brand-new branch.
     */
    ensurePushed(currentBranch: string): void {
        const remoteExists = spawnSync('git', ['ls-remote', '--exit-code', '--heads', 'origin', currentBranch]).status === 0;
        if (remoteExists) {
            this.runGitChecked(['push', '--force-with-lease', 'origin', `HEAD:${currentBranch}`], 'Failed to push branch');
        } else {
            this.runGitChecked(['push', '-u', 'origin', `HEAD:${currentBranch}`], 'Failed to push new branch');
        }
    }

    // Run a read-only git query from the repo root; abort if git itself errors. Kept `cwd`-explicit
    // because `git ls-files --others` is scoped to the cwd subtree.
    private gitQuery(args: string[], cwd: string, failMsg: string): string {
        const out = spawnSync('git', args, { encoding: 'utf8', cwd });
        if (out.status !== 0) {
            throw new CliExitError(1, `❌ ${failMsg}`);
        }
        return out.stdout.trim();
    }
}
