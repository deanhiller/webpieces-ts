import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { dotWebpieces } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

// EXPERIMENTAL (opt-in via `~/.webpieces/config.json` → experimental.buildGateLogCapture). Nothing in this
// file runs for a user who has not created that OPTIONAL file — see `HomeConfigService`
// (`@webpieces/rules-config`), which returns all-defaults silently when it is absent.
//
// That file has a second, REQUIRED key once it exists — `experimental.whole-repo-build-guard` — so the
// smallest document enabling THIS feature is:
//     { "experimental": { "whole-repo-build-guard": false, "buildGateLogCapture": true } }
// `HomeConfigService` owns that rule and prints the same edit when the key is missing.
//
// ─── Why ───────────────────────────────────────────────────────────────────────────────────────────────
// The build gate already builds everything. When it fails, the pre-existing message says "run THIS exact
// command to reproduce", and an AI agent obeys it — so the repo is built a SECOND time purely to see the
// errors that scrolled past the first time. This captures the first build's output instead.
//
// ─── Why a shell `tee` and not spawnSync's pipes ───────────────────────────────────────────────────────
// spawnSync BUFFERS a piped stream and hands it over only after the child exits, so the human would watch
// a silent terminal for the length of a full build. The output has to be split at the OS level, which is
// what `tee` is. The gate keeps `stdio: 'inherit'`, so the terminal is byte-identical to today.
//
// ─── Why an exit-status side file and not `pipefail` ───────────────────────────────────────────────────
// In a pipeline the shell reports the LAST command's status, i.e. tee's, which is 0 whether the build
// passed or failed. `set -o pipefail` and `${PIPESTATUS[0]}` are bash/zsh, and spawnSync's `shell: true`
// gives `/bin/sh` — dash on Debian. Writing `$?` to a side file inside the group is plain POSIX and works
// under every one of them. The redirect keeps it out of the pipe, so it never lands in the log.
const STATUS_SUFFIX = '.status';

/**
 * Which stage's gate is being captured. The value is part of the log FILENAME, so review and finish never
 * write the same file even at the same commit on the same branch.
 */
export const REVIEW_STAGE = 'review';
export const FINISH_STAGE = 'finish';

/**
 * Captures the build gate's full output to `.webpieces/logs/`, and renders the small pointer the AI is
 * handed instead of a rebuild instruction.
 *
 * ─── Why the filename cannot collide ───────────────────────────────────────────────────────────────────
 * The path is `dotWebpieces.logsFile(repoRoot, 'build-gate-<stage>-<branch>-<shortSha>.log')`, and each
 * component rules out one class of concurrent writer:
 *   • the DIRECTORY is `dotWebpieces.local()`-scoped — `<primary>/.webpieces/worktrees/<git worktree
 *     name>/logs/` in a linked worktree. Every worktree therefore has its own log directory already, which
 *     is what makes "N agents in N worktrees" safe by construction rather than by naming.
 *   • `<stage>` separates review from finish, the two gates that CAN run against one commit.
 *   • `<branch>` — a branch can be checked out in at most one worktree (git enforces it), so within one
 *     log directory the branch is effectively constant; it is in the name so a human reading the directory
 *     can tell whose log is whose, and so switching branches never appends to a stale file.
 *   • `<shortSha>` — a re-run at a NEW commit gets a new file, so the log a failure message points at is
 *     always the build for the code that failed. A re-run at the SAME commit deliberately TRUNCATES: it is
 *     the same build of the same tree, and the fresh one is the one worth reading.
 * The residual case is two agents running the same stage, at the same commit, in the SAME worktree,
 * simultaneously. That is already unsupported — both would be driving one git index and one merge state —
 * and it is the only case this scheme does not separate.
 */
@injectable(bindingScopeValues.Singleton)
export class BuildGateLog {
    /** Absolute path of the log for `stage` at the current HEAD, creating the log directory. */
    pathFor(repoRoot: string, stage: string): string {
        const file = dotWebpieces.logsFile(repoRoot, this.fileNameFor(repoRoot, stage));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        return file;
    }

