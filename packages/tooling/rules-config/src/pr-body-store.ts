import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { injectable, bindingScopeValues } from 'inversify';

import { AgedTreeSweeper, RETENTION_DAYS, SweepCount } from './aged-tree-sweep';
import { MachineStateHome, StateHome, machineStateHome } from './machine-state-home';
import { DotWebpieces, dotWebpieces } from './state-dir';
import { toError } from './to-error';

/** The namespace under the machine-global state root. Everything PR-shaped lives beneath it. */
export const PRS_STATE_DIR = 'prs';
/** The gated squash-commit body `wp-finish-upsert-pr` renders and `wp-land-pr` passes to `gh`. */
export const MERGE_BODY_FILE = 'merge-commit-body.md';
/** The provenance sidecar — also the `origin.json` marker `decisions/0001` § O3 asks for. */
export const PR_ORIGIN_FILE = 'origin.json';

// Every path segment is a single opaque token taken from a remote URL, so anything that is not an
// ordinary name character is folded away. `.` and `..` are rejected outright rather than folded,
// because folding them to `-`/`--` would silently key two different repos to one directory.
const UNSAFE_SEGMENT_CHARS = /[^A-Za-z0-9._-]+/g;

/**
 * The REMOTE repository a PR belongs to: `github.com` / `deanhiller` / `webpieces-ts30`. Data-only.
 *
 * `owner` is a PATH, not one token — GitLab subgroups and Azure DevOps project paths are legitimately
 * several segments deep, and collapsing them would merge two repos into one directory.
 */
export class RepoSlug {
    readonly host: string;
    readonly owner: string;
    readonly repo: string;

    constructor(host: string, owner: string, repo: string) {
        this.host = host;
        this.owner = owner;
        this.repo = repo;
    }

    /** FALSE when the remote could not be read or parsed — the caller must then not pretend to store. */
    get known(): boolean {
        return this.host !== '' && this.owner !== '' && this.repo !== '';
    }

    /** The directory segments, in order. `owner` may contribute more than one. */
    segments(): string[] {
        return [this.host, ...this.owner.split('/'), this.repo];
    }

    toString(): string {
        return `${this.host}/${this.owner}/${this.repo}`;
    }
}

/**
 * WHO wrote a PR body, and from WHERE. Data-only, serialized beside the body as `origin.json`.
 *
 * `treeRoot` is the load-bearing field: `wp-land-pr` compares it against the tree it is standing in to
 * decide whether the tree-bound bookkeeping (archive the pre-squash tip, promote merge-info, reap the
 * worktree) belongs to it. See `land-pr-command.ts`.
 */
export class PrBodyOrigin {
    treeRoot = '';
    primaryRoot = '';
    branch = '';
    feature = '';
    prNumber = '';
    prUrl = '';
    writtenAt = '';
}

/** A stored body: where it is, and the provenance beside it (`null` origin ⇒ no readable sidecar). */
export class PrBodyLocation {
    readonly dir: string;
    readonly bodyFile: string;
    readonly origin: PrBodyOrigin | null;

    constructor(dir: string, bodyFile: string, origin: PrBodyOrigin | null) {
        this.dir = dir;
        this.bodyFile = bodyFile;
        this.origin = origin;
    }
}

