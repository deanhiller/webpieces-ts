import * as path from 'path';

import { CommandScanner, CommandSegment } from '../command-scan';
import { ShellSegmentScan } from './shell-segment-scan';

/**
 * Decides the one question stale-main-bash-guard asks of a command: does this segment put stale
 * WORKSPACE FILE CONTENT into the agent's context?
 *
 * The distinction that matters is content vs metadata, not shell vs tool. `git log`, `git diff`,
 * `git status`, builds, tests and the cure itself are all fine on a stale main — none of them hands
 * you the text of a file that upstream has moved past. `cat src/x.ts` does, and so does
 * `grep -r foo services/`, `ls .github/workflows/` (the incident's actual wrong answer: a listing
 * missing a workflow that existed upstream) and `git show HEAD:file`.
 *
 * Three things keep this from over-blocking:
 *   1. A piped consumer reads stdin, not the tree — `git log | grep fix` is metadata, so it passes.
 *   2. A reader with no path operand that does not default to the cwd reads stdin — `cat` alone,
 *      `grep pattern` alone.
 *   3. Only paths INSIDE the workspace count. `cat /etc/hosts`, `cat ~/.zshrc`, `cat /tmp/out.log`
 *      are nothing to do with this repo's staleness.
 */
export class ContentReadScan {
    private readonly shell: ShellSegmentScan;
    private readonly baseDir: string;

    /**
     * `effectiveCwd` is the directory the command really runs in — after its own leading `cd`, which
     * is how an agent reaches a linked worktree, since the harness resets a cwd that left the workspace.
     * RELATIVE operands are resolved against it, not against workspaceRoot: `cd /tmp/scratch && cat
     * notes.md` reads `/tmp/scratch/notes.md`, which is nothing to do with this repo's staleness,
     * while `cd /tmp/scratch && cat /repo/src/x.ts` still names repo content and is still caught.
     * Defaults to workspaceRoot, which is exactly the old behaviour (relative = inside the repo).
     */
    constructor(
        private readonly scanner: CommandScanner,
        private readonly workspaceRoot: string,
        effectiveCwd?: string,
    ) {
        this.shell = new ShellSegmentScan(scanner);
        this.baseDir = effectiveCwd ?? workspaceRoot;
    }

    /**
     * True when this segment's ONLY job is reading content, and nothing it reads is in the workspace —
     * `ls -la ~/.claude/projects/`, `cat /tmp/out.log`, `grep -r x /other/repo`.
     *
     * merged-branch-bash-guard needs this: it default-denies bash on a merged branch, and denied an
     * `ls` of a directory outside every git repo on the grounds that the branch was merged. Nothing
     * about a read that never touches the tree is affected by which branch the tree is on. The
     * "content reader" restriction is what keeps this from becoming a general escape hatch: a build,
     * a server or a git write is not a content reader and never qualifies, however its paths look.
     */
    readsOnlyOutsideContent(segment: CommandSegment): boolean {
        return this.isContentReader(segment) && this.readsStaleContent(segment) === null;
    }

    // Is this segment one of the CONTENT_READERS at all (as opposed to a build, a server, a git write)?
    private isContentReader(segment: CommandSegment): boolean {
        const words = this.shell.effectiveWords(segment.text);
        if (words.length === 0) return false;
        if (this.scanner.gitSubcommandOf(words) !== null) return false;
        return CONTENT_READERS.has(this.baseName(words[0]));
    }

    /**
     * The command word that reads stale workspace content, or null when this segment does not.
     * The returned string is only a log/diagnostic label.
     *
     * Judged on the segment's EFFECTIVE words: `for f in a b; do cat $f; done` splits into segments
     * whose middle one is literally `do cat $f`, and taking `do` as the command name let every loop
     * body read the stale tree unseen.
     */
    readsStaleContent(segment: CommandSegment): string | null {
        const words = this.shell.effectiveWords(segment.text);
        if (words.length === 0) return null;

        const gitSub = this.scanner.gitSubcommandOf(words);
        if (gitSub !== null) return this.gitContentRead(gitSub, words);

        const command = this.baseName(words[0]);
        if (!CONTENT_READERS.has(command)) return null;

        const operands = this.pathOperands(command, words.slice(1));
        if (operands.length === 0) {
            // No path given: either it reads stdin (fine — and doubly fine when piped into), or it
            // walks the cwd. That only reads the stale tree when the cwd IS in it — `cd /tmp && ls`
            // walks /tmp, which this repo's staleness has nothing to do with.
            const walksTree = !segment.pipedInto && CWD_WALKERS.has(command) && this.isInWorkspace(this.baseDir);
            return walksTree ? command : null;
        }
        return operands.some((operand: string): boolean => this.isWorkspacePath(operand)) ? command : null;
    }

