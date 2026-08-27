import * as path from 'path';

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
// WHAT BELONGS ON THIS LIST — one question, asked of the COMMAND, not of your sympathy for it:
// **does it read or write repo content?** If it cannot do either, it cannot be "working here", so it
// belongs here regardless of what else it does. That is why `curl`/`wget` and `gh` are on it: they talk
// to a network, not to the working tree, and a session parked in an L2 state still has to be able to
// close a PR, comment on one, or fetch a URL. It is also why the exclusions are the FORMS that write a
// local file (`curl -o`, `gh repo clone`, `gh pr checkout`, any `> file` redirect) rather than whole
// programs: the write is the hazard, not the binary.
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
        const segments = this.scanner.segmentsWithJoins(ctx.command);
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
        if (this.isGh(verdict)) return true;
        if (this.isNetworkClient(verdict)) return true;
        return this.isPackageRecovery(verdict);
    }

    /**
     * `gh` GENERALLY — it talks to GitHub, not to the working tree.
     *
     * This used to be an allowlist of read-only actions (`gh pr view|list|status|checks`, `gh run
     * view`), which fell over the moment an agent needed `gh pr close`, `gh pr comment` or `gh api`
     * from a parked session: those change something on GitHub and NOTHING in this tree, so the branch
     * state cannot be an argument against them. The exclusions are therefore the `gh` subcommands that
     * write LOCAL files — a clone, a checkout, a download — plus any segment carrying a `> file`
     * redirect.
     *
     * gh commands that are wrong for OTHER reasons stay wrong: `gh pr create`/`push` is governed by
     * pr-creation-or-push-guard and `gh pr merge` by pr-merge-guard. Those are separate policies and
     * this list was never what enforced them.
     *
     * YES, THIS ONE SUBLIST IS A BLOCKLIST, and that is the opposite polarity to the guard around it.
     * The argument against a blocklist elsewhere is that the hazardous set is UNBOUNDED — any program
     * can write a file as a side effect of doing something else, so no enumeration could ever be
     * complete. `gh`'s surface is not: it is one vendor's CLI, its verbs are documented, and writing
     * into the working tree is the rare exception rather than the ambient default. A new `gh`
     * subcommand that clones or downloads is a known, greppable maintenance point — `GH_LOCAL_FILE_WRITES`
     * — where "every future program that might write" is not.
     */
    private isGh(verdict: SegmentVerdict): boolean {
        const words = verdict.words;
        if (words.length === 0 || path.basename(words[0]) !== 'gh') return false;
        if (this.shell.redirectsToFile(words)) return false;
        const top = words[1];
        if (top === undefined) return false;
        const action = words[2];
        const localWrites = GH_LOCAL_FILE_WRITES.get(top);
        if (localWrites === undefined) return true;
        return action === undefined || !localWrites.has(action);
    }

    /**
     * `curl` / `wget` — a network fetch reads a URL, not this repo.
     *
     * Excluded: the forms that name a local FILE to write (`curl -o`, `curl -O`, `wget -O`, an
     * `--output-dir`/`-P`, or a `> file` redirect), because those are how a fetch becomes a write into
     * the tree. A bare `wget <url>` still drops its download into the cwd; that CREATES an untracked
     * file rather than modifying tracked content, which is the line this list draws everywhere else.
     */
    private isNetworkClient(verdict: SegmentVerdict): boolean {
        const words = verdict.words;
        if (words.length === 0 || !NETWORK_CLIENTS.has(path.basename(words[0]))) return false;
        if (this.shell.redirectsToFile(words)) return false;
        return !words.some((word: string): boolean => OUTPUT_FILE_FLAGS.has(word));
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

// The `gh` subcommands that write LOCAL files — the only ones the branch state has anything to say
// about. Everything else `gh` does happens on GitHub's side. (`gh pr create` / `gh pr merge` are absent
// on purpose: they are remote calls, and their policies live in pr-creation-or-push-guard and
// pr-merge-guard, which run whatever this list says.)
const GH_LOCAL_FILE_WRITES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
    ['repo', new Set(['clone', 'fork', 'sync'])],
    ['pr', new Set(['checkout'])],
    ['run', new Set(['download'])],
    ['release', new Set(['download'])],
    ['gist', new Set(['clone'])],
    ['codespace', new Set(['cp'])],
    ['attestation', new Set(['download'])],
]);

// Network clients: they read a URL, not the tree.
const NETWORK_CLIENTS: ReadonlySet<string> = new Set(['curl', 'wget']);
// The flags that turn a fetch into a local file write. `-O` is curl's remote-name AND wget's
// output-document; both write, so one entry covers both.
const OUTPUT_FILE_FLAGS: ReadonlySet<string> = new Set([
    '-o', '--output', '-O', '--remote-name', '--remote-name-all', '--output-dir', '--create-dirs',
    '--output-document', '-P', '--directory-prefix',
]);

const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(['pnpm', 'npm', 'npx', 'pnpx', 'yarn']);
const PACKAGE_INSTALL_VERBS: ReadonlySet<string> = new Set(['install', 'ci', 'add', 'i']);