/**
 * The gated squash-commit body for a PR, stored by the PR's GLOBAL identity rather than by the tree
 * that happened to render it:
 *
 *     ~/.webpieces/prs/<host>/<owner>/<repo>/<prNumber>/merge-commit-body.md
 *
 * ─── The bug this fixes ─────────────────────────────────────────────────────────────────────────────
 * The body used to live at `<primary>/.webpieces/worktrees/<name>/pr-review/<branch>/`, i.e. in
 * PER-WORKTREE state. But `pr-review/<branch>/` is keyed by BRANCH, and a branch is a REPO-WIDE fact —
 * git forbids two worktrees checking out one branch — so a per-tree home only worked while the branch
 * never moved trees. The gated flow ran in the primary clone, landing happened from a linked worktree,
 * `wp-land-pr` looked under the worktree's namespace and printed "Nothing to land". That is a SCOPE
 * MISMATCH, not a missing fallback, and the fix is to give the artifact the scope of its identity.
 *
 * ─── Why keyed by the remote, when `decisions/0001` § D2 forbids exactly that ───────────────────────
 * D2 rejects the remote URL as the key for CLONE state, because two clones of one repo have different
 * branches, worktrees and in-flight merges and must NOT share. That reasoning is intact and this is its
 * mirror image: a PR NUMBER is a fact of the remote, the same object seen from every clone, and here
 * sharing is the REQUIREMENT — landing must work from any tree, and from a second clone of the same
 * repo, as long as the PR was posted from this machine. The rule underneath both is one rule: key an
 * artifact by the scope of the fact it describes.
 *
 * ─── Why nested segments and not D2's flattening ────────────────────────────────────────────────────
 * D2 flattens because it keys on an absolute PATH, whose separators must survive as data. Here each
 * segment is already a single opaque token (`github.com`, `deanhiller`, `webpieces-ts30`, `604`), the
 * hierarchy is real, and it buys two things a flattened key cannot: it is browsable by a human
 * debugging a landing, and the retention sweep prunes the empty parents of a reaped PR for free.
 *
 * ─── What is NOT stored here ────────────────────────────────────────────────────────────────────────
 * Everything else under `pr-review/<branch>/` — review.json, the per-checklist verdicts, pr-context.json
 * and the stage snapshots. Those describe work in progress in ONE tree and correctly stay local. Only
 * the finished receipt for a posted PR is machine-global.
 *
 * ─── Never regenerated ──────────────────────────────────────────────────────────────────────────────
 * `wp-land-pr` READS this and never re-renders it. The bytes that land are the bytes finish produced;
 * re-deriving them at land time would be a second authoritative gate whose result nobody reads. See
 * `land-pr-command.ts`.
 */
@injectable(bindingScopeValues.Singleton)
export class PrBodyStore {
    // startDir → the remote slug. `git remote get-url` is a process spawn; commands ask more than once.
    private readonly slugByDir = new Map<string, RepoSlug>();

    constructor(
        private readonly stateHome: MachineStateHome = machineStateHome,
        private readonly dotDir: DotWebpieces = dotWebpieces,
        private readonly sweeper: AgedTreeSweeper = new AgedTreeSweeper(),
    ) {}

    /** The machine-global root this store writes under, plus whether it degraded to the clone. */
    home(startDir: string): StateHome {
        return this.stateHome.resolve(this.dotDir.primaryRoot(startDir));
    }

    /** `<state home>/prs` — the sweep root, and the directory a human is pointed at when landing fails. */
    prsRoot(startDir: string): string {
        return path.join(this.home(startDir).root, PRS_STATE_DIR);
    }

    /**
     * The remote this working tree pushes to. Read from `origin`, because that is the remote `gh` itself
     * resolves a PR against — asking a different remote would key the body under a repo the PR is not on.
     * An unknown slug (no remote, detached tooling, a URL shape we decline to guess at) is returned as
     * `known === false`; it is never fabricated.
     */
    slugFor(startDir: string): RepoSlug {
        const cached = this.slugByDir.get(startDir);
        if (cached !== undefined) return cached;
        const slug = this.parseRemote(this.remoteUrl(startDir));
        this.slugByDir.set(startDir, slug);
        return slug;
    }

    /** The directory for one PR, or '' when the remote is unknown or `prNumber` is not a number. */
    dirFor(startDir: string, prNumber: string): string {
        const slug = this.slugFor(startDir);
        if (!slug.known || !/^\d+$/.test(prNumber.trim())) return '';
        return path.join(this.prsRoot(startDir), ...slug.segments(), prNumber.trim());
    }

