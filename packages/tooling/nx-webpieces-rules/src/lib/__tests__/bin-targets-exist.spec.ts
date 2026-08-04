import * as fs from 'fs';
import * as path from 'path';

/**
 * Repo-wide packaging invariant, stated CONDITIONALLY — because the condition is what everyone kept
 * getting wrong.
 *
 * The hazard: pnpm `chmod`s each `bin` target while it links a package. A workspace sibling is linked
 * from its SOURCE directory, and the source here is TypeScript — the compiled `.js` under `src/` exists
 * only in the published tarball, where tsc compiled in place. So a `bin` pointing at a compiled path,
 * in a package that some sibling declares as a `workspace:` dependency, makes EVERY `pnpm install`
 * print `WARN Failed to create bin ... ENOENT ... chmod`. Enough of those hide a real bin-link failure.
 *
 * The old fix was a plain-JS shim under `bin/` for EVERY tooling package, and the old version of this
 * test enforced that unconditionally. That was wrong in the expensive direction: this repo consumes the
 * PREVIOUS RELEASE of its own tooling (root pins `@webpieces/pr-gate` at a published version, and
 * `node_modules/.bin/wp-*` resolves into that tarball), so the source-link hazard only ever applied to
 * the handful of packages a sibling actually links. Fourteen of seventeen shims existed to satisfy
 * `workspace:*` lines that were never imported — phantom dependencies — and each shim was a `.js` file
 * that had to be allow-listed out of `no-js-files` and could carry none of the repo's TypeScript rules.
 *
 * So the rule is now keyed on the real condition:
 *   - a package SOME sibling declares as `workspace:` → its bins must exist in git, i.e. be JS shims
 *   - every other package                            → its bins SHOULD point at the compiled TS
 *
 * That keeps the ENOENT protection exactly where the hazard is, and it self-heals: adding a
 * `workspace:` dep on a package whose bins point into `src/` turns this test red and names both cures.
 */

/** One `bin` entry of one workspace package, resolved to an absolute path. Data-only. */
class BinTarget {
    constructor(
        public readonly packageName: string,
        public readonly binName: string,
        public readonly declaredPath: string,
        public readonly absolutePath: string,
    ) {}

    describeSelf(): string {
        return `${this.packageName} -> bin["${this.binName}"] = ${this.declaredPath}`;
    }

    /** True when the declared path reaches into `src/`, i.e. it is compiled output, not a committed shim. */
    pointsIntoSrc(): boolean {
        return /(^|\/)src\//.test(this.declaredPath.replace(/^\.\//, ''));
    }
}

/** Roots that hold workspace packages (mirrors pnpm-workspace.yaml). */
const PACKAGE_ROOTS = ['packages', 'apps', 'libraries'];
const MAX_DEPTH = 3;

/** Scans every workspace manifest once, and answers the two questions the assertions below ask of it. */
class WorkspaceBinScan {
    private readonly manifests: string[];

    constructor(startDir: string) {
        const repoRoot = this.locateRepoRoot(startDir);
        this.manifests = [];
        for (const root of PACKAGE_ROOTS) this.collect(path.join(repoRoot, root), 0);
    }

    /** Every `bin` entry declared anywhere in the workspace. */
    binTargets(): BinTarget[] {
        const targets: BinTarget[] = [];
        for (const manifestPath of this.manifests) {
            const pkg = this.read(manifestPath);
            const bin = pkg['bin'];
            if (bin === undefined || bin === null || typeof bin !== 'object') continue;
            const pkgDir = path.dirname(manifestPath);
            for (const binName of Object.keys(bin)) {
                const declaredPath = String((bin as Record<string, unknown>)[binName]);
                targets.push(new BinTarget(
                    String(pkg['name']), binName, declaredPath, path.resolve(pkgDir, declaredPath)));
            }
        }
        return targets;
    }

    /**
     * The package NAMES that some other workspace package declares with a `workspace:` specifier — i.e.
     * exactly the packages pnpm links from their source directory, and therefore the only ones the
     * ENOENT-chmod hazard can touch.
     */
    sourceLinkedPackages(): Set<string> {
        const linked = new Set<string>();
        for (const manifestPath of this.manifests) {
            const pkg = this.read(manifestPath);
            for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
                const deps = pkg[field];
                if (deps === undefined || deps === null || typeof deps !== 'object') continue;
                for (const [name, spec] of Object.entries(deps as Record<string, unknown>)) {
                    if (typeof spec === 'string' && spec.startsWith('workspace:')) linked.add(name);
                }
            }
        }
        return linked;
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
    const sourceLinked = scan.sourceLinkedPackages();
    const linkedTargets = (): BinTarget[] => targets.filter((t: BinTarget) => sourceLinked.has(t.packageName));

    it('finds the tooling bins (sanity check that the scan actually scanned)', () => {
        expect(targets.length).toBeGreaterThan(0);
        const names = targets.map((t: BinTarget) => t.binName);
        expect(names).toContain('wp-finish-upsert-pr');
        expect(names).toContain('wp-ci');
    });

    // The scan is only meaningful if it can actually tell the two groups apart. code-rules is genuinely
    // imported by nx-webpieces-rules, so it must be in the linked set; pr-gate is consumed as a published
    // release only, so it must not be.
    it('distinguishes source-linked packages from released-only ones', () => {
        expect(sourceLinked.has('@webpieces/code-rules')).toBe(true);
        expect(sourceLinked.has('@webpieces/pr-gate')).toBe(false);
    });

    /**
     * THE invariant. Scoped to source-linked packages: those are linked from a TypeScript source dir that
     * holds no compiled output, so their bin targets must be committed shims or `pnpm install` warns.
     */
    it('every bin of a source-linked package exists in git pre-build (no ENOENT chmod on pnpm install)', () => {
        const missing = linkedTargets()
            .filter((t: BinTarget) => !fs.existsSync(t.absolutePath))
            .map((t: BinTarget) => t.describeSelf());
        expect(missing).toEqual([]);
    });

    it('no bin of a source-linked package points into src/ — that path is empty until the tarball', () => {
        const intoSrc = linkedTargets().filter((t: BinTarget) => t.pointsIntoSrc()).map((t: BinTarget) => t.describeSelf());
        expect(intoSrc).toEqual([]);
    });

    /**
     * The other direction, and the reason 15 shims could be deleted: a package nobody links from source has
     * no hazard to protect against, so a JS shim there is pure overhead — an extra file outside TypeScript,
     * exempted from every rule the repo enforces. Point the bin at the compiled entry instead.
     */
    it('a package nobody source-links points its bins at compiled TypeScript, not a committed shim', () => {
        const shimmed = targets
            .filter((t: BinTarget) => !sourceLinked.has(t.packageName) && !t.pointsIntoSrc())
            .map((t: BinTarget) => t.describeSelf());
        expect(shimmed).toEqual([]);
    });
});
