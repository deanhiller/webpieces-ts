import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { EffectiveTree } from './effective-tree';
import { VersionSyncGuard } from './version-sync';
import { WebpiecesVersions } from './webpieces-versions';

/**
 * L1 row 8 — the guard that replaced CoordinatorWorktreeGuard.
 *
 * The old guard asked WHO was calling (coordinator vs subagent). This one asks WHICH TREE the command
 * acts on, because agent identity was measured untrustworthy for that question: a worktree-isolated
 * agent whose tree is auto-reaped at a turn boundary silently resumes with its cwd on the primary clone.
 * A version read off the path cannot lie in that way.
 *
 * These fixtures write REAL manifests. The guard reads files, so a fabricated path would read nothing,
 * come back "in sync", and make every assertion here vacuous.
 */

const PKG = '@webpieces/nx-webpieces-rules';

function tmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'wp-vsync-'));
}

function writePin(root: string, version: string): void {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), `catalog:\n  '${PKG}': ${version}\n`);
}

function writeInstalled(root: string, version: string): void {
    const dir = path.join(root, 'node_modules', PKG);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: PKG, version }));
}

/** main + worktree, with whatever versions the case needs. */
function pair(mainPin: string, wtPin: string): { main: string; wt: string } {
    const base = tmp();
    const main = path.join(base, 'main');
    const wt = path.join(base, 'wt');
    writePin(main, mainPin);
    writePin(wt, wtPin);
    writeInstalled(main, mainPin);
    return { main, wt };
}

/**
 * The command was typed FROM THE MAIN TREE at a worktree (`cd <wt> && …`), so the main tree owns the
 * config as well as the install: governedRoot and mainRoot coincide.
 */
function worktreeTree(main: string, wt: string): EffectiveTree {
    return new EffectiveTree(main, wt, wt, main, main, 'worktree');
}

/**
 * THE COMMON CASE, and the one that was silently exempt: the agent LIVES in the worktree. Its cwd is the
 * worktree, and the worktree has its own TRACKED webpieces.config.json — so `governedRoot` is the
 * WORKTREE, not the main clone. Only `mainRoot` still points at the tree whose node_modules judges the
 * call.
 */
function residentTree(main: string, wt: string): EffectiveTree {
    return new EffectiveTree(wt, wt, wt, wt, main, 'worktree');
}

/**
 * THE ROW-8 REPORT, rendered against real fixtures, EXPORTED for the cross-surface banned-phrase sweep in
 * shim-deny-reason.spec.ts.
 *
 * That sweep greps every RENDERED guard surface for wordings that contradict the worktree rule, so a new
 * message inherits the ban for free — and this was the one surface it could not reach, because the guard
 * reads pnpm-workspace.yaml and node_modules off disk and so needs the tmp-dir fixtures above. It is also
 * the surface MOST likely to regrow the phrase, being the guard that talks about worktrees for a living;
 * it was pinned only by a single `not.toContain` local to this file. Exporting the render (rather than
 * copying the fixtures into the other spec) keeps ONE definition of what a skewed worktree looks like.
 */
export function renderVersionSyncRow8Report(): string {
    const dirs = pair('0.4.616', '0.4.612');
    return new VersionSyncGuard().block('pnpm build', worktreeTree(dirs.main, dirs.wt)) ?? '';
}

