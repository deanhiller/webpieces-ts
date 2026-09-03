import * as fs from 'fs';
import * as path from 'path';

/**
 * WHAT AN INSTALL MATERIALIZES, NOT WHAT A MANIFEST DECLARES.
 *
 * This file exists because its two neighbours could not have caught either of the incidents they were
 * written for. `bin-targets-exist.spec.ts` reads every workspace manifest and asserts the `bin` blocks
 * are well-formed. `umbrella-bundles-all.spec.ts` reads the umbrella's `dependencies` and asserts every
 * tooling package is named there. Both are manifest tests, both are correct, and BOTH STAYED GREEN
 * through the two times `wp-ai-guards-hook` actually went missing from `node_modules/.bin`:
 *
 *   #585 — the umbrella's dependency on `@webpieces/ai-hook-rules` was deleted as a phantom (nothing
 *          imports it; its BINS are the product). One release later the package was gone from every
 *          consumer's tree and the L0 shim blocked every tool call while prescribing a `pnpm install`
 *          that could not help — fault `U`. umbrella-bundles-all.spec.ts was written to stop a REPEAT
 *          of that deletion, and it does; but it reads the manifest, so it says nothing about whether
 *          the install that manifest describes actually produced a bin.
 *
 *   this one — the manifests were all CORRECT and the tree was still broken. #737 added
 *          `"@webpieces/ai-hook-rules": "workspace:*"` to packages/tooling/pr-gate/package.json, while
 *          the catalog still pinned 0.4.714, whose PUBLISHED `@webpieces/pr-gate` carried no such
 *          dependency (0.4.720's does — the publish pipeline rewrites `workspace:*` to a registry
 *          version correctly). For that one-release window `node_modules/@webpieces/ai-hook-rules` came
 *          out EMPTY under `node-linker=hoisted`, and every manifest check in the repo was green.
 *
 * The shared shape is the lesson: a declaration is an intention, and every check we had tested the
 * intention. The only thing that can catch a materialization failure is looking at the disk. So this
 * file stats files and follows symlinks — it asserts nothing about any manifest's contents beyond
 * using the installed umbrella as the LIST of what should be on disk.
 *
 * CHEAP ON PURPOSE — it must be able to run on every CI job. It performs no install, spawns no process
 * and hits the network never; it is a handful of `fs.existsSync` calls against the tree it is already
 * running in. It inspects the install it FINDS, and does not create one.
 *
 * WHERE IT LOOKS, and why it walks up. A linked worktree legitimately has no `node_modules` of its own:
 * `git worktree add` copies none, and until something installs there the tree resolves `@webpieces/*`
 * by walking up to the primary clone's install and running the primary's binary (`.claude/rules/published-vs-local-source.md`,
 * "A linked
 * worktree does not get its own RELEASE"). Resolving the same way the RUNTIME does is therefore the
 * faithful check — it asks the question the shim asks. If no `node_modules` exists anywhere up the
 * chain then nothing has ever been installed for this tree, there is no install to judge, and the
 * suite SKIPS RATHER THAN PASSES — a skipped test is visible in the reporter, whereas a green one here
 * would be the precise failure mode this file was written to end.
 */

/**
 * Bins whose absence is the incident itself. Named explicitly, because the property test below would
 * also pass if the umbrella stopped declaring the package that ships them — which is what #585 did.
 */
const INCIDENT_BINS = ['wp-ai-guards-hook', 'wp-ai-rules-hook', 'wp-build', 'wp-start-upsert-pr'];

const UMBRELLA = '@webpieces/nx-webpieces-rules';

/** One bin that some installed package declares, resolved to where the installer should have put it. */
class ExpectedBin {
    constructor(
        public readonly packageName: string,
        public readonly binName: string,
        public readonly linkPath: string,
    ) {}

    /** Present AND resolvable. `existsSync` follows symlinks, so a dangling link is correctly absent. */
    isMaterialized(): boolean {
        return fs.existsSync(this.linkPath) || fs.existsSync(this.linkPath + '.cmd');
    }

    /**
     * Distinguishes "the installer never wrote it" from "it wrote a link whose target is gone" — two
     * different bugs that present identically to `existsSync`. `throwIfNoEntry` keeps this a plain
     * lookup rather than exception control flow.
     */
    describeSelf(): string {
        const link = fs.lstatSync(this.linkPath, { throwIfNoEntry: false });
        const state = link === undefined ? 'missing' : 'DANGLING symlink (target does not exist)';
        return `${this.binName} (from ${this.packageName}) -> ${this.linkPath} [${state}]`;
    }
}

/** Finds the install that governs this tree and reports what it did and did not materialize. */
class InstalledTreeScan {
    /** The node_modules the runtime would resolve from here, or null when nothing is installed. */
    readonly nodeModules: string | null;

    constructor(startDir: string) {
        this.nodeModules = this.locateNodeModules(this.locateRepoRoot(startDir));
    }

    /** The @webpieces packages the INSTALLED umbrella asks for. Empty when the umbrella itself is absent. */
    umbrellaWebpiecesDeps(): string[] {
        const manifest = this.packageManifestPath(UMBRELLA);
        if (manifest === null || !fs.existsSync(manifest)) return [];
        const deps = this.read(manifest)['dependencies'];
        const asObject = (typeof deps === 'object' && deps !== null) ? deps as Record<string, unknown> : {};
        return Object.keys(asObject).filter((name: string) => name.startsWith('@webpieces/')).sort();
    }

