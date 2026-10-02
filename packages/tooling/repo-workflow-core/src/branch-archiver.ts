import { spawnSync } from 'child_process';
import { injectable, bindingScopeValues } from 'inversify';

/**
 * Archive a branch tip as a git TAG immediately before the branch is deleted.
 *
 * WHY this exists: `<feature>PreMerge<n>` snapshot BRANCHES exist for a real reason — after a squash
 * merge you sometimes need the original pre-merge history to debug — but they are branches, so they
 * accumulate forever, count toward `branch-creation-guard`'s maxLocalBranches, and can be committed
 * onto by accident. Observed in the wild: 6 parked branches against a cap of 5, which then REFUSED to
 * create the escape branch and pushed the agent into editing webpieces.config.json to get out.
 *
 * A tag is strictly better at the one job the branch was doing:
 *  - vs KEEPING THE BRANCH — a tag is invisible to `git branch`, does not count toward the branch cap,
 *    and cannot be accidentally committed onto.
 *  - vs storing a PATCH in merge-info — a patch is lossy: it drops commit boundaries, messages,
 *    authorship and parentage. A tag preserves the exact objects.
 *  - vs relying on the REFLOG — the reflog expires (90 days by default) and is local to the one clone
 *    that did the work. A tag survives `gc` and can be pushed if durability beyond one machine is wanted.
 *
 * Cost: one ref, zero new objects — the commits are already in the object store.
 *
 * Round trip (verified by hand, and asserted in branch-archiver.spec.ts against a real repo):
 *   git tag archive/2026-07-30/dean/foo dean/foo
 *   git branch -D dean/foo
 *   git checkout -b dean/foo archive/2026-07-30/dean/foo    # exact objects restored
 */

// Retention policy for a branch whose PR has landed (or which wp-cleanup proved dead).
// DELETE      — delete outright, recoverable only via the reflog (the pre-0.4.492 behaviour).
// ARCHIVE_TAG — tag the tip first, then delete. The default: same disk cost, permanently recoverable.
// KEEP        — do not delete at all (the branch keeps counting toward the branch cap).
export const BRANCH_RETENTION_DELETE = 'delete';
export const BRANCH_RETENTION_ARCHIVE_TAG = 'archive-tag';
export const BRANCH_RETENTION_KEEP = 'keep';
export const BRANCH_RETENTIONS: readonly string[] = [
    BRANCH_RETENTION_DELETE,
    BRANCH_RETENTION_ARCHIVE_TAG,
    BRANCH_RETENTION_KEEP,
];

// The one namespace every archive tag lives under, so `git tag --list 'archive/*'` is the whole
// inventory and `git push origin 'refs/tags/archive/*'` is the whole backup.
export const ARCHIVE_TAG_PREFIX = 'archive';

// Data-only (per CLAUDE.md, classes for data): what archiving one branch produced.
// `tag` is '' when nothing was tagged — either the policy said not to, or git refused; `error` says which.
export class ArchiveResult {
    tag: string;
    sha: string;
    ok: boolean;
    error: string;

    constructor(tag: string, sha: string, ok: boolean, error: string) {
        this.tag = tag;
        this.sha = sha;
        this.ok = ok;
        this.error = error;
    }
}

// Result of a captured git invocation. `err` carries stderr so a refused tag can be reported verbatim.
interface CmdCapture {
    ok: boolean;
    out: string;
    err: string;
}

@injectable(bindingScopeValues.Singleton)
export class BranchArchiver {
    /**
     * `archive/<YYYY-MM-DD>/<branch>`. The date segment is what makes the namespace browsable
     * chronologically (`git tag --list 'archive/2026-07-*'`) and is also what keeps two archives of the
     * SAME branch name from colliding across days — the common case, since a branch name gets reused.
     */
    archiveTagName(branch: string, when: Date = new Date()): string {
        return `${ARCHIVE_TAG_PREFIX}/${this.dateSegment(when)}/${branch}`;
    }

