import type { BashContext } from '../types';
import { CommandScanner, CommandSegment } from '../command-scan';
import { ShellSegmentScan, SegmentVerdict } from './shell-segment-scan';
import { ContentReadScan } from './content-read-scan';

// ---------------------------------------------------------------------------
// THE SKIP LIST — L2 row 4, as one implementation.
//
// "These get you OUT, or tell you where you are." That is the whole principle: a command on this list
// is not "working here", so it is safe in every state where working here is not.
//
// It was written for state B (a merged branch) and lived inside merged-branch-bash-guard. Row 5 —
// on `main` — needs the identical question answered, and the answer must not be a second copy: two
// skip lists drift, and the half that drifts is the half that wedges a session on its own cure. So the
// list is ONE class, and both guards ask it.
//
// This is the DEFAULT-DENY half of L2. Its sibling ContentReadScan is the default-ALLOW blocklist used
// where only stale CONTENT is the hazard. The guards docblock is right that the two polarities cannot
// collapse into one function — but the allowlist itself was never the reason they could not, and
// sharing it is what makes row 5's `B` half affordable at all.
//
// EVERY segment must pass. One `… && scripts/local.sh start` in a chain denies the whole command,
// because the chain runs it. Segments are judged by ROLE first: shell STRUCTURE (`for … in`, `do`,
// `done`) invokes nothing and output SHAPING (`| tail -40`) cannot touch the repo, so neither may veto
// a chain — judging the raw string instead is what once made the guard reject
// `git fetch origin main 2>&1 | tail -5`, a command its own redirect had just prescribed.
// ---------------------------------------------------------------------------
export class RecoveryAllowlist {
    private readonly scanner: CommandScanner;
    private readonly shell: ShellSegmentScan;

    constructor(scanner: CommandScanner) {
        this.scanner = scanner;
        this.shell = new ShellSegmentScan(scanner);
    }

    /**
     * Is EVERY segment of this command one that gets you out, or tells you where you are?
     *
     * An empty command is `false` — nothing to be sure about, and the default here is deny. (Note this
     * is one of the three places the two Bash guards genuinely differ; the stale-main blocklist allows
     * the empty command because its default is the other way round.)
     */
    isFullyRecovery(ctx: BashContext): boolean {
        const segments = this.scanner.segmentsWithPipes(ctx.command);
        if (segments.length === 0) return false;
        const content = new ContentReadScan(this.scanner, ctx.workspaceRoot, ctx.effectiveCwd);
        return segments.every((segment: CommandSegment): boolean => this.isRecoverySegment(segment, content));
    }

    private isRecoverySegment(segment: CommandSegment, content: ContentReadScan): boolean {
        const verdict = this.shell.classify(segment);
        if (verdict.role === 'structure') return true;
        // Inert / piped-into filters are fine EXCEPT when they name a workspace path: `git status |
        // cat src/foo.ts` still hands the agent file content out of a tree it should not be reading.
        if (verdict.role === 'shaping') return content.readsStaleContent(segment) === null;

        // A read that names NOTHING in this tree cannot be affected by which branch this tree is on.
        // `ls -la ~/.claude/projects/ | grep -i foo` was blocked as "this branch is merged" — the
        // command touches no repo at all. Only CONTENT READERS qualify, so a build, a server or a git
        // write never slips through on the strength of its paths.
        if (content.readsOnlyOutsideContent(segment)) return true;

        // A segment that reads CONTENT out of this tree is never "getting you out", whatever command
        // it is spelled as. This must come BEFORE the git allowlist, because `show` and `grep` are on
        // that list for their metadata/upstream forms and would otherwise wave through the two git
        // spellings of a local content read: `git show HEAD:package.json` and `git grep TODO`. Their
        // upstream forms (`git show origin/main:…`, `git grep TODO origin/main`) read the CURRENT tree
        // and ContentReadScan already returns null for those, so they stay allowed — which is the
        // point, since reading upstream is exactly what a blocked agent should be doing.
        if (content.readsStaleContent(segment) !== null) return false;

        const gitSub = this.scanner.gitSubcommandOf(verdict.words);
        if (gitSub !== null) return ALLOWED_GIT_SUBCOMMANDS.has(gitSub);
        if (this.isGhInspection(verdict)) return true;
        return this.isPackageRecovery(verdict);
    }

    // Read-only / status `gh` invocations used for orientation, INCLUDING `gh run view|list|watch` —
    // watching CI is precisely what you do while parked. gh writes (pr create/merge, run
    // cancel/rerun, api POSTs) are governed by pr-creation-or-push-guard / pr-merge-guard and are NOT
    // allowlisted here.
    private isGhInspection(verdict: SegmentVerdict): boolean {
        const words = verdict.words;
        if (words.length === 0 || words[0] !== 'gh') return false;
        const top = words[1];
        if (top === undefined) return false;
        const action = words[2];
        const readActions = GH_READ_ACTIONS.get(top);
        if (readActions !== undefined) return action !== undefined && readActions.has(action);
        return GH_READ_TOPLEVEL.has(top);
    }

    // pnpm/npm/yarn recovery bins: the `wp-*` cleanup/gated commands and package installs (a chained
    // install that isInstallerCommand — the pure-install bypass — did not catch reaches here).
    private isPackageRecovery(verdict: SegmentVerdict): boolean {
        const words = verdict.words;
        if (words.length === 0 || !PACKAGE_MANAGERS.has(words[0])) return false;
        return words.slice(1).some((word: string): boolean =>
            /^wp-[a-z-]+$/.test(word) || PACKAGE_INSTALL_VERBS.has(word));
    }
}

const ALLOWED_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
    'status', 'log', 'diff', 'show', 'branch', 'checkout', 'switch', 'worktree', 'fetch', 'pull',
    'rev-parse', 'rev-list', 'merge-base', 'ls-files', 'ls-tree', 'cat-file', 'for-each-ref',
    'symbolic-ref', 'describe', 'name-rev', 'reflog', 'shortlog', 'remote', 'config', 'stash', 'tag',
    'blame', 'whatchanged', 'cherry',
    // `grep` is here ONLY for its upstream form (`git grep TODO origin/main`), which reads the CURRENT
    // tree and is what a blocked agent should be reaching for. The local form is rejected one check
    // earlier by ContentReadScan, as is `show <local-rev>:<path>`.
    'grep',
]);

// Read-only actions per `gh` topic. `run` is here because `gh run view <id>` was blocked outright in
// the field while `gh pr view` beside it succeeded — both are read-only, and CI watching is the normal
// thing to do while parked. The WRITE actions of the same topics (pr create/merge/close, run
// cancel/rerun/delete) are simply absent, so they still fall through to the block.
const GH_READ_ACTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
    ['pr', new Set(['list', 'view', 'status', 'checks', 'diff'])],
    ['run', new Set(['list', 'view', 'watch'])],
    ['issue', new Set(['list', 'view', 'status'])],
]);
// Read-only top-level `gh` commands.
const GH_READ_TOPLEVEL: ReadonlySet<string> = new Set(['status', 'auth', 'browse', 'repo', 'search']);

const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(['pnpm', 'npm', 'npx', 'pnpx', 'yarn']);
const PACKAGE_INSTALL_VERBS: ReadonlySet<string> = new Set(['install', 'ci', 'add', 'i']);
