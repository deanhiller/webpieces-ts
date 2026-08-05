import * as fs from 'fs';
import * as path from 'path';

/**
 * THE PACKAGING INVARIANT THAT MAKES BIN SHIMS IMPOSSIBLE.
 *
 * The hazard, first: pnpm `chmod`s every `bin` target while it links a package. A `workspace:` sibling
 * is linked from its SOURCE directory, and the source here is TypeScript — the compiled `.js` under
 * `src/` exists only in the published tarball, where tsc compiled in place. So a `bin` pointing at
 * compiled output, in a package some sibling declares `workspace:`, makes EVERY `pnpm install` print
 * `WARN Failed to create bin … ENOENT … chmod`. Measured on this workspace: 28 of them.
 *
 * That hazard was fought twice, and both cures were worse than the disease:
 *
 *   1. A committed plain-JS shim per bin. Seventeen `.js` files exempted from `no-js-files` and
 *      carrying none of the TypeScript rules this repo enforces.
 *   2. Dropping the `workspace:` dependency instead. That is what removed `@webpieces/ai-hook-rules`
 *      and `@webpieces/pr-gate` from the umbrella (they were read as phantom — nothing imports them),
 *      which deleted them from every consumer's tree on the next release and took `wp-ai-guards-hook`
 *      with them. See umbrella-bundles-all.spec.ts.
 *
 * THE CURE IS TO MOVE THE `bin` OUT OF THE SOURCE MANIFEST. pnpm hoists `publishConfig.bin` into `bin`
 * when it packs, so the TARBALL has exactly the bins consumers need, while the source manifest declares
 * none — and a `bin` that does not exist during install is a `bin` pnpm never tries to chmod. Verified
 * by packing: `publishConfig.bin` in source, top-level `bin` in the tarball.
 *
 * So both constraints hold at once, with no trade:
 *   - tooling packages depend on each other with `workspace:*` → built against local source, and the
 *     architecture graph draws nx-webpieces-rules above its children,
 *   - `pnpm install` is silent, and there are NO shims to allow-list anywhere.
 */

/** Roots that hold workspace packages (mirrors pnpm-workspace.yaml). */
const PACKAGE_ROOTS = ['packages', 'apps', 'libraries'];
const MAX_DEPTH = 3;

/** One declared bin of one workspace package, resolved to an absolute path. Data-only. */
class BinTarget {
    constructor(
        public readonly packageName: string,
        public readonly binName: string,
        public readonly declaredPath: string,
        public readonly absolutePath: string,
        /** True when it sits in the source manifest's `bin` rather than `publishConfig.bin`. */
        public readonly topLevel: boolean,
    ) {}

    describeSelf(): string {
        const field = this.topLevel ? 'bin' : 'publishConfig.bin';
        return `${this.packageName} -> ${field}["${this.binName}"] = ${this.declaredPath}`;
    }

    /** True when the declared path reaches into `src/`, i.e. compiled output rather than a shim. */
    pointsIntoSrc(): boolean {
        return /(^|\/)src\//.test(this.declaredPath.replace(/^\.\//, ''));
    }
}

/** Scans every workspace manifest once and answers the questions the assertions below ask of it. */
class WorkspaceBinScan {
    private readonly manifests: string[];

    constructor(startDir: string) {
        const repoRoot = this.locateRepoRoot(startDir);
        this.manifests = [];
        for (const root of PACKAGE_ROOTS) this.collect(path.join(repoRoot, root), 0);
    }

    /** Every bin declared anywhere in the workspace, from either field. */
    binTargets(): BinTarget[] {
        const targets: BinTarget[] = [];
        for (const manifestPath of this.manifests) {
            const pkg = this.read(manifestPath);
            const publishConfig = this.asObject(pkg['publishConfig']);
            targets.push(...this.targetsIn(pkg, manifestPath, this.asObject(pkg['bin']), true));
            targets.push(...this.targetsIn(pkg, manifestPath, this.asObject(publishConfig['bin']), false));
        }
        return targets;
    }