    /**
     * Tag `branch`'s current tip, never overwriting an existing tag.
     *
     * Same branch archived twice on the SAME day gets `…-2`, `…-3`, … rather than `git tag -f`: force
     * would silently destroy the older archive, which is the exact failure the archive exists to prevent.
     * Returns ok=false (with git's stderr) rather than throwing — an archive that cannot be written must
     * turn into "then do not delete either", a decision the CALLER makes.
     *
     * IDEMPOTENT for the same tip: if the base name is already taken by a tag pointing at the SAME sha,
     * that tag is returned as-is rather than minting a `-2` beside it. Re-archiving an identical tip is
     * not a collision — it is the same archive — and `wp-land-pr` produces exactly that case, tagging
     * the branch in its own recap and then handing the worktree reap to a child that (correctly,
     * because it trusts nothing the parent told it) archives again a second later. Without this the
     * archive namespace fills with `…` / `…-2` pairs at one sha, which reads like two distinct
     * snapshots and is one more ref to explain.
     */
    archive(repoRoot: string, branch: string, when: Date = new Date()): ArchiveResult {
        const resolved = this.capture(repoRoot, ['rev-parse', branch]);
        if (!resolved.ok) return new ArchiveResult('', '', false, `cannot resolve ${branch}: ${resolved.err}`);
        const sha = resolved.out;

        const base = this.archiveTagName(branch, when);
        if (this.tagExists(repoRoot, base) && this.tagSha(repoRoot, base) === sha) {
            return new ArchiveResult(base, sha, true, '');
        }

        const tag = this.freeTagName(repoRoot, base);
        const tagged = this.capture(repoRoot, ['tag', tag, sha]);
        if (!tagged.ok) return new ArchiveResult('', sha, false, tagged.err);
        return new ArchiveResult(tag, sha, true, '');
    }

    /** The literal command a human runs to bring an archived branch back, byte-identical to what was deleted. */
    restoreCommand(branch: string, tag: string): string {
        return `git checkout -b ${branch} ${tag}`;
    }

    /** Every archive tag currently in the repo, newest namespace segment first (plain lexical on the date). */
    listArchiveTags(repoRoot: string): string[] {
        const result = this.capture(repoRoot, ['tag', '--list', `${ARCHIVE_TAG_PREFIX}/*`]);
        if (!result.ok || result.out === '') return [];
        return result.out
            .split('\n')
            .map((line: string): string => line.trim())
            .filter((line: string): boolean => line !== '')
            .sort()
            .reverse();
    }

    // First unused name in the `<base>`, `<base>-2`, `<base>-3` … series. Bounded so a pathological repo
    // cannot spin: past the bound we hand back the last candidate and let `git tag` report the collision.
    private freeTagName(repoRoot: string, base: string): string {
        const MAX_ATTEMPTS = 50;
        let candidate = base;
        for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt += 1) {
            if (!this.tagExists(repoRoot, candidate)) return candidate;
            candidate = `${base}-${String(attempt)}`;
        }
        return candidate;
    }

    // The COMMIT an existing tag points at, '' when it cannot be resolved. `^{commit}` peels an
    // annotated tag, so an archive written by hand with `git tag -a` compares equal to a lightweight one.
    private tagSha(repoRoot: string, tag: string): string {
        const result = this.capture(repoRoot, ['rev-parse', `refs/tags/${tag}^{commit}`]);
        return result.ok ? result.out : '';
    }

    // Seam: overridden in the spec so name-collision logic is testable with no git and no repo.
    protected tagExists(repoRoot: string, tag: string): boolean {
        return this.capture(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]).ok;
    }

    // YYYY-MM-DD in LOCAL time: the archive is browsed by the human who created it, on their calendar.
    private dateSegment(when: Date): string {
        const pad = (value: number): string => String(value).padStart(2, '0');
        return `${String(when.getFullYear())}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
    }

    private capture(repoRoot: string, args: string[]): CmdCapture {
        const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
        const err = typeof result.stderr === 'string' ? result.stderr.trim() : '';
        if (result.status !== 0 || typeof result.stdout !== 'string') {
            return { ok: false, out: '', err: err !== '' ? err : 'git command failed' };
        }
        return { ok: true, out: result.stdout.trim(), err };
    }
}
