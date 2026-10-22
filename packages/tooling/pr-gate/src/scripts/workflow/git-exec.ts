import { CliExitError, RepoRootFinder } from '@webpieces/rules-config';
import { GitProcessApi } from '@webpieces/tooling-common';
import { injectable, bindingScopeValues } from 'inversify';
import { GitStatusEntry, GitStatusParser } from './git-status';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
// The AI-facing doc the failure messages point at (generated under `.webpieces/instruct-ai`, at the
// REPO ROOT — resolved absolute so the AI opens it regardless of the cwd it reads the message from).
const GIT_WORKFLOW_DOC_NAME = 'webpieces.git-workflow.md';

/**
 * The result of a git command that was allowed to fail. Data-only (per CLAUDE.md) so a caller asks
 * `outcome.ok` rather than re-deriving "did it work" from a status number at every site.
 */
export class GitOutcome {
    status: number;
    stdout: string;
    stderr: string;

    constructor(status: number, stdout: string, stderr: string) {
        this.status = status;
        this.stdout = stdout;
        this.stderr = stderr;
    }

    get ok(): boolean {
        return this.status === 0;
    }
}

/**
 * Shared git precondition checks + push logic for the PR/merge workflow. Every git it runs goes through
 * the injected {@link GitProcessApi} edge (#1381), so a feature test scripts git's answers instead of
 * building a repository.
 */
@injectable(bindingScopeValues.Singleton)
export class GitExec {
    constructor(
        private readonly repoRootFinder: RepoRootFinder,
        private readonly statusParser: GitStatusParser,
        private readonly git: GitProcessApi,
    ) {}

    /**
     * Raw `git status --porcelain` with ONLY the trailing newline(s) stripped — never `.trim()`.
     *
     * There used to be a trimmed sibling here (`uncommittedFiles`) and it was a data-destroying trap:
     * porcelain column 1 is the index state and column 2 the worktree state, so an unstaged
     * modification is " M path"; `trim()` eats that leading space and the line then reads "M path",
     * i.e. STAGED — the exact inverse of the truth. It is deleted. This method is for EMPTINESS
     * ("is the tree dirty at all?") and for PRINTING; anything that reasons about the two columns
     * calls {@link statusEntries} and reads booleans instead of re-parsing a string.
     *
     * Tracked changes (staged + unstaged) AND untracked files, EXCLUDING gitignored paths — so
     * `.webpieces/` tooling artifacts never count. Empty string = fully committed.
     */
    async porcelainStatus(cwd: string): Promise<string> {
        const raw = await this.rawGitQuery(['status', '--porcelain'], cwd,
            'Failed to run `git status --porcelain` to check the working tree.');
        return raw.replace(/\n+$/, '');
    }

    /**
     * The same status, PARSED: two status columns, an unquoted path, and explicit
     * `isStaged()`/`isUnstaged()`/`isUntracked()` answers. Use this for every semantic question.
     */
    async statusEntries(cwd: string): Promise<GitStatusEntry[]> {
        return this.statusParser.parse(await this.porcelainStatus(cwd));
    }

    // Untracked files only (respects .gitignore). Empty string = none.
    untrackedFiles(cwd: string): Promise<string> {
        return this.gitQuery(['ls-files', '--others', '--exclude-standard'], cwd, 'Failed to list untracked files (git ls-files --others).');
    }

    /**
     * Precondition for every PR/merge entry point: the working tree must be fully committed. The
     * webpieces tooling deliberately does NOT `git add`/`commit` the developer's work for them. Aborts
     * with instructions if anything is uncommitted (tracked or untracked, excluding gitignored).
     */
    async assertCleanTree(cwd: string): Promise<void> {
        const dirty = await this.porcelainStatus(cwd);
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
    async assertNoUntracked(cwd: string): Promise<void> {
        const untracked = await this.untrackedFiles(cwd);
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
     * stale or wrong state. Its output goes straight to the terminal.
     */
    async runGitChecked(args: string[], errMsg: string): Promise<void> {
        const result = await this.git.passThrough(args);
        if (!result.ok) {
            throw new CliExitError(1, `❌ ${errMsg} (git ${args.join(' ')} exited ${String(result.code)})`);
        }
    }

    /** Run git with its output on the terminal and return its exit code — for a caller that decides itself. */
    async passThrough(args: string[], cwd?: string): Promise<number> {
        return (await this.git.passThrough(args, cwd)).code;
    }

    /**
     * Push HEAD to origin/<currentBranch>. Uses --force-with-lease for an existing remote branch (the
     * 3-point squash rewrites history) and -u for a brand-new branch.
     */
    async ensurePushed(currentBranch: string): Promise<void> {
        const remoteExists = (await this.git.run(['ls-remote', '--exit-code', '--heads', 'origin', currentBranch])).ok;
        if (remoteExists) {
            await this.runGitChecked(['push', '--force-with-lease', 'origin', `HEAD:${currentBranch}`], 'Failed to push branch');
        } else {
            await this.runGitChecked(['push', '-u', 'origin', `HEAD:${currentBranch}`], 'Failed to push new branch');
        }
    }

    /**
     * Run a git command that MAY legitimately fail and report the outcome instead of aborting — for the
     * questions whose "no" is an answer rather than an error (does this remote ref exist? did this merge
     * conflict?). Distinct from {@link runGitChecked}, which exists for the commands where continuing on
     * failure would operate on wrong state.
     */
    async tryGit(args: string[], cwd: string): Promise<GitOutcome> {
        const out = await this.git.run(args, cwd);
        return new GitOutcome(out.code, out.stdout.trim(), out.stderr.trim());
    }

    /** `git branch --show-current` in `cwd` — '' on a detached HEAD. Must succeed. */
    currentBranch(cwd: string): Promise<string> {
        return this.gitQuery(['branch', '--show-current'], cwd, 'Failed to read the current branch (git branch --show-current).');
    }

    /** Read-only git query that MUST succeed, trimmed. Public sibling of the private raw form. */
    async gitQuery(args: string[], cwd: string, failMsg: string): Promise<string> {
        return (await this.rawGitQuery(args, cwd, failMsg)).trim();
    }

    // The untrimmed sibling — see porcelainStatus for why trimming is not always safe.
    private async rawGitQuery(args: string[], cwd: string, failMsg: string): Promise<string> {
        const out = await this.git.run(args, cwd);
        if (!out.ok) {
            throw new CliExitError(1, `❌ ${failMsg}`);
        }
        return out.stdout;
    }
}