    /** The names some other workspace package declares with a `workspace:` specifier. */
    sourceLinkedPackages(): Set<string> {
        const linked = new Set<string>();
        for (const manifestPath of this.manifests) {
            const pkg = this.read(manifestPath);
            for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
                const deps = this.asObject(pkg[field]);
                for (const name of Object.keys(deps)) {
                    if (String(deps[name]).startsWith('workspace:')) linked.add(name);
                }
            }
        }
        return linked;
    }

    private targetsIn(
        pkg: Record<string, unknown>, manifestPath: string,
        bin: Record<string, unknown>, topLevel: boolean,
    ): BinTarget[] {
        const pkgDir = path.dirname(manifestPath);
        return Object.keys(bin).map((binName: string): BinTarget => {
            const declaredPath = String(bin[binName]);
            return new BinTarget(String(pkg['name']), binName, declaredPath,
                path.resolve(pkgDir, declaredPath), topLevel);
        });
    }

    // webpieces-disable no-any-unknown -- opaque package.json; every field is narrowed at its use site
    private asObject(value: unknown): Record<string, unknown> {
        return (typeof value === 'object' && value !== null) ? value as Record<string, unknown> : {};
    }

    // webpieces-disable no-any-unknown -- opaque package.json; every field is narrowed at its use site
    private read(manifestPath: string): Record<string, unknown> {
        return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    }

    private locateRepoRoot(startDir: string): string {
        let dir = startDir;
        while (!fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
            const parent = path.dirname(dir);
            if (parent === dir) throw new Error('could not locate pnpm-workspace.yaml above ' + startDir);
            dir = parent;
        }
        return dir;
    }

    private collect(dir: string, depth: number): void {
        if (depth > MAX_DEPTH || !fs.existsSync(dir)) return;
        const manifest = path.join(dir, 'package.json');
        if (fs.existsSync(manifest)) this.manifests.push(manifest);
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
            this.collect(path.join(dir, entry.name), depth + 1);
        }
    }
}

describe('workspace bin targets', () => {
    const scan = new WorkspaceBinScan(__dirname);
    const targets = scan.binTargets();

    it('finds the tooling bins (sanity check that the scan actually scanned)', () => {
        expect(targets.length).toBeGreaterThan(0);
        const names = targets.map((t: BinTarget) => t.binName);
        expect(names).toContain('wp-finish-upsert-pr');
        expect(names).toContain('wp-ci');
    });

    /**
     * THE invariant, and it needs no per-package condition: a bin declared in `publishConfig.bin` is
     * invisible to the installer, so the ENOENT-chmod hazard cannot exist no matter which packages are
     * `workspace:`-linked. That is what lets the tooling keep its workspace edges for free.
     */
    it('declares every bin in publishConfig.bin, never in the source manifest`s bin', () => {
        const topLevel = targets.filter((t: BinTarget) => t.topLevel).map((t: BinTarget) => t.describeSelf());
        expect(topLevel, 'move it to publishConfig.bin — pnpm hoists it into bin when it packs').toEqual([]);
    });

    /**
     * The other half: a bin must point at COMPILED TYPESCRIPT, never at a committed `.js` shim. Together
     * with the assertion above this is what makes shims structurally impossible rather than merely
     * discouraged — there is no longer any install-time pressure that would justify one.
     */
    it('points every bin at compiled TypeScript under src/, never at a committed shim', () => {
        const shimmed = targets.filter((t: BinTarget) => !t.pointsIntoSrc()).map((t: BinTarget) => t.describeSelf());
        expect(shimmed, 'shims are gone for good — see this file`s header').toEqual([]);
    });

    // Anchored at the package root on purpose: `src/bin/…` is ordinary TypeScript source (ai-hook-rules
    // keeps its entry points there), while a TOP-LEVEL `bin/` is the shim directory this repo deleted.
    it('no package ships a top-level bin/ directory of committed shims', () => {
        const withShimDir = targets
            .filter((t: BinTarget) => /^bin\//.test(t.declaredPath.replace(/^\.\//, '')))
            .map((t: BinTarget) => t.describeSelf());
        expect(withShimDir).toEqual([]);
    });

    // The tooling is built against local source, which is what puts nx-webpieces-rules above its five
    // children in architecture/dependencies.json. If this goes empty, those edges went with it.
    it('keeps the tooling packages source-linked, so the build and the graph use local code', () => {
        const linked = scan.sourceLinkedPackages();
        for (const name of ['@webpieces/ai-hook-rules', '@webpieces/code-rules',
            '@webpieces/eslint-rules', '@webpieces/pr-gate', '@webpieces/rules-config']) {
            expect(linked, `${name} must stay a workspace: dep of the umbrella`).toContain(name);
        }
    });
});
