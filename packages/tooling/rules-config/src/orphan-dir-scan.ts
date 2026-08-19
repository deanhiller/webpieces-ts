import * as path from 'path';
import { spawnSync } from 'child_process';
import { injectable, bindingScopeValues } from 'inversify';

/**
 * Finds ORPHAN DIRECTORIES — the package directories an `nx g move` leaves behind on every clone, which
 * git cannot remove and which then accumulate on every developer's machine forever.
 *
 * ─── WHY GIT LEAVES THEM ──────────────────────────────────────────────────────────────────────────────
 * Git tracks files, not directories. When a move deletes every tracked file under `libraries/apis/foo/`,
 * git removes that directory ONLY if it is then truly empty — and it never is, because the build already
 * put an IGNORED `dist/` and `node_modules/` inside it. So the corpse stands, on every clone, and there
 * is no git setting that changes this (`core.pruneIgnoredDirs` does not exist).
 *
 * ─── WHY THE PREDICATE IS GIT'S OWN ANSWER AND NOT A HAND-ROLLED WALK ─────────────────────────────────
 * `git clean -Xdn` collapses a directory to a SINGLE entry exactly when everything beneath it is ignored,
 * and it does that using the repo's real ignore engine — nested `.gitignore` files, `!` negations and
 * all. Re-implementing that is how a sweeper ends up disagreeing with git about what is disposable.
 *
 * It also hands us the safety property for free, which is the reason this can run unattended: a directory
 * holding even ONE untracked-but-not-ignored file is NOT reported, so a developer's uncommitted new
 * package can never be a candidate. We do not check that ourselves; git's own output already encodes it.
 *
 * ─── THE ONE DISCRIMINATOR THAT NEEDS NO NAME LIST ────────────────────────────────────────────────────
 * `clean -Xdn` reports two very different things the same way:
 *
 *     libraries/apis/pg-dataaccess-api/       ← a corpse: nothing tracked survives under it
 *     libraries/apis/live-api/dist/           ← a LIVE project's build output, there on purpose
 *
 * They are separated by asking whether the directory ITSELF matches an ignore rule. `dist/` does
 * (`.gitignore:19:dist/`); `pg-dataaccess-api` does not, which is precisely the statement that this
 * directory was MEANT to hold tracked files — and none are left. No list of artifact directory names is
 * needed, and none is maintained, so the rule adapts to whatever any given consumer repo ignores.
 *
 * That also yields the opt-out, and it is one a developer would reach for anyway: adding `my-sandbox/`
 * to `.gitignore` makes the directory ignore-matched, which permanently protects it from this sweep.
 */
@injectable(bindingScopeValues.Singleton)
export class OrphanDirScanner {
    /**
     * Every orphan directory under `repoRoot`, as repo-RELATIVE paths with no trailing slash. Empty when
     * the tree is clean, when `repoRoot` is not a git repository, or when git cannot be run at all — a
     * sweeper is never important enough to fail somebody's checkout over.
     */
    scan(repoRoot: string): OrphanCandidate[] {
        const reported = this.reportedByGitClean(repoRoot);
        const candidates: OrphanCandidate[] = [];
        for (const relative of reported) {
            if (!this.isSweepable(relative)) continue;
            if (this.isIgnoredItself(repoRoot, relative)) continue;
            candidates.push(new OrphanCandidate(relative, path.join(repoRoot, relative)));
        }
        return candidates.sort((left: OrphanCandidate, right: OrphanCandidate): number =>
            left.relativePath.localeCompare(right.relativePath));
    }

    /**
     * The DIRECTORY paths `git clean -Xdn` would remove, relative to `repoRoot` and slash-stripped.
     *
     * Only entries ending in `/` are directories; a bare path is a single ignored FILE (`.env`,
     * `.claude/settings.local.json`) and is none of this sweep's business. `Would skip repository` lines
     * are git telling us it found a nested repo — a linked worktree — which it refuses to descend into,
     * and so do we.
     */
    private reportedByGitClean(repoRoot: string): string[] {
        const raw = this.git(repoRoot, ['clean', '-Xdn']);
        if (raw === null) return [];
        const paths: string[] = [];
        for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed.startsWith(WOULD_REMOVE)) continue;
            const target = trimmed.slice(WOULD_REMOVE.length).trim();
            if (!target.endsWith('/')) continue;
            paths.push(target.slice(0, -1));
        }
        return paths;
    }

    /**
     * True when git matches an ignore rule against the DIRECTORY ITSELF — i.e. it is a build artifact
     * somebody declared disposable-but-expected, not a corpse. `check-ignore -q` exits 0 on a match and 1
     * on no match, so a null answer here (any non-zero exit, including a git we could not run) means
     * "cannot confirm", and the directory is SPARED. Every uncertainty in this class resolves that way.
     */
    private isIgnoredItself(repoRoot: string, relative: string): boolean {
        return this.git(repoRoot, ['check-ignore', '-q', '--', relative]) !== null;
    }

    /**
     * The two structural exclusions, both about where a moved nx PROJECT can possibly live.
     *
     * DOT SEGMENTS: `.nx/`, `.idea/`, `.webpieces/` and friends are reported whole by `clean -Xdn` (their
     * contents are ignored, the directories themselves are not) and would otherwise pass the discriminator
     * above perfectly. They are tool state, they are supposed to be there, and no nx project is named with
     * a leading dot. Excluding the whole class by shape beats naming today's four and meeting a fifth.
     *
     * DEPTH: a moved project lives at `libraries/x`, `apps/x`, `packages/y/z` — never at the top level.
     * Requiring depth >= 2 costs nothing real and takes every top-level directory in the repo permanently
     * out of reach of an automated `mv`.
     */
    private isSweepable(relative: string): boolean {
        const segments = relative.split('/');
        if (segments.length < MIN_DEPTH) return false;
        return !segments.some((segment: string): boolean => segment.startsWith('.'));
    }

    /**
     * `git <args>` in `repoRoot`, or null when git exits non-zero or could not be run at all.
     *
     * spawnSync rather than execFileSync because a non-zero exit is ORDINARY here — `check-ignore` says
     * "not ignored" that way — and a status code is a better answer to that question than an exception.
     *
     * An ARGUMENT ARRAY, never a shell string: these paths come from a filesystem scan and may hold
     * spaces, quotes or `$`, and interpolating them into a shell would be building a command injection
     * into the one tool whose entire job is moving directories around.
     */
    private git(repoRoot: string, args: string[]): string | null {
        const result = spawnSync('git', ['-C', repoRoot, ...args], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: GIT_OUTPUT_LIMIT,
        });
        if (result.error !== undefined || result.status !== 0) return null;
        return result.stdout;
    }
}

/** One directory the sweep may archive. Data-only (per CLAUDE.md — classes, not interfaces, for data). */
export class OrphanCandidate {
    /** Repo-relative, no trailing slash — e.g. `libraries/apis/pg-dataaccess-api`. */
    relativePath: string;
    /** The same directory as an absolute path, which is what any `mv` needs. */
    absolutePath: string;

    constructor(relativePath: string, absolutePath: string) {
        this.relativePath = relativePath;
        this.absolutePath = absolutePath;
    }
}

const WOULD_REMOVE = 'Would remove ';
// `libraries/foo` is depth 2. Anything shallower is a top-level directory — see isSweepable().
const MIN_DEPTH = 2;
// `clean -Xdn` on a large monorepo prints a few hundred lines; 16MB is a ceiling no real repo approaches.
const GIT_OUTPUT_LIMIT = 16 * 1024 * 1024;