    /** Names from `expected` that have no directory in node_modules — the #585 / hoist-collision shape. */
    missingPackages(expected: string[]): string[] {
        return expected.filter((name: string) => {
            const dir = this.packageDir(name);
            return dir === null || !fs.existsSync(dir);
        });
    }

    /** Every bin declared by every installed package in `names`, as the installer should have linked it. */
    expectedBins(names: string[]): ExpectedBin[] {
        const bins: ExpectedBin[] = [];
        for (const name of names) {
            const manifest = this.packageManifestPath(name);
            if (manifest === null || !fs.existsSync(manifest)) continue;
            const bin = this.read(manifest)['bin'];
            if (typeof bin !== 'object' || bin === null) continue;
            for (const binName of Object.keys(bin as Record<string, unknown>)) {
                bins.push(new ExpectedBin(name, binName, path.join(this.binDir(), binName)));
            }
        }
        return bins;
    }

    binDir(): string {
        return path.join(String(this.nodeModules), '.bin');
    }

    private packageDir(name: string): string | null {
        return this.nodeModules === null ? null : path.join(this.nodeModules, ...name.split('/'));
    }

    private packageManifestPath(name: string): string | null {
        const dir = this.packageDir(name);
        return dir === null ? null : path.join(dir, 'package.json');
    }

    // webpieces-disable no-any-unknown -- opaque package.json; every field is narrowed at its use site
    private read(manifestPath: string): Record<string, unknown> {
        return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    }

    /**
     * The TREE root, found the same way the sibling specs find it. The walk for node_modules has to
     * start here and not at `__dirname`: `.npmrc` sets `node-linker=hoisted`, so the whole dependency
     * graph lands in ONE flat node_modules at the tree root, while individual projects may still carry
     * a small local node_modules of their own. Starting the walk deeper finds one of those and checks a
     * directory that was never meant to hold the toolchain — which is a false RED, the one failure mode
     * a regression test must not have.
     */
    private locateRepoRoot(startDir: string): string {
        let dir = startDir;
        while (!fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
            const parent = path.dirname(dir);
            if (parent === dir) throw new Error('could not locate pnpm-workspace.yaml above ' + startDir);
            dir = parent;
        }
        return dir;
    }

    /**
     * The RUNTIME's own resolution: nearest node_modules walking up FROM THE TREE ROOT. That is how a
     * linked worktree ends up governed by the primary clone's install, so checking any other directory
     * would be checking a tree nothing actually loads from.
     */
    private locateNodeModules(startDir: string): string | null {
        let dir = startDir;
        for (;;) {
            const candidate = path.join(dir, 'node_modules');
            if (fs.existsSync(candidate)) return candidate;
            const parent = path.dirname(dir);
            if (parent === dir) return null;
            dir = parent;
        }
    }
}

const scan = new InstalledTreeScan(__dirname);

// Stated out loud rather than silently passing: with nothing installed anywhere above this file there
// is no install to judge. `describe.skipIf` reports these as SKIPPED in the reporter, which is the
// visible signal — a green run here would be the exact blind spot this file exists to remove.
describe.skipIf(scan.nodeModules === null)('the install materializes the bins the guards need', () => {
    const declared = scan.umbrellaWebpiecesDeps();

    it('found an installed umbrella to check against (sanity check that the scan actually scanned)', () => {
        expect(scan.nodeModules, 'no node_modules resolved from this file').not.toBeNull();
        expect(declared, `${UMBRELLA} is not installed in ${String(scan.nodeModules)}`).not.toEqual([]);
    });

    /**
     * THE #585 SHAPE. The umbrella names a package; the installer must have put a directory there. When
     * the umbrella's dependency was deleted this list is what went non-empty on the consumer's next
     * install — and it is also what went non-empty in the hoist collision, where the manifest still
     * named the package and the directory came out empty anyway. One assertion, both incidents.
     */
    it('materializes a directory for every @webpieces package the umbrella declares', () => {
        const missing = scan.missingPackages(declared);
        expect(missing, `declared by ${UMBRELLA} but absent from ${String(scan.nodeModules)} — `
            + 'the manifest is not the tree; see this file`s header').toEqual([]);
    });

    /**
     * THE PROPERTY, and it needs no list to maintain: whatever bins the installed packages declare must
     * be linked. Publish a package with a new bin and this covers it automatically, which is the right
     * default — a bin a consumer cannot execute is not shipped.
     */
    it('links every bin those packages declare into node_modules/.bin', () => {
        const notLinked = scan.expectedBins(declared)
            .filter((b: ExpectedBin) => !b.isMaterialized())
            .map((b: ExpectedBin) => b.describeSelf());
        expect(notLinked, 'declared in a published manifest but never linked by the installer').toEqual([]);
    });

    /**
     * The named anchors. The property above is stated over what the umbrella CURRENTLY declares, so it
     * would go quietly green again if a package stopped being declared at all — which is precisely the
     * #585 deletion. These four are checked against the disk unconditionally.
     */
    it('links the bins whose absence deadlocks every tool call', () => {
        for (const binName of INCIDENT_BINS) {
            const link = path.join(scan.binDir(), binName);
            expect(fs.existsSync(link) || fs.existsSync(link + '.cmd'),
                `${binName} is not in ${scan.binDir()} — .claude/settings.json still registers its `
                + 'hooks, so the L0 shim will block every tool call (fault U)').toBe(true);
        }
    });
});
