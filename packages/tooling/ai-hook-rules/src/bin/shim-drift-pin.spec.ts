import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { renderShim } from './shim';
import { ShimTestkit } from './shim-testkit';

/**
 * WHERE L0 LEARNS THE PIN, AND WHOSE PIN IT IS — split out of shim-drift.spec.ts, which hit the
 * file-size limit.
 *
 * Two questions, one subject. `catalog:` specs carry no digit-version in package.json, so the scraper
 * has to resolve them somewhere — pnpm-workspace.yaml first, pnpm-lock.yaml as the fallback. And the
 * pin it resolves belongs to ONE tree: when the guard binary was inherited from another tree by
 * walking up, the disagreement is CROSS-TREE and belongs to L1 row 8, not to fault D.
 */

const kit = new ShimTestkit();

/**
 * pnpm CATALOGS. When a repo pins @webpieces via a catalog (`"@webpieces/pr-gate": "catalog:"`) there is
 * NO digit-version in package.json for the scraper to see — the guard was BLIND to it, so DRIFT_PKG
 * stayed empty and the stale bin ran (the 2026-07 "0.3.369 vs 0.4.405" incident). The fix resolves
 * `catalog:` / `catalog:<name>` through pnpm-lock.yaml's top-level `catalogs:` block before comparing.
 */
function stageCatalogRoot(spec: string, catalogsYaml: string, installed: string): string {
    const root = kit.mktmp();
    const binDir = path.join(root, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'wp-ai-guards-hook'), '#!/bin/sh\nprintf EXECED\n', { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'package.json'),
        JSON.stringify({ dependencies: { '@webpieces/pr-gate': spec } }, null, 2) + '\n');
    fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), catalogsYaml);
    const manifestDir = path.join(root, 'node_modules', '@webpieces', 'pr-gate');
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(path.join(manifestDir, 'package.json'),
        JSON.stringify({ name: '@webpieces/pr-gate', version: installed }, null, 2) + '\n');
    return root;
}

// A pnpm-lock.yaml v9 fragment whose top-level `catalogs:` block pins pr-gate in a default and a named
// catalog — the exact shape the shim's awk pass walks (catalog → pkg → version, 2-space indented).
const LOCK_CATALOGS = `lockfileVersion: '9.0'

catalogs:
  default:
    '@webpieces/pr-gate':
      specifier: 0.4.405
      version: 0.4.405
  legacy:
    '@webpieces/pr-gate':
      specifier: 0.3.1
      version: 0.3.1

importers:
  .: {}
`;

describe('version-drift guard — resolving pnpm CATALOG specs (the catalog-blind bug)', () => {
    it('DENIES when a bare `catalog:` pin (resolved via the default catalog) drifts from node_modules', () => {
        const out = kit.runShim(stageCatalogRoot('catalog:', LOCK_CATALOGS, '0.3.369'), 'wp-ai-guards-hook', kit.bashPayload('pnpm build'));
        expect(out.stdout).not.toContain('EXECED'); // the stale bin was NOT run — the guard was NOT blind
        expect(out.isDenied()).toBe(true);
        const reason = out.denyReason();
        expect(reason).toContain('version drift');
        expect(reason).toContain('@webpieces/pr-gate@0.4.405'); // declared side, resolved from the catalog
        expect(reason).toContain('0.3.369');                    // installed side
    });

    it('resolves a NAMED catalog (`catalog:legacy`) to that catalog\'s version, not the default', () => {
        const out = kit.runShim(stageCatalogRoot('catalog:legacy', LOCK_CATALOGS, '0.4.405'), 'wp-ai-guards-hook', kit.bashPayload('pnpm build'));
        expect(out.isDenied()).toBe(true);
        expect(out.denyReason()).toContain('@webpieces/pr-gate@0.3.1'); // the legacy catalog, not 0.4.405
    });

    it('execs the bin (no drift) when the catalog-resolved version matches what is installed', () => {
        const out = kit.runShim(stageCatalogRoot('catalog:', LOCK_CATALOGS, '0.4.405'), 'wp-ai-guards-hook', kit.bashPayload('pnpm build'));
        expect(out.stdout).toBe('EXECED');
    });

    it('does NOT false-positive when the catalog cannot be resolved (unknown catalog name → skip)', () => {
        const out = kit.runShim(stageCatalogRoot('catalog:doesnotexist', LOCK_CATALOGS, '0.4.405'), 'wp-ai-guards-hook', kit.bashPayload('pnpm build'));
        expect(out.stdout).toBe('EXECED'); // best-effort: a spec we cannot resolve is skipped, never guessed
    });

    it('does NOT false-positive when there is no lockfile to resolve the catalog against', () => {
        const root = stageCatalogRoot('catalog:', LOCK_CATALOGS, '0.3.369');
        fs.rmSync(path.join(root, 'pnpm-lock.yaml'));
        expect(kit.runShim(root, 'wp-ai-guards-hook', kit.bashPayload('pnpm build')).stdout).toBe('EXECED');
    });
});