describe('VersionSyncGuard — when it fires', () => {
    it('BLOCKS real work in a worktree whose pin disagrees with the main tree', () => {
        const dirs = pair('0.4.616', '0.4.612');
        const report = new VersionSyncGuard().block('pnpm build', worktreeTree(dirs.main, dirs.wt));
        expect(report).not.toBeNull();
        expect(report).toContain('0.4.616');
        expect(report).toContain('0.4.612');
    });

    it('ALLOWS when every version agrees', () => {
        const dirs = pair('0.4.616', '0.4.616');
        expect(new VersionSyncGuard().block('pnpm build', worktreeTree(dirs.main, dirs.wt))).toBeNull();
    });

    /**
     * The main tree is never this guard's business, and that is one of the two structural escapes: "do
     * the work in the main tree" needs no allowlist entry, so no future allowlist edit can break it.
     */
    it('never fires on the MAIN tree, however skewed anything else is', () => {
        const dirs = pair('0.4.616', '0.4.612');
        const primary = new EffectiveTree(dirs.main, dirs.main, dirs.main, dirs.main, dirs.main, 'primary');
        expect(new VersionSyncGuard().block('pnpm build', primary)).toBeNull();
    });

    /**
     * THE HOLE THIS SPEC EXISTS FOR (measured 2026-08-10). A resident agent's worktree owns its own
     * TRACKED config, so `governedRoot` is the WORKTREE — and the guard used to compare `governedRoot`
     * with `root`, i.e. the tree with itself. Two trees of one repo ran different releases for a whole
     * session and row 8 never fired. The comparison is against `mainRoot` now.
     */
    it('FIRES for an agent whose cwd IS the worktree — governedRoot is the worktree, mainRoot is not', () => {
        const dirs = pair('0.4.616', '0.4.624');
        writeInstalled(dirs.wt, '0.4.624');
        const guard = new VersionSyncGuard();
        const tree = residentTree(dirs.main, dirs.wt);
        expect(tree.governedRoot).toBe(dirs.wt);
        expect(guard.skewed(tree)).toBe(true);
        const report = guard.block('pnpm build', tree);
        expect(report).not.toBeNull();
        expect(report).toContain('0.4.616');
        expect(report).toContain('0.4.624');
        // The cure has to name the MAIN clone, not the worktree the agent is standing in.
        expect(report).toContain(`git -C ${dirs.main} pull`);
    });

    it('stays silent for a resident agent once the two trees agree', () => {
        const dirs = pair('0.4.616', '0.4.616');
        writeInstalled(dirs.wt, '0.4.616');
        expect(new VersionSyncGuard().block('pnpm build', residentTree(dirs.main, dirs.wt))).toBeNull();
    });

    it('a resident agent can still look, and still run the cure, from inside the block', () => {
        const dirs = pair('0.4.616', '0.4.624');
        writeInstalled(dirs.wt, '0.4.624');
        const guard = new VersionSyncGuard();
        const tree = residentTree(dirs.main, dirs.wt);
        for (const command of ['ls -la', 'cat pnpm-workspace.yaml', 'git status', 'git pull', 'pnpm install']) {
            expect(guard.block(command, tree), command).toBeNull();
        }
    });

    /**
     * A tree compared with ITSELF is not a skew. If git cannot name a separate primary clone the roots
     * coincide, and the pin-vs-install question that remains belongs to the L0 drift guard — this one
     * must not invent a cross-tree verdict out of one tree's two numbers.
     */
    it('never fires when mainRoot and root are the same directory', () => {
        const dirs = pair('0.4.616', '0.4.612');
        writeInstalled(dirs.wt, '0.4.500');
        const selfTree = new EffectiveTree(dirs.wt, dirs.wt, dirs.wt, dirs.wt, dirs.wt, 'worktree');
        expect(new VersionSyncGuard().skewed(selfTree)).toBe(false);
        expect(new VersionSyncGuard().block('pnpm build', selfTree)).toBeNull();
    });

    it('never fires on read-only inspection — you can always look before you fix', () => {
        const dirs = pair('0.4.616', '0.4.612');
        const tree = worktreeTree(dirs.main, dirs.wt);
        for (const command of ['ls -la', 'cat package.json', 'git status', 'pwd']) {
            expect(new VersionSyncGuard().block(command, tree), command).toBeNull();
        }
    });

    /**
     * THE CURE MUST PASS THROUGH ITS OWN BLOCK. ReadOnlyInspectionScan excludes git outright, so without
     * an explicit carve-out this guard would deny `git pull` — the very command its deny text prescribes.
     */
    it('never blocks its own cure: git pull/fetch and pnpm install stay reachable from inside the block', () => {
        const dirs = pair('0.4.616', '0.4.612');
        const tree = worktreeTree(dirs.main, dirs.wt);
        const guard = new VersionSyncGuard();
        for (const command of ['git pull', 'git fetch origin main', 'pnpm install', `git -C ${dirs.main} pull`]) {
            expect(guard.block(command, tree), command).toBeNull();
        }
    });

    it('still blocks the operations that would be judged by the wrong release', () => {
        const dirs = pair('0.4.616', '0.4.612');
        const tree = worktreeTree(dirs.main, dirs.wt);
        const guard = new VersionSyncGuard();
        for (const command of ['pnpm build', 'pnpm test', 'git commit -m x', 'npx nx run-many -t build']) {
            expect(guard.block(command, tree), command).not.toBeNull();
        }
    });

    /**
     * FAIL OPEN, deliberately. A guard that cannot measure must not block: this repo's worst incidents
     * are guards that fired on a state they could not diagnose, leaving no reachable cure.
     */
    it('ALLOWS when nothing can be read — an unmeasurable tree is not a skewed one', () => {
        const base = tmp();
        const main = path.join(base, 'main');
        const wt = path.join(base, 'wt');
        fs.mkdirSync(main, { recursive: true });
        fs.mkdirSync(wt, { recursive: true });
        expect(new VersionSyncGuard().block('pnpm build', worktreeTree(main, wt))).toBeNull();
    });

    /** A range cannot be compared for equality; treating it as skew would block every loose pinner. */
    it('ignores a RANGE specifier rather than calling it skew', () => {
        const base = tmp();
        const main = path.join(base, 'main');
        const wt = path.join(base, 'wt');
        writePin(main, '0.4.616');
        writeInstalled(main, '0.4.616');
        fs.mkdirSync(wt, { recursive: true });
        fs.writeFileSync(path.join(wt, 'pnpm-workspace.yaml'), `catalog:\n  '${PKG}': ^0.4.0\n`);
        expect(new VersionSyncGuard().block('pnpm build', worktreeTree(main, wt))).toBeNull();
    });
});