    /** The same path WITHOUT creating anything, and '' when no such log exists. Used by finish's skip path. */
    existingLogFor(repoRoot: string, stage: string): string {
        const file = dotWebpieces.logsFile(repoRoot, this.fileNameFor(repoRoot, stage));
        return fs.existsSync(file) ? file : '';
    }

    /** `build-gate-<stage>-<branch>-<shortSha>.log` — see the class docstring for why this cannot collide. */
    fileNameFor(repoRoot: string, stage: string): string {
        const branch = this.slug(this.git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']));
        const sha = this.slug(this.git(repoRoot, ['rev-parse', '--short', 'HEAD']));
        return `build-gate-${this.slug(stage)}-${branch === '' ? 'nobranch' : branch}-${sha === '' ? 'nosha' : sha}.log`;
    }

    /**
     * Run `buildCommand` with its combined stdout+stderr streaming to the terminal AND appended in full to
     * `logPath`. Returns the BUILD's exit code (not tee's). Nothing is truncated.
     */
    run(repoRoot: string, buildCommand: string, logPath: string): number {
        const statusFile = `${logPath}${STATUS_SUFFIX}`;
        fs.rmSync(statusFile, { force: true });
        const result = spawnSync(this.wrap(buildCommand, logPath, statusFile),
            { stdio: 'inherit', cwd: repoRoot, shell: true });
        const fromFile = this.readStatus(statusFile);
        fs.rmSync(statusFile, { force: true });
        if (fromFile !== null) return fromFile;
        // The side file never appeared ⇒ the shell died before the echo. The PIPELINE's status is tee's,
        // which is 0, and reporting 0 there would call a dead build green — so fail CLOSED instead.
        return result.status !== null && result.status !== 0 ? result.status : 1;
    }

    /**
     * The ENTIRE message the AI gets on a captured failure. Deliberately tiny: the whole point is that the
     * agent reads ONE file rather than carrying a build transcript in its context.
     *
     * The last sentence is not filler. If the log holds no visible failure then something upstream is wrong
     * (a runner that died without printing, a truncated pipe), and the worst possible response is an agent
     * guessing or rebuilding — so it is told to surface the contradiction to the human and stop.
     */
    failureMessage(buildCommand: string, logPath: string): string {
        return `\n❌ The CI build failed. We ran\n\n` +
            `    ${buildCommand} > ${logPath}\n\n` +
            `and it failed, so read that file for the failures. Do NOT re-run the build to see them.\n` +
            `If you do not see failures in that log, report that to the user and stop.\n`;
    }

    /**
     * `{ ( <build> ) ; echo $? > <status> ; } 2>&1 | tee <log>` — written across LINES so a build command
     * ending in a `#` comment cannot swallow what follows it.
     *
     * The inner `( … )` is load-bearing, not decoration. The left side of a pipeline is already a subshell,
     * so a build command containing a plain `exit 7` (or any script that calls `exit`) would terminate that
     * subshell OUTRIGHT — `echo $?` never runs, the side file never appears, and the only status left is
     * tee's 0. The nested subshell absorbs the `exit`, so `$?` is the build's code every time.
     */
    private wrap(buildCommand: string, logPath: string, statusFile: string): string {
        return `{\n(\n${buildCommand}\n)\necho $? > ${this.quote(statusFile)}\n} 2>&1 | tee ${this.quote(logPath)}`;
    }

    // The build's own exit code, or null when the side file never appeared (the shell died before the echo).
    private readStatus(statusFile: string): number | null {
        if (!fs.existsSync(statusFile)) return null;
        const parsed = Number.parseInt(fs.readFileSync(statusFile, 'utf8').trim(), 10);
        return Number.isNaN(parsed) ? null : parsed;
    }

    // POSIX single-quoting: everything is literal inside '…', and a literal ' is spelled '\''.
    private quote(value: string): string {
        return `'${value.split("'").join(`'\\''`)}'`;
    }

    // Anything that is not a filename-safe character becomes '-', so `dean/feat` cannot create directories.
    private slug(value: string): string {
        return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    }

    // One local git read. Fails SOFT to '' — a missing branch/sha degrades the FILENAME, and degrading a
    // filename may never be the reason a build gate does not run.
    private git(repoRoot: string, args: string[]): string {
        const result = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
        if (result.status !== 0) return '';
        return (result.stdout ?? '').trim();
    }
}