/**
 * THE PIN LIVES IN pnpm-workspace.yaml, and the lock is only the fallback.
 *
 * L0 used to learn a `catalog:` pin from pnpm-lock.yaml alone while L1's `WebpiecesVersions.readPin`
 * read pnpm-workspace.yaml — two notions of "the pin", and the gap is exactly where the cure lands. An
 * agent told to raise this tree's pin edits the workspace manifest, re-runs, and L0 still reports the
 * OLD number (only `pnpm install` rewrites the lock), so it concludes its edit did nothing.
 */
describe('version-drift guard — reading the pin from pnpm-workspace.yaml', () => {
    function stageWorkspacePin(workspaceYaml: string, lockYaml: string, installed: string): string {
        const root = kit.mktmp();
        const binDir = path.join(root, 'node_modules', '.bin');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(path.join(binDir, 'wp-ai-guards-hook'), '#!/bin/sh\nprintf EXECED\n', { mode: 0o755 });
        fs.writeFileSync(path.join(root, 'package.json'),
            JSON.stringify({ dependencies: { '@webpieces/pr-gate': 'catalog:' } }, null, 2) + '\n');
        fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), workspaceYaml);
        fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), lockYaml);
        const manifestDir = path.join(root, 'node_modules', '@webpieces', 'pr-gate');
        fs.mkdirSync(manifestDir, { recursive: true });
        fs.writeFileSync(path.join(manifestDir, 'package.json'),
            JSON.stringify({ name: '@webpieces/pr-gate', version: installed }, null, 2) + '\n');
        return root;
    }

    // The workspace manifest says 0.4.500; the lock still carries the pre-edit 0.4.405. The freshly
    // edited pin is the one that must be reported, or the edit looks like a no-op.
    const EDITED_WORKSPACE = `packages:\n  - packages/*\n\ncatalog:\n  '@webpieces/pr-gate': 0.4.500\n`;

    it('prefers the workspace manifest over the lock, so a pin edit is visible immediately', () => {
        const reason = kit.runShim(stageWorkspacePin(EDITED_WORKSPACE, LOCK_CATALOGS, '0.4.405'),
            'wp-ai-guards-hook', kit.bashPayload('pnpm build')).denyReason();
        expect(reason).toContain('@webpieces/pr-gate@0.4.500'); // the EDITED pin, not the lock's 0.4.405
    });

    it('clears the block once the edited pin matches what is installed', () => {
        const out = kit.runShim(stageWorkspacePin(EDITED_WORKSPACE, LOCK_CATALOGS, '0.4.500'),
            'wp-ai-guards-hook', kit.bashPayload('pnpm build'));
        expect(out.stdout).toBe('EXECED');
    });

    /**
     * The shape a repo writes when it pins the whole @webpieces family in lockstep: the version appears
     * ONCE as `&wp`, every other entry aliases it. An anchor-blind read nulls the leg on precisely the
     * repos that pin most carefully — `readPin` learned this the hard way and so must the sh twin.
     */
    it('follows a YAML alias to the anchor that defines the version', () => {
        const yaml = `catalog:\n  '@webpieces/core-util': &wp 0.4.500\n  '@webpieces/pr-gate': *wp\n`;
        const reason = kit.runShim(stageWorkspacePin(yaml, LOCK_CATALOGS, '0.4.405'),
            'wp-ai-guards-hook', kit.bashPayload('pnpm build')).denyReason();
        expect(reason).toContain('@webpieces/pr-gate@0.4.500');
    });

    it('steps over an anchor DEFINED on the umbrella line', () => {
        const yaml = `catalog:\n  '@webpieces/pr-gate': &wp 0.4.500\n  '@webpieces/core-util': *wp\n`;
        const reason = kit.runShim(stageWorkspacePin(yaml, LOCK_CATALOGS, '0.4.405'),
            'wp-ai-guards-hook', kit.bashPayload('pnpm build')).denyReason();
        expect(reason).toContain('@webpieces/pr-gate@0.4.500');
    });

    it('resolves a NAMED catalog from the workspace manifest too', () => {
        const root = kit.mktmp();
        const binDir = path.join(root, 'node_modules', '.bin');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(path.join(binDir, 'wp-ai-guards-hook'), '#!/bin/sh\nprintf EXECED\n', { mode: 0o755 });
        fs.writeFileSync(path.join(root, 'package.json'),
            JSON.stringify({ dependencies: { '@webpieces/pr-gate': 'catalog:legacy' } }, null, 2) + '\n');
        fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'),
            `catalogs:\n  legacy:\n    '@webpieces/pr-gate': 0.4.501\n`);
        const manifestDir = path.join(root, 'node_modules', '@webpieces', 'pr-gate');
        fs.mkdirSync(manifestDir, { recursive: true });
        fs.writeFileSync(path.join(manifestDir, 'package.json'),
            JSON.stringify({ name: '@webpieces/pr-gate', version: '0.4.405' }, null, 2) + '\n');
        expect(kit.runShim(root, 'wp-ai-guards-hook', kit.bashPayload('pnpm build')).denyReason())
            .toContain('@webpieces/pr-gate@0.4.501');
    });

    /** A RANGE cannot be compared for equality, so the workspace read must decline and fall back. */
    it('falls back to the lock when the workspace pin is a RANGE rather than a version', () => {
        const yaml = `catalog:\n  '@webpieces/pr-gate': ^0.4.0\n`;
        const out = kit.runShim(stageWorkspacePin(yaml, LOCK_CATALOGS, '0.4.405'), 'wp-ai-guards-hook', kit.bashPayload('pnpm build'));
        expect(out.stdout).toBe('EXECED'); // the lock resolves 0.4.405, which is what is installed
    });

    it('falls back to the lock when there is no catalog entry in the workspace manifest', () => {
        const yaml = `packages:\n  - packages/*\n`;
        const out = kit.runShim(stageWorkspacePin(yaml, LOCK_CATALOGS, '0.3.369'), 'wp-ai-guards-hook', kit.bashPayload('pnpm build'));
        expect(out.isDenied()).toBe(true);
        expect(out.denyReason()).toContain('@webpieces/pr-gate@0.4.405'); // resolved from the lock
    });
});

