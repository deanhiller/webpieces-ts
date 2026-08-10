import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { toError } from './to-error';

/** The umbrella package every consumer pins. One `catalog:` entry pins its children in lockstep. */
export const UMBRELLA_PACKAGE = '@webpieces/nx-webpieces-rules';

/** `pnpm-workspace.yaml`'s catalog is the ONE place a webpieces version is declared. */
const WORKSPACE_FILE = 'pnpm-workspace.yaml';

/**
 * ONE tree's answer to "which @webpieces does this tree declare, and which does it have installed".
 * Data-only (per CLAUDE.md, classes for data). `null` means "could not be determined" — which is NOT
 * the same as disagreeing, and every caller must treat it as "no opinion", never as skew.
 */
export class TreeVersions {
    constructor(
        readonly root: string,
        /** The catalog pin in this tree's `pnpm-workspace.yaml`. Tracked in git, so it is per-branch. */
        readonly pinned: string | null,
        /** The version actually installed under this tree's own `node_modules`, when it has one. */
        readonly installed: string | null,
    ) {}
}

/**
 * The 3-or-4 webpieces versions in play when a worktree is involved, and whether they agree.
 *
 * THREE always — main pin, worktree pin, main install — and a FOURTH when the worktree has its own
 * `node_modules`, which happens the moment anyone runs `pnpm add <anything>` in it. That fourth is the
 * uncommon one, and it is NOT optional to check: nx, vitest and the eslint plugin all run IN that tree
 * and load THAT copy. (It does not decide who *judges* the tree — with the guard hooks registered
 * absolutely, the judging binary is always the main tree's — but it decides who *builds, lints and
 * tests* it, and nothing else looks at it.)
 */
export class VersionQuartet {
    constructor(
        readonly main: TreeVersions,
        readonly worktree: TreeVersions,
    ) {}

    /** Every version that was actually readable, deduped — the set that must have exactly one member. */
    get distinct(): readonly string[] {
        const all = [this.main.pinned, this.main.installed, this.worktree.pinned, this.worktree.installed];
        const seen: string[] = [];
        for (const v of all) {
            if (v !== null && !seen.includes(v)) seen.push(v);
        }
        return seen;
    }

    /**
     * True when every version we could read agrees.
     *
     * FAILS OPEN on purpose: if nothing could be read (`distinct` is empty) this is `true`. A guard that
     * cannot measure must not block — the repo's worst incidents are guards that fired on a state they
     * could not diagnose, leaving an agent with no reachable cure.
     */
    get inSync(): boolean {
        return this.distinct.length <= 1;
    }
}

/**
 * Reads the webpieces versions a tree declares and installs.
 *
 * WHY A DEDICATED READER rather than reusing the sh drift guard's scraping: that one compares a pin to
 * an install WITHIN ONE TREE, which is a different question. This is the CROSS-TREE generalisation, and
 * it is the only thing that can catch the case the absolute-registration design deliberately accepts —
 * a worktree being judged by the main tree's release while its own manifest asks for another.
 *
 * Every read is best-effort and returns `null` rather than throwing: this runs on the hook's BLOCKING
 * path, so an unreadable file must degrade to "no opinion", never to a fault.
 */
export class WebpiecesVersions {
    // root -> answer. The hook resolves the same two roots many times per invocation; git and fs are
    // both far too expensive to repeat on a blocking path.
    private readonly byRoot = new Map<string, TreeVersions>();

    /** Both trees' versions, ready to compare. */
    quartet(mainRoot: string, worktreeRoot: string): VersionQuartet {
        return new VersionQuartet(this.forTree(mainRoot), this.forTree(worktreeRoot));
    }

    /** One tree's declared + installed versions, memoized. */
    forTree(root: string): TreeVersions {
        const cached = this.byRoot.get(root);
        if (cached !== undefined) return cached;
        const answer = new TreeVersions(root, this.readPin(root), this.readInstalled(root));
        this.byRoot.set(root, answer);
        return answer;
    }

    /**
     * The catalog pin, scraped from `pnpm-workspace.yaml`.
     *
     * Deliberately a narrow regex rather than a YAML parser: this module must stay dependency-free (it
     * loads on the hook path, where a broken tree is exactly the case that matters), and the catalog
     * entry has one shape — `'@webpieces/nx-webpieces-rules': 0.4.616`, optionally unquoted. A RANGE
     * (`^`, `~`, `workspace:*`) is returned as null, not as a version: a range cannot be compared for
     * equality, and treating it as skew would block every consumer who pins loosely.
     */
    private readPin(root: string): string | null {
        const file = path.join(root, WORKSPACE_FILE);
        const text = this.readText(file);
        if (text === null) return null;
        const escaped = UMBRELLA_PACKAGE.replace('/', '\\/');
        const match = new RegExp(`['"]?${escaped}['"]?\\s*:\\s*['"]?([^'"\\s#]+)`).exec(text);
        if (match === null) return null;
        const value = match[1];
        return /^[0-9]/.test(value) ? value : null;
    }

    /** The version under this tree's OWN node_modules, or null when it has none (the normal worktree). */
    private readInstalled(root: string): string | null {
        const manifest = path.join(root, 'node_modules', UMBRELLA_PACKAGE, 'package.json');
        const text = this.readText(manifest);
        if (text === null) return null;
        const match = /"version"\s*:\s*"([^"]+)"/.exec(text);
        return match === null ? null : match[1];
    }

    // Best-effort by design: this runs on the hook's BLOCKING path, so an unreadable or half-written
    // manifest must degrade to "no opinion" rather than fault. A null here can only ever make the guard
    // quieter, never noisier — VersionQuartet.inSync fails open on an empty read.
    private readText(file: string): string | null {
        // webpieces-disable no-unmanaged-exceptions -- a manifest read on a PreToolUse blocking path has no chokepoint above it; letting it throw would fail every tool call over an unrelated fs error
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return null;
        }
    }

    /**
     * Every OTHER linked worktree of this repo, so a block can name the ones that are ALSO skewed.
     *
     * A skew is never a two-tree problem: if worktree A is aligned and B is not, the agents working in B
     * are already mis-governed and nothing has told them. Best-effort — an empty answer means "could not
     * enumerate", and callers must never read that as "there are no other worktrees".
     */
    otherWorktrees(mainRoot: string, exclude: string): readonly string[] {
        const result = spawnSync('git', ['-C', mainRoot, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
        if (result.status !== 0) return [];
        const roots: string[] = [];
        for (const line of (result.stdout ?? '').split('\n')) {
            if (!line.startsWith('worktree ')) continue;
            const dir = line.slice('worktree '.length).trim();
            if (dir !== '' && path.resolve(dir) !== path.resolve(mainRoot) && path.resolve(dir) !== path.resolve(exclude)) {
                roots.push(dir);
            }
        }
        return roots;
    }
}
