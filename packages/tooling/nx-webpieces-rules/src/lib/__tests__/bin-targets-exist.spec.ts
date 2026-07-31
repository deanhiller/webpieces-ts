import * as fs from 'fs';
import * as path from 'path';

/**
 * Repo-wide packaging invariant: every `bin` target declared by a workspace package must
 * exist as a real file IN GIT, before any build runs.
 *
 * WHY: pnpm `chmod`s each `bin` target while it links a package. Workspace siblings are
 * linked from their SOURCE directory (a `workspace:*` dep), and the source is TypeScript —
 * so a `bin` pointing at a compiled path under `src/` (which only exists in the published
 * tarball, where tsc compiled in place) makes EVERY `pnpm install` print
 * `WARN Failed to create bin ... ENOENT ... chmod`. Forty of those lines would hide a
 * genuine bin-link failure.
 *
 * The fix is the plain-JS shim under `bin/` (see `packages/tooling/*` `bin/*.js`). This test
 * is the guard rail that keeps someone from pointing `bin` back at compiled output.
 */

/** One `bin` entry of one workspace package, resolved to an absolute path. */
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
}

/** Roots that hold workspace packages (mirrors pnpm-workspace.yaml). */
const PACKAGE_ROOTS = ['packages', 'apps', 'libraries'];

const MAX_DEPTH = 3;

function findRepoRoot(startDir: string): string {
    let dir = startDir;
    // Walk up until we find the pnpm workspace manifest.
    while (!fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
        const parent = path.dirname(dir);
        if (parent === dir)
            throw new Error('could not locate pnpm-workspace.yaml above ' + startDir);
        dir = parent;
    }
    return dir;
}

function collectPackageJsonPaths(dir: string, depth: number, found: string[]): void {
    if (depth > MAX_DEPTH) return;
    if (!fs.existsSync(dir)) return;
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest)) found.push(manifest);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.'))
            continue;
        collectPackageJsonPaths(path.join(dir, entry.name), depth + 1, found);
    }
}

function collectBinTargets(repoRoot: string): BinTarget[] {
    const manifests: string[] = [];
    for (const root of PACKAGE_ROOTS)
        collectPackageJsonPaths(path.join(repoRoot, root), 0, manifests);

    const targets: BinTarget[] = [];
    for (const manifestPath of manifests) {
        const pkg = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (!pkg.bin || typeof pkg.bin !== 'object') continue;
        const pkgDir = path.dirname(manifestPath);
        for (const binName of Object.keys(pkg.bin)) {
            const declaredPath = String(pkg.bin[binName]);
            targets.push(
                new BinTarget(
                    String(pkg.name),
                    binName,
                    declaredPath,
                    path.resolve(pkgDir, declaredPath),
                ),
            );
        }
    }
    return targets;
}

function pointsIntoSrc(target: BinTarget): boolean {
    const normalized = target.declaredPath.replace(/^\.\//, '');
    return /(^|\/)src\//.test(normalized);
}

describe('workspace bin targets', () => {
    const repoRoot = findRepoRoot(__dirname);
    const targets = collectBinTargets(repoRoot);

    it('finds the tooling bins (sanity check that the scan actually scanned)', () => {
        expect(targets.length).toBeGreaterThan(0);
        const names = targets.map((t: BinTarget) => t.binName);
        expect(names).toContain('wp-finish-upsert-pr');
        expect(names).toContain('wp-ci');
    });

    it('every declared bin target exists on disk pre-build (no ENOENT chmod warnings on pnpm install)', () => {
        const missing = targets
            .filter((t: BinTarget) => !fs.existsSync(t.absolutePath))
            .map((t: BinTarget) => t.describeSelf());
        expect(missing).toEqual([]);
    });

    it('no bin points into src/ — src is TypeScript here and only compiles to .js in the tarball', () => {
        const intoSrc = targets.filter(pointsIntoSrc).map((t: BinTarget) => t.describeSelf());
        expect(intoSrc).toEqual([]);
    });
});