    /**
     * git's own content readers. `git grep` searches tracked CONTENT and `git show <rev>:<path>`
     * prints a file — both stale when the rev is local. Against an `origin/…` rev they read the
     * CURRENT upstream tree, which is exactly what we want the agent doing, so those pass.
     */
    private gitContentRead(gitSub: string, words: readonly string[]): string | null {
        if (gitSub !== 'grep' && gitSub !== 'show') return null;
        const args = words.slice(words.indexOf(gitSub) + 1);
        if (args.some((arg: string): boolean => arg.startsWith('origin/'))) return null;
        // `git show` without a `<rev>:<path>` operand is a commit view — metadata, not file content.
        if (gitSub === 'show' && !args.some((arg: string): boolean => /^[^-].*:./.test(arg))) return null;
        return `git ${gitSub}`;
    }

    // The operands of a reader that are PATHS: flags dropped, and the leading pattern/script dropped
    // for the commands that take one (`grep RE file`, `sed -e prog file`, `awk prog file`).
    private pathOperands(command: string, args: readonly string[]): readonly string[] {
        const positional: string[] = [];
        for (const arg of args) {
            if (arg.startsWith('-')) continue;                       // a flag, or its attached value
            positional.push(arg);
        }
        if (PATTERN_FIRST.has(command) && positional.length > 0) return positional.slice(1);
        return positional;
    }

    /**
     * Is this operand a path inside the workspace? A RELATIVE operand is resolved against the
     * directory the command actually runs in (`baseDir`), so it counts only when that directory is
     * itself in the tree — the old code assumed every relative path meant "inside the repo", which is
     * how a command run in a `/private/tmp` scratchpad got judged as reading a stale repo. An
     * absolute path counts only when it is genuinely under workspaceRoot, so `/etc/hosts`,
     * `~/notes.md` and `/tmp/x` are not this repo's problem.
     *
     * Deliberately NOT filesystem-checked: whether the path exists says nothing about staleness, and
     * a stat per operand on the blocking hook path is exactly the cost these guards avoid.
     */
    private isWorkspacePath(operand: string): boolean {
        if (operand.startsWith('~')) return false;
        // The escape hatches are checked on the operand AS TYPED as well, so `cat webpieces.config.json`
        // stays readable from any directory — never wedge the file that turns the guard off.
        if (this.isEscapeHatchPath(operand)) return false;
        const absolute = path.isAbsolute(operand) ? operand : path.resolve(this.baseDir, operand);
        const relative = path.relative(this.workspaceRoot, absolute);
        if (relative.startsWith('..')) return false;
        return !this.isEscapeHatchPath(relative);
    }

    // The cwd-walk question: is the directory this command runs in inside the tree being judged?
    private isInWorkspace(dir: string): boolean {
        const relative = path.relative(this.workspaceRoot, path.resolve(dir));
        return !relative.startsWith('..');
    }

    // Always-readable paths: webpieces.config.json is the mode-OFF escape hatch (never block the
    // file that turns the guard off), and `.webpieces/` is the guards' own logs/caches — orientation
    // data this guard writes itself, not source that upstream has moved past.
    private isEscapeHatchPath(relative: string): boolean {
        const normalized = relative.replace(/^\.\//, '');
        return normalized === 'webpieces.config.json' || normalized.startsWith('.webpieces/');
    }

    // `/usr/bin/cat` and `./scripts/cat` both invoke a program named cat; match on the base name.
    private baseName(word: string): string {
        return path.basename(word);
    }
}

// Commands whose whole job is surfacing file CONTENT or file LISTINGS. Builds, test runners, package
// managers and git metadata are deliberately absent — they are not how stale bytes enter context.
const CONTENT_READERS: ReadonlySet<string> = new Set([
    'cat', 'bat', 'head', 'tail', 'less', 'more', 'nl', 'strings', 'xxd', 'od',
    'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'sed', 'awk', 'jq', 'yq',
    'ls', 'find', 'tree', 'wc', 'diff',
]);

// Readers that, given no path, walk the CURRENT DIRECTORY rather than reading stdin — so on a stale
// main they read the stale tree even with no operand at all.
const CWD_WALKERS: ReadonlySet<string> = new Set(['ls', 'find', 'tree', 'rg', 'ag', 'ack']);

// Readers whose FIRST positional argument is a pattern/program, not a path.
const PATTERN_FIRST: ReadonlySet<string> = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'sed', 'awk', 'jq', 'yq']);