    /**
     * Store the gated body for `prNumber` and return where it went — `null` when it cannot be stored at
     * all (unknown remote, or a PR whose number could not be read back from GitHub). A `null` here is
     * NOT fatal for the caller that is about to merge in the same process: it still holds the bytes. It
     * IS the reason a later `wp-land-pr` will report the PR as not found on this machine, which is the
     * honest answer — no durable receipt was ever filed.
     */
    write(startDir: string, prNumber: string, body: string, origin: PrBodyOrigin): PrBodyLocation | null {
        const dir = this.dirFor(startDir, prNumber);
        if (dir === '') return null;
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: a store that cannot be written degrades to null, never a crash mid-PR-post
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            fs.mkdirSync(dir, { recursive: true });
            const bodyFile = path.join(dir, MERGE_BODY_FILE);
            fs.writeFileSync(bodyFile, body);
            fs.writeFileSync(path.join(dir, PR_ORIGIN_FILE), JSON.stringify(origin, null, 2) + '\n');
            return new PrBodyLocation(dir, bodyFile, origin);
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return null;
        }
    }

    /** The stored body for `prNumber`, or `null` when this machine has none. */
    read(startDir: string, prNumber: string): PrBodyLocation | null {
        const dir = this.dirFor(startDir, prNumber);
        if (dir === '') return null;
        const bodyFile = path.join(dir, MERGE_BODY_FILE);
        if (!fs.existsSync(bodyFile)) return null;
        return new PrBodyLocation(dir, bodyFile, this.readOrigin(dir));
    }

    /**
     * The 30-day reap of `prs/`, run from the same place every other `.webpieces` sweep runs.
     *
     * `decisions/0001` § O3: these directories outlive every clone, so nothing else will ever delete
     * them. A landed PR's body is never rewritten, so it ages out on schedule; a PR still being pushed
     * to gets a fresh mtime on every `wp-finish-upsert-pr`, so an open PR is never reaped out from under
     * a landing.
     */
    sweep(startDir: string, onDelete: (removed: string, isDir: boolean) => void = (): void => {}): SweepCount {
        return this.sweeper.sweep(this.prsRoot(startDir), RETENTION_DAYS * 24 * 60 * 60 * 1000, onDelete);
    }

    private readOrigin(dir: string): PrBodyOrigin | null {
        const file = path.join(dir, PR_ORIGIN_FILE);
        if (!fs.existsSync(file)) return null;
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: an unreadable sidecar means "no provenance", never a crash
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            // webpieces-disable no-any-unknown -- parsed JSON is opaque until narrowed field-by-field below
            const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
            const origin = new PrBodyOrigin();
            origin.treeRoot = this.str(raw['treeRoot']);
            origin.primaryRoot = this.str(raw['primaryRoot']);
            origin.branch = this.str(raw['branch']);
            origin.feature = this.str(raw['feature']);
            origin.prNumber = this.str(raw['prNumber']);
            origin.prUrl = this.str(raw['prUrl']);
            origin.writtenAt = this.str(raw['writtenAt']);
            return origin;
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return null;
        }
    }

    // webpieces-disable no-any-unknown -- one opaque JSON field, narrowed to string
    private str(value: unknown): string {
        return typeof value === 'string' ? value : '';
    }

    private remoteUrl(startDir: string): string {
        const result = spawnSync('git', ['-C', startDir, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
        if (result.status !== 0) return '';
        return (result.stdout ?? '').trim();
    }

    /**
     * Remote URL → host/owner/repo, for the three shapes git actually hands out:
     *
     *   git@github.com:owner/repo.git          scp-like
     *   ssh://git@github.com:22/owner/repo.git url with a port
     *   https://user@host/owner/sub/repo.git   url, possibly with credentials and subgroups
     *
     * Anything else returns an UNKNOWN slug rather than a guess. A wrong key here silently files the
     * receipt under a repo the PR is not on, which reads to the next reader as "the body was never
     * written" — the exact failure being fixed. Not guessing is the only safe default.
     */
    private parseRemote(url: string): RepoSlug {
        const unknown = new RepoSlug('', '', '');
        if (url === '') return unknown;
        const scp = /^(?:[^@/]+@)?([^:/@]+):(?!\/)(.+)$/.exec(url);
        const parts = scp !== null
            ? new RemoteParts(scp[1] ?? '', scp[2] ?? '')
            : this.urlParts(url);
        if (parts === null) return unknown;

        const segments = parts.pathPart.replace(/\.git$/, '').split('/').filter((s: string): boolean => s !== '');
        if (segments.length < 2) return unknown;
        const repo = this.safe(segments[segments.length - 1] ?? '');
        const owner = segments.slice(0, -1).map((s: string): string => this.safe(s)).join('/');
        const host = this.safe(parts.host);
        if (repo === '' || owner.includes('//') || owner === '' || host === '') return unknown;
        return new RepoSlug(host, owner, repo);
    }

    private urlParts(url: string): RemoteParts | null {
        const match = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(url);
        if (match === null) return null;
        return new RemoteParts(match[1] ?? '', match[2] ?? '');
    }

    // One path segment, reduced to characters that cannot escape the directory they name. `.` and `..`
    // are refused rather than folded: folding them would key two distinct repos to one directory.
    private safe(segment: string): string {
        if (segment === '.' || segment === '..') return '';
        return segment.replace(UNSAFE_SEGMENT_CHARS, '-');
    }
}

/** Data-only split of a remote URL into the two pieces the slug needs. */
class RemoteParts {
    readonly host: string;
    readonly pathPart: string;

    constructor(host: string, pathPart: string) {
        this.host = host;
        this.pathPart = pathPart;
    }
}