/**
 * A BORROWED BIN IS NOT SINGLE-TREE DRIFT — the defect this change exists to close.
 *
 * `RESOLVE_BIN_SH` walks UP for the bin, so a linked worktree with no node_modules of its own runs the
 * MAIN tree's binary. The drift scan then compared THIS tree's declared pin against THAT tree's
 * installed version and reported it as fault D. Its cure, `pnpm install`, cannot "align node_modules"
 * in a tree that has none — it MANUFACTURES one at the stale pin, which is precisely the state L1 row 8
 * blocks. And because ai-hook.sh hard-exits on any sh-side fault, row 8 — which reads all four versions
 * and knows the direction — never ran.
 *
 * So L0 now stays silent when the bin came from another tree, and the binary is allowed to run.
 */
describe('version-drift guard — a BORROWED bin is L1 row 8s question, not fault D', () => {
    /** A parent tree that owns the bin, and a child tree that declares a DIFFERENT version and owns none. */
    function stageBorrowed(childDeclared: string, parentInstalled: string): string {
        const parent = kit.mktmp();
        const binDir = path.join(parent, 'node_modules', '.bin');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(path.join(binDir, 'wp-ai-guards-hook'), '#!/bin/sh\nprintf EXECED\n', { mode: 0o755 });
        const manifestDir = path.join(parent, 'node_modules', '@webpieces', 'pr-gate');
        fs.mkdirSync(manifestDir, { recursive: true });
        fs.writeFileSync(path.join(manifestDir, 'package.json'),
            JSON.stringify({ name: '@webpieces/pr-gate', version: parentInstalled }, null, 2) + '\n');
        const child = path.join(parent, '.claude', 'worktrees', 'wt');
        fs.mkdirSync(child, { recursive: true });
        fs.writeFileSync(path.join(child, 'package.json'),
            JSON.stringify({ dependencies: { '@webpieces/pr-gate': childDeclared } }, null, 2) + '\n');
        return child;
    }

    it('does NOT raise fault D when the bin was inherited from another tree — it lets the bin run', () => {
        const out = kit.runShim(stageBorrowed('0.3.270', '0.3.272'), 'wp-ai-guards-hook', kit.bashPayload('pnpm build'));
        expect(out.isDenied()).toBe(false);
        expect(out.stdout).toBe('EXECED'); // the binary ran, so L1 row 8 gets to answer
    });

    it('does not raise it in the other direction either — direction is row 8s to decide', () => {
        const out = kit.runShim(stageBorrowed('0.3.272', '0.3.270'), 'wp-ai-guards-hook', kit.bashPayload('pnpm build'));
        expect(out.stdout).toBe('EXECED');
    });

    /** Same tree, same disagreement: D still fires. Row 8 cannot see a single-tree pin-vs-install skew. */
    it('still raises D for a SINGLE tree, where row 8 has nothing to compare', () => {
        const out = kit.runShim(kit.stageDriftRoot('0.3.272', '0.3.270'), 'wp-ai-guards-hook', kit.bashPayload('pnpm build'));
        expect(out.isDenied()).toBe(true);
        expect(out.denyReason()).toContain('version drift');
    });

    /** The borrow note that contradicted the option it was attached to is gone from the whole shim. */
    it('renders no borrowed-node_modules note anywhere', () => {
        expect(renderShim()).not.toContain('WP_BORROW_NOTE');
        expect(renderShim()).not.toContain('has NO node_modules of its own');
    });
});
