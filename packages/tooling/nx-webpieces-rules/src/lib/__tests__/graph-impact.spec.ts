/**
 * Impact mode's data. nx and git are injected, so these pin the decisions — what is "touched" vs
 * "affected", when no sidecar is written, that the sidecar ignores itself — without spawning either.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { DiffScope } from '@webpieces/rules-config';
import { specTempDirs } from '@webpieces/tooling-testkit';
import type { EnhancedGraph } from '../graph-sorter';
import {
    IMPACT_SIDECAR_DIR,
    IMPACT_SIDECAR_FILE,
    ImpactRefresh,
    ImpactReport,
    ImpactSidecar,
    ImpactUnavailable,
    NxCli,
    NxImpactScanner,
    ProjectFileOwners,
} from '../graph-impact';

const GRAPH: EnhancedGraph = {
    app: { level: 2, dependsOn: ['lib-a'] },
    'lib-a': { level: 1, dependsOn: ['core'] },
    core: { level: 0, dependsOn: [] },
    other: { level: 0, dependsOn: [] },
};

class FakeDiff extends DiffScope {
    constructor(
        private readonly base: string | null,
        private readonly files: string[],
    ) {
        super();
    }
    override detectBase(): string | null {
        return this.base;
    }
    override getChangedFiles(): string[] {
        return this.files;
    }
}

class FakeNx extends NxCli {
    readonly calls: string[][] = [];
    constructor(private readonly out: string | null) {
        super();
    }
    override run(_root: string, args: string[]): string | null {
        this.calls.push(args);
        return this.out;
    }
}

class FakeOwners extends ProjectFileOwners {
    constructor(private readonly map: Map<string, string>) {
        super();
    }
    override async owners(): Promise<Map<string, string>> {
        return this.map;
    }
}

const owners = new Map<string, string>([
    ['libs/core/src/a.ts', 'core'],
    ['apps/app/main.ts', 'app'],
]);

describe('NxImpactScanner', () => {
    it('asks nx for the affected set from the fork point with no --head, so uncommitted work counts', async () => {
        const nx = new FakeNx('["app","lib-a","core","not-drawn"]');
        const scanner = new NxImpactScanner(new FakeDiff('abcdef1234', ['libs/core/src/a.ts']), nx, new FakeOwners(owners));
        const report = (await scanner.scan('/ws', GRAPH)) as ImpactReport;
        expect(nx.calls).toEqual([['show', 'projects', '--affected', '--base=abcdef1234', '--json']]);
        expect(report.available).toBe(true);
        expect(report.base).toBe('abcdef1');
        // touched = affected AND owning a changed file (by nx's own ownership); the rest are affected.
        expect(report.touched).toEqual(['core']);
        expect(report.affected).toEqual(['app', 'lib-a']);
        expect(report.buildInputs).toEqual([]);
    });

    it('marks every transitive dependency of the affected set that is not affected as a build input', async () => {
        // nx says only the app is affected (e.g. its own file changed): lib-a and core must still be built.
        const scanner = new NxImpactScanner(new FakeDiff('b', ['apps/app/main.ts']), new FakeNx('["app"]'), new FakeOwners(owners));
        const report = (await scanner.scan('/ws', GRAPH)) as ImpactReport;
        expect(report.touched).toEqual(['app']);
        expect(report.affected).toEqual([]);
        expect(report.buildInputs).toEqual(['core', 'lib-a']);
    });

    it('exposes what the changed projects use, for the Filter popover', async () => {
        // lib-a changed: it uses core (a dependency of the touched set, not itself touched).
        const lib = new Map<string, string>([['libs/lib-a/x.ts', 'lib-a']]);
        const scanner = new NxImpactScanner(new FakeDiff('b', ['libs/lib-a/x.ts']), new FakeNx('["app","lib-a"]'), new FakeOwners(lib));
        const report = (await scanner.scan('/ws', GRAPH)) as ImpactReport;
        expect(report.touched).toEqual(['lib-a']);
        expect(report.affected).toEqual(['app']);
        expect(report.dependencies).toEqual(['core']);
        expect(report.globalFiles).toEqual([]);
    });

    it('names the workspace-global files when changes touch no project but nx affects everything', async () => {
        const files = ['pnpm-workspace.yaml', 'pnpm-lock.yaml'];
        const scanner = new NxImpactScanner(new FakeDiff('b', files), new FakeNx('["app","lib-a","core","other"]'), new FakeOwners(owners));
        const report = (await scanner.scan('/ws', GRAPH)) as ImpactReport;
        expect(report.touched).toEqual([]);
        expect(report.affected).toHaveLength(4);
        expect(report.globalFiles).toEqual(['pnpm-lock.yaml', 'pnpm-workspace.yaml']);
        expect(report.dependencies).toEqual([]);
    });

    it('claims no global files when nx file ownership was unavailable', async () => {
        const scanner = new NxImpactScanner(new FakeDiff('b', ['pnpm-lock.yaml']), new FakeNx('["core"]'), new FakeOwners(new Map()));
        expect(((await scanner.scan('/ws', GRAPH)) as ImpactReport).globalFiles).toEqual([]);
    });

    it('never counts a file owner nx did not call affected', async () => {
        const scanner = new NxImpactScanner(new FakeDiff('b', ['apps/app/main.ts']), new FakeNx('["core"]'), new FakeOwners(owners));
        const report = (await scanner.scan('/ws', GRAPH)) as ImpactReport;
        expect(report.touched).toEqual([]);
        expect(report.affected).toEqual(['core']);
    });

    it('reports nothing affected as a disabled-with-reason sidecar', async () => {
        const scanner = new NxImpactScanner(new FakeDiff('b', []), new FakeNx('[]'), new FakeOwners(owners));
        const report = (await scanner.scan('/ws', GRAPH)) as ImpactReport;
        expect(report.available).toBe(false);
        expect(report.reason).toContain('nothing affected');
    });

    it('is unavailable with no fork point, a failed nx, or output that is not a JSON list', async () => {
        for (const scanner of [
            new NxImpactScanner(new FakeDiff(null, []), new FakeNx('[]'), new FakeOwners(owners)),
            new NxImpactScanner(new FakeDiff('b', []), new FakeNx(null), new FakeOwners(owners)),
            new NxImpactScanner(new FakeDiff('b', []), new FakeNx('{"a":1}'), new FakeOwners(owners)),
            new NxImpactScanner(new FakeDiff('b', []), new FakeNx('not json'), new FakeOwners(owners)),
        ]) {
            expect(await scanner.scan('/ws', GRAPH)).toBeInstanceOf(ImpactUnavailable);
        }
    });
});

describe('ImpactRefresh + ImpactSidecar', () => {
    it('writes a self-ignoring sidecar that sets one window global', async () => {
        const dir = specTempDirs.make('wp-impact-');
        const scanner = new NxImpactScanner(new FakeDiff('b', ['libs/core/src/a.ts']), new FakeNx('["core","app"]'), new FakeOwners(owners));
        const line = await new ImpactRefresh(scanner, new ImpactSidecar()).run(dir, dir, GRAPH);
        expect(line).toContain('1 touched · 1 affected · 1 build inputs');
        const file = path.join(dir, IMPACT_SIDECAR_DIR, IMPACT_SIDECAR_FILE);
        expect(fs.readFileSync(file, 'utf8')).toContain('window.__WP_IMPACT__ = {"available":true');
        expect(fs.readFileSync(path.join(dir, IMPACT_SIDECAR_DIR, '.gitignore'), 'utf8')).toMatch(/^\*$/m);
    });

    it('removes a stale sidecar and writes none when nx cannot answer', async () => {
        const dir = specTempDirs.make('wp-impact-stale-');
        const sidecar = new ImpactSidecar();
        sidecar.write(dir, new ImpactReport(true, '', 'old', ['core'], [], [], 1, [], []));
        const scanner = new NxImpactScanner(new FakeDiff('b', []), new FakeNx(null), new FakeOwners(owners));
        const line = await new ImpactRefresh(scanner, sidecar).run(dir, dir, GRAPH);
        expect(line).toContain('no sidecar written');
        expect(fs.existsSync(path.join(dir, IMPACT_SIDECAR_DIR, IMPACT_SIDECAR_FILE))).toBe(false);
    });

    it('escapes "<" so a project name cannot close the script', () => {
        const script = new ImpactSidecar().script(new ImpactReport(true, '', 'b', ['</script>'], [], [], 1, [], []));
        expect(script).not.toContain('</script>');
    });
});
