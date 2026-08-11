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
     * Deliberately a narrow scraper rather than a YAML parser: this module must stay dependency-free (it
     * loads on the hook path, where a broken tree is exactly the case that matters). A RANGE (`^`, `~`,
     * `workspace:*`) is returned as null, not as a version: a range cannot be compared for equality, and
     * treating it as skew would block every consumer who pins loosely.
     *
     * ANCHORS AND ALIASES ARE NOT OPTIONAL TO SUPPORT. The scraper originally assumed one shape —
     * `'@webpieces/nx-webpieces-rules': 0.4.616` — and a consumer repo that keeps the whole `@webpieces`
     * family in lockstep the obvious way writes the version ONCE and aliases it:
     *
     *     catalog:
     *       '@webpieces/core-context': &wp 0.4.634
     *       '@webpieces/nx-webpieces-rules': *wp
     *
     * There the umbrella's own value is `*wp`, which does not start with a digit, so the pin read as
     * null and the whole TRINARY compare silently degraded to installed-vs-installed — the guard's third
     * leg gone with no error, on exactly the repos that pin most carefully. So both halves are resolved
     * here: a `&name` anchor DEFINED on the umbrella's line is stepped over, and a `*name` alias is
     * looked up against the anchor definition anywhere in the file.
     */
    private readPin(root: string): string | null {
        const file = path.join(root, WORKSPACE_FILE);
        const text = this.readText(file);
        if (text === null) return null;
        const escaped = UMBRELLA_PACKAGE.replace('/', '\\/');
        // `[ \t]*`, never `\s*`: under the `m` flag `\s` matches newlines, so a leading `\s*` would let
        // the "indent" run across blank lines. Harmless for this grammar, and not a habit worth keeping
        // in the reader whose whole bug history is a regex that matched more than it meant to.
        const match = new RegExp(`^[ \\t]*['"]?${escaped}['"]?[ \\t]*:[ \\t]*(.*)$`, 'm').exec(text);
        if (match === null) return null;
        return this.resolveValue(match[1], text);
    }

    /** One catalog value — literal, `&anchor literal`, or `*alias` — reduced to a plain version or null. */
    private resolveValue(rawValue: string, text: string): string | null {
        // `&wp 0.4.634` on the umbrella's own line: the anchor NAMES the value, it is not the value.
        const value = rawValue.replace(/^&\S+[ \t]+/, '').trim();
        const token = /^['"]?([^'"\s#]+)/.exec(value)?.[1] ?? '';
        if (token.startsWith('*')) {
            const anchor = token.slice(1);
            // A YAML anchor name is a plain identifier. Refusing anything else keeps the name out of a
            // RegExp it could otherwise inject into — and an unreadable pin is already a safe answer.
            if (!/^[A-Za-z0-9_-]+$/.test(anchor)) return null;
            // Resolve against the DEFINITION site, which is another key's value elsewhere in the catalog.
            // The match is pinned to `<key>: &anchor <value>` on a NON-COMMENT line, because the repos
            // that use an anchor also EXPLAIN it right above the catalog — "defined ONCE via the &wp YAML
            // anchor below" — and a bare `&wp` search happily reads the word "YAML" out of that prose.
            const defined = new RegExp(`^[ \\t]*['"]?[^#'"\\s:][^:\\n]*['"]?[ \\t]*:[ \\t]*&${anchor}[ \\t]+['"]?([^'"\\s#]+)`, 'm').exec(text);
            if (defined === null) return null;
            return /^[0-9]/.test(defined[1]) ? defined[1] : null;
        }
        return /^[0-9]/.test(token) ? token : null;
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
