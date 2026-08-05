import * as fs from 'fs';
import * as path from 'path';

/**
 * THE UMBRELLA INVARIANT — a consumer declares ONE package and gets the whole toolchain.
 *
 * `@webpieces/nx-webpieces-rules` is tagged `role:bundle` for exactly this reason: a consumer repo puts
 * one line in its package.json and every `wp-*` bin, every eslint rule and every nx executor arrives
 * with it. That aggregation IS the package's product, and it lives entirely in the `dependencies`
 * block — there is no import to point at.
 *
 * WHICH IS WHY THIS TEST EXISTS. A dependency nothing imports reads exactly like a phantom, and a
 * cleanup that trusted "no import ⇒ unused" deleted `@webpieces/ai-hook-rules` and `@webpieces/pr-gate`
 * from this manifest. Both were doing real work: `ai-hook-rules` ships `wp-ai-guards-hook`, which every
 * consumer's `.claude/settings.json` invokes on every tool call. On the next release the package left
 * every consumer's tree entirely, the bin vanished from `node_modules/.bin`, and the L0 shim blocked
 * every Bash/Write/Edit while prescribing a `pnpm install` that could not help — nothing asked for the
 * package any more (fault `U`).
 *
 * So the rule is stated as a property of the workspace rather than a list to maintain: EVERY tooling
 * package is bundled. Add one under `packages/tooling/` and this turns red until the umbrella carries
 * it, which is the correct default — a tooling package a consumer cannot reach is not shipped.
 */

const UMBRELLA = '@webpieces/nx-webpieces-rules';
const TOOLING_DIR = 'packages/tooling';

// webpieces-disable no-any-unknown -- opaque package.json; every field is narrowed at its use site
type Manifest = Record<string, unknown>;

/** Reads the workspace's tooling manifests and answers what the umbrella must declare. */
class ToolingScan {
    readonly repoRoot: string;

    constructor(startDir: string) {
        this.repoRoot = this.locateRepoRoot(startDir);
    }

    read(manifestPath: string): Manifest {
        return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest;
    }

    /** Every publishable package name under packages/tooling/, the umbrella itself excluded. */
    toolingPackageNames(): string[] {
        const dir = path.join(this.repoRoot, TOOLING_DIR);
        const names: string[] = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const manifest = path.join(dir, entry.name, 'package.json');
            if (!fs.existsSync(manifest)) continue;
            const name = String(this.read(manifest)['name']);
            if (name !== UMBRELLA) names.push(name);
        }
        return names.sort();
    }

    umbrellaDependencies(): Record<string, string> {
        const manifest = path.join(this.repoRoot, TOOLING_DIR, 'nx-webpieces-rules', 'package.json');
        const deps = this.read(manifest)['dependencies'];
        return (typeof deps === 'object' && deps !== null) ? deps as Record<string, string> : {};
    }

    /** The catalog block of pnpm-workspace.yaml, as declared-name → raw spec text. */
    catalogNames(): Set<string> {
        const yaml = fs.readFileSync(path.join(this.repoRoot, 'pnpm-workspace.yaml'), 'utf8');
        const names = new Set<string>();
        for (const line of yaml.split('\n')) {
            const match = /^\s{2}'(@webpieces\/[A-Za-z0-9._-]+)'\s*:/.exec(line);
            if (match !== null) names.add(match[1]);
        }
        return names;
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
}

describe('the umbrella package bundles the whole toolchain', () => {
    const scan = new ToolingScan(__dirname);

    it('declares every packages/tooling/* package, including the ones it never imports', () => {
        const declared = Object.keys(scan.umbrellaDependencies());
        const missing = scan.toolingPackageNames().filter((name: string) => !declared.includes(name));
        expect(missing, 'a tooling package a consumer cannot reach is not shipped').toEqual([]);
    });

    // The two the cleanup removed. Named explicitly, because the property test above would also pass if
    // someone moved them out of packages/tooling/ — and the incident is about these two specifically.
    it('bundles ai-hook-rules and pr-gate, whose bins are the product (nothing imports them)', () => {
        const declared = Object.keys(scan.umbrellaDependencies());
        expect(declared, 'ships wp-ai-guards-hook, named in every consumer .claude/settings.json')
            .toContain('@webpieces/ai-hook-rules');
        expect(declared, 'ships wp-start-upsert-pr and the rest of the PR flow')
            .toContain('@webpieces/pr-gate');
    });

    /**
     * BUILT AGAINST LOCAL SOURCE, not a published release. This is the axis that is easy to get backwards:
     * the tooling packages build each other from this checkout (`workspace:*`), while the REPO is
     * validated by the previous published release (the one `catalog:` entry in pnpm-workspace.yaml, used
     * by the ROOT manifest only). A version literal here would silently build the umbrella against an old
     * child, and it is also what erases these edges from architecture/dependencies.json — nx only draws
     * workspace→workspace.
     */
    it('depends on its children with workspace:*, never a version or a catalog spec', () => {
        const deps = scan.umbrellaDependencies();
        const notLocal = Object.keys(deps)
            .filter((name: string) => name.startsWith('@webpieces/'))
            .filter((name: string) => !deps[name].startsWith('workspace:'))
            .map((name: string) => `${name}=${deps[name]}`);
        expect(notLocal, 'the umbrella is BUILT here; only the root manifest consumes a release').toEqual([]);
    });

    /**
     * The catalog is for the release the repo is BUILT WITH, and one entry is all it needs: the umbrella
     * drags its five children along, in lockstep, by construction. Listing them individually would be
     * five more versions to keep in step for nothing — and inviting exactly the partial bump the L0
     * drift guard exists to catch.
     */
    it('keeps the catalog to the umbrella alone', () => {
        expect([...scan.catalogNames()]).toEqual([UMBRELLA]);
    });
});