describe('VersionSyncGuard — the FOURTH version', () => {
    /**
     * 3 locations always, a 4th when present. A worktree gets its own node_modules the moment anyone runs
     * `pnpm add <anything>` in it — common, not exotic. It does not decide who JUDGES the tree (the guard
     * hooks are absolute, so that is always the main tree's binary) but it does decide what nx, vitest
     * and eslint load IN that tree, and nothing else checks it.
     */
    it('catches a worktree whose OWN node_modules disagrees, even when both pins match', () => {
        const dirs = pair('0.4.616', '0.4.616');
        writeInstalled(dirs.wt, '0.4.500');
        const report = new VersionSyncGuard().block('pnpm build', worktreeTree(dirs.main, dirs.wt));
        expect(report).not.toBeNull();
        expect(report).toContain('0.4.500');
        expect(report).toContain('what nx, vitest and eslint load IN this tree');
    });

    it('does not mention the fourth location when the worktree has no node_modules', () => {
        const dirs = pair('0.4.616', '0.4.612');
        const report = new VersionSyncGuard().block('pnpm build', worktreeTree(dirs.main, dirs.wt)) ?? '';
        expect(report).not.toContain('what nx, vitest and eslint load IN this tree');
    });
});

describe('VersionSyncGuard — the message', () => {
    const reportFor = (): string => {
        const dirs = pair('0.4.616', '0.4.612');
        return new VersionSyncGuard().block('pnpm build', worktreeTree(dirs.main, dirs.wt)) ?? '';
    };

    it('names every version WITH the file it came from, so no grepping is needed', () => {
        expect(reportFor()).toContain('pnpm-workspace.yaml');
        expect(reportFor()).toContain('node_modules/@webpieces/nx-webpieces-rules');
    });

    /** The cure is a GIT cure: the pin is tracked, so the same hash gives the same version. */
    it('leads with the git cure and installs in each tree that has a node_modules', () => {
        const report = reportFor();
        expect(report).toContain('git -C');
        expect(report).toContain('pnpm install');
        expect(report).toContain('A worktree MAY have its');
        expect(report).toContain('what it may not have is a DIFFERENT @webpieces version');
    });

    /**
     * THE CLONE IS THE ANSWER TO A DIFFERENT QUESTION, and this report used to conflate the two. It said
     * "a worktree needs no install of its own" and "a clone gets its own node_modules ...; a worktree
     * cannot" — both false. nx, vitest and the eslint plugin all execute in the worktree and load from
     * ITS node_modules, and `pnpm add <anything>` creates one. Measured 2026-08-10: an agent was told by
     * the DRIFT guard to install in its worktree, did, and worked — while this report told it the
     * opposite, which is the multi-cure straddle the L0 deny text exists to end. What a clone gets that a
     * worktree does not is its own GOVERNANCE, i.e. permission to be on a different version.
     */
    it('offers the CLONE only as the different-version escape, never as "do not install here"', () => {
        const report = reportFor();
        expect(report).toContain('separate CLONE');
        expect(report).toContain('installing here is fine');
        expect(report).not.toContain('a worktree cannot');
    });

    /** A subagent cannot fix the main tree — it must escalate, not attempt a local fix. */
    it('tells a subagent to report to its coordinator', () => {
        expect(reportFor()).toContain('report to your');
    });

    /** The obvious wrong fix: downgrade main so it matches. That breaks every other tree. */
    it('warns against lowering the MAIN pin to match', () => {
        expect(reportFor()).toContain('Do NOT lower');
    });

    it('stays on the L0 message diet — short enough to be read, not skimmed', () => {
        expect(reportFor().split('\n').length).toBeLessThanOrEqual(24);
    });
});

describe('WebpiecesVersions — reading', () => {
    it('reads the catalog pin and the installed version', () => {
        const dirs = pair('0.4.616', '0.4.612');
        const versions = new WebpiecesVersions();
        expect(versions.forTree(dirs.main).pinned).toBe('0.4.616');
        expect(versions.forTree(dirs.main).installed).toBe('0.4.616');
        expect(versions.forTree(dirs.wt).pinned).toBe('0.4.612');
        expect(versions.forTree(dirs.wt).installed).toBeNull();
    });

    /**
     * The shape a consumer repo writes when it keeps the whole @webpieces family in lockstep: the version
     * appears ONCE, on the first family member, and every other entry aliases it. The umbrella's own value
     * is then `*wp`, not a digit — which used to read as null and silently drop the trinary compare's
     * third leg, on precisely the repos that pin most carefully.
     */
    it('follows a YAML alias to the anchor that defines the version', () => {
        const root = tmp();
        fs.writeFileSync(
            path.join(root, 'pnpm-workspace.yaml'),
            `catalog:\n  '@webpieces/core-context': &wp 0.4.634\n  '@webpieces/core-util': *wp\n  '${PKG}': *wp\n  inversify: 7.10.4\n`,
        );
        expect(new WebpiecesVersions().forTree(root).pinned).toBe('0.4.634');
    });

    /** The mirror image: the umbrella's own line is where the anchor is DEFINED. `&wp` names it, it is not it. */
    it('steps over an anchor DEFINED on the umbrella line', () => {
        const root = tmp();
        fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), `catalog:\n  '${PKG}': &wp 0.4.637\n  '@webpieces/core-util': *wp\n`);
        expect(new WebpiecesVersions().forTree(root).pinned).toBe('0.4.637');
    });

    /**
     * The repos that use an anchor also EXPLAIN it in a comment directly above the catalog, and that
     * prose contains the literal `&wp`. A bare anchor search reads the next word out of the SENTENCE —
     * which is how the first cut of this fix still returned null on the real file it was written for.
     */
    it('ignores an anchor name that appears in a comment', () => {
        const root = tmp();
        fs.writeFileSync(
            path.join(root, 'pnpm-workspace.yaml'),
            `# their version is defined ONCE via the &wp YAML anchor below and every entry aliases it.\ncatalog:\n  '@webpieces/core-context': &wp 0.4.634\n  '${PKG}': *wp\n`,
        );
        expect(new WebpiecesVersions().forTree(root).pinned).toBe('0.4.634');
    });

    /** An alias with no definition is unreadable, not a version — and unreadable must stay "no opinion". */
    it('returns null for a dangling alias rather than guessing', () => {
        const root = tmp();
        fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), `catalog:\n  '${PKG}': *missing\n`);
        expect(new WebpiecesVersions().forTree(root).pinned).toBeNull();
    });

    /** A RANGE stays null through an alias too — resolving one must not smuggle in an incomparable spec. */
    it('returns null when the anchor resolves to a range', () => {
        const root = tmp();
        fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), `catalog:\n  '@webpieces/core-util': &wp ^0.4.0\n  '${PKG}': *wp\n`);
        expect(new WebpiecesVersions().forTree(root).pinned).toBeNull();
    });

    it('quartet.inSync is true only when every readable version agrees', () => {
        const agree = pair('0.4.616', '0.4.616');
        const disagree = pair('0.4.616', '0.4.612');
        const versions = new WebpiecesVersions();
        expect(versions.quartet(agree.main, agree.wt).inSync).toBe(true);
        expect(versions.quartet(disagree.main, disagree.wt).inSync).toBe(false);
    });
});
