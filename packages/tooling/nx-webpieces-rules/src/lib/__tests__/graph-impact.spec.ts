/**
 * Impact mode's data. nx and git are injected, so these pin the decisions — which comparisons exist
 * where HEAD is (#1163), what is "touched" vs "affected", when no sidecar is written, that the sidecar
 * ignores itself — without spawning either.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { DiffScope } from '@webpieces/rules-config';
import { specTempDirs } from '@webpieces/tooling-testkit';
import type { EnhancedGraph } from '../graph-sorter';
import {
    GENERATE_IMPACT_KINDS,
    IMPACT_SIDECAR_DIR,
    IMPACT_SIDECAR_FILE,
    ImpactComparison,
    ImpactGit,
    ImpactKind,
    ImpactPlan,
    ImpactRefresh,
    ImpactReport,
    ImpactScopeResolver,
    ImpactSidecar,
    ImpactSidecarData,
    ImpactUnavailable,
    NOTHING_CHANGED_ON_BRANCH,
    NxCli,
    NxImpactScanner,
    ProjectFileOwners,
    ROOT_COMMIT_REASON,
    VISUALIZE_IMPACT_KINDS,
} from '../graph-impact';

const GRAPH: EnhancedGraph = {
    app: { level: 2, dependsOn: ['lib-a'] },
    'lib-a': { level: 1, dependsOn: ['core'] },
    core: { level: 0, dependsOn: [] },
    other: { level: 0, dependsOn: [] },
};

const HEAD = 'ffff000011112222333344445555666677778888';
const PARENT = 'eeee000011112222333344445555666677778888';
const FORK = 'aaaa000011112222333344445555666677778888';

class FakeDiff extends DiffScope {
    readonly bases: string[] = [];
    constructor(
        private readonly base: string | null,
        private readonly files: string[],
    ) {
        super();
    }
    override detectBase(): string | null {
        return this.base;
    }
    override getChangedFiles(_root: string, base: string, head?: string): string[] {
        this.bases.push(`${base}..${head ?? 'WORKTREE'}`);
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
    calls = 0;
    constructor(private readonly map: Map<string, string>) {
        super();
    }
    override async owners(): Promise<Map<string, string>> {
        this.calls++;
        return this.map;
    }
}

/** Where HEAD is, as git would answer. */
class FakeGit extends ImpactGit {
    constructor(
        private readonly current: string | null,
        private readonly parent: string | null,
        private readonly isDirty: boolean,
        private readonly head: string | null = HEAD,
    ) {
        super();
    }
    override branch(): string | null {
        return this.current;
    }
    override sha(_root: string, ref: string): string | null {
        return ref === 'HEAD' ? this.head : this.parent;
    }
    override dirty(): boolean {
        return this.isDirty;
    }
    override subject(): string {
        return 'Upgrade the thing (#1162)';
    }
}

const owners = new Map<string, string>([
    ['libs/core/src/a.ts', 'core'],
    ['apps/app/main.ts', 'app'],
]);

const branchAt = (base: string | null): ImpactComparison =>
    new ImpactComparison(ImpactKind.BRANCH, base, 'Changed on this branch (since abcdef1)', false, '');

function plan(git: FakeGit, fork: string | null = FORK): ImpactPlan {
    const result = new ImpactScopeResolver(git, new FakeDiff(fork, [])).resolve('/ws');
    expect(result).toBeInstanceOf(ImpactPlan);
    return result as ImpactPlan;
}

const kinds = (p: ImpactPlan): ImpactKind[] => p.comparisons.map((c: ImpactComparison): ImpactKind => c.kind);
const reportKinds = (results: (ImpactReport | ImpactUnavailable)[]): string[] =>
    results.map((result: ImpactReport | ImpactUnavailable): string => (result as ImpactReport).kind);

describe('ImpactScopeResolver: which comparisons exist where HEAD is (#1163)', () => {
    it('main, clean: last commit only, labelled with its base and HEAD subject', () => {
        const p = plan(new FakeGit('main', PARENT, false));
        expect(kinds(p)).toEqual([ImpactKind.COMMIT]);
        expect(p.defaultKind).toBe(ImpactKind.COMMIT);
        expect(p.comparisons[0].base).toBe(PARENT);
        expect(p.comparisons[0].label).toBe('Changed since eeee000 — Upgrade the thing (#1162)');
        expect(p.comparisons[0].dirty).toBe(false);
    });

    it('main, dirty: last commit, "+ uncommitted changes"', () => {
        const p = plan(new FakeGit('main', PARENT, true));
        expect(kinds(p)).toEqual([ImpactKind.COMMIT]);
        expect(p.comparisons[0].label).toBe('Changed since eeee000 — Upgrade the thing (#1162) + uncommitted changes');
        expect(p.comparisons[0].dirty).toBe(true);
    });

    it('main with unpushed commits: still last commit — decided by the branch NAME, not merge-base', () => {
        // merge-base with origin/main is an older commit, which would look like "a branch with commits".
        const p = plan(new FakeGit('main', PARENT, false), FORK);
        expect(kinds(p)).toEqual([ImpactKind.COMMIT]);
        expect(p.defaultKind).toBe(ImpactKind.COMMIT);
    });

    it('detached HEAD: last commit only', () => {
        const p = plan(new FakeGit(null, PARENT, false), HEAD);
        expect(kinds(p)).toEqual([ImpactKind.COMMIT]);
        expect(p.defaultKind).toBe(ImpactKind.COMMIT);
    });

    it("fresh feature branch, clean: the branch comparison only — never main's last commit", () => {
        const p = plan(new FakeGit('dean/x', PARENT, false), HEAD);
        expect(kinds(p)).toEqual([ImpactKind.BRANCH]);
        expect(p.defaultKind).toBe(ImpactKind.BRANCH);
        expect(p.comparisons[0].label).toBe('Changed on this branch (since ffff000)');
    });

    it('fresh feature branch, dirty: the branch comparison, counting the edits', () => {
        const p = plan(new FakeGit('dean/x', PARENT, true), HEAD.slice(0, 12));
        expect(kinds(p)).toEqual([ImpactKind.BRANCH]);
        expect(p.comparisons[0].label).toBe('Changed on this branch (since ffff000) + uncommitted changes');
        expect(p.comparisons[0].dirty).toBe(true);
    });

    it('feature branch with commits: both, branch first and default', () => {
        const p = plan(new FakeGit('dean/x', PARENT, false), FORK);
        expect(kinds(p)).toEqual([ImpactKind.BRANCH, ImpactKind.COMMIT]);
        expect(p.defaultKind).toBe(ImpactKind.BRANCH);
        expect(p.comparisons.map((c: ImpactComparison): string | null => c.base)).toEqual([FORK, PARENT]);
        expect(p.comparisons[0].label).toBe('Changed on this branch (since aaaa000)');
    });

    it('root commit: the last commit exists but is unavailable, with the reason', () => {
        const p = plan(new FakeGit('main', null, false));
        expect(kinds(p)).toEqual([ImpactKind.COMMIT]);
        expect(p.comparisons[0].base).toBeNull();
        expect(p.comparisons[0].reason).toBe(ROOT_COMMIT_REASON);
    });

    it('is unavailable when git cannot resolve HEAD', () => {
        const result = new ImpactScopeResolver(new FakeGit('main', null, false, null), new FakeDiff(FORK, [])).resolve('/ws');
        expect(result).toBeInstanceOf(ImpactUnavailable);
    });
});

describe('NxImpactScanner', () => {
    it("asks nx for the affected set from the comparison's base with no --head, so uncommitted work counts", async () => {
        const nx = new FakeNx('["app","lib-a","core","not-drawn"]');
        const diff = new FakeDiff(null, ['libs/core/src/a.ts']);
        const scanner = new NxImpactScanner(diff, nx, new FakeOwners(owners));
        const report = (await scanner.scan('/ws', GRAPH, branchAt('abcdef1234'))) as ImpactReport;
        expect(nx.calls).toEqual([['show', 'projects', '--affected', '--base=abcdef1234', '--json']]);
        expect(diff.bases).toEqual(['abcdef1234..WORKTREE']);
        expect(report.available).toBe(true);
        expect(report.kind).toBe(ImpactKind.BRANCH);
        expect(report.label).toBe('Changed on this branch (since abcdef1)');
        expect(report.base).toBe('abcdef1');
        // touched = affected AND owning a changed file (by nx's own ownership); the rest are affected.
        expect(report.touched).toEqual(['core']);
        expect(report.affected).toEqual(['app', 'lib-a']);
        expect(report.buildInputs).toEqual([]);
    });

    it('scans each comparison with its OWN --base and computes nx ownership once for both', async () => {
        const nx = new FakeNx('["core"]');
        const diff = new FakeDiff(null, ['libs/core/src/a.ts']);
        const ownership = new FakeOwners(owners);
        const comparisons = plan(new FakeGit('dean/x', PARENT, false), FORK).comparisons;
        const results = await new NxImpactScanner(diff, nx, ownership).scanAll('/ws', GRAPH, comparisons);
        expect(nx.calls).toEqual([
            ['show', 'projects', '--affected', `--base=${FORK}`, '--json'],
            ['show', 'projects', '--affected', `--base=${PARENT}`, '--json'],
        ]);
        expect(nx.calls.flat().some((arg: string): boolean => arg.startsWith('--head'))).toBe(false);
        expect(diff.bases).toEqual([`${FORK}..WORKTREE`, `${PARENT}..WORKTREE`]);
        expect(ownership.calls).toBe(1);
        expect(reportKinds(results)).toEqual([ImpactKind.BRANCH, ImpactKind.COMMIT]);
    });

    it('marks every transitive dependency of the affected set that is not affected as a build input', async () => {
        // nx says only the app is affected (e.g. its own file changed): lib-a and core must still be built.
        const scanner = new NxImpactScanner(new FakeDiff(null, ['apps/app/main.ts']), new FakeNx('["app"]'), new FakeOwners(owners));
        const report = (await scanner.scan('/ws', GRAPH, branchAt('b'))) as ImpactReport;
        expect(report.touched).toEqual(['app']);
        expect(report.affected).toEqual([]);
        expect(report.buildInputs).toEqual(['core', 'lib-a']);
    });

    it('exposes what the changed projects use, for the Filter popover', async () => {
        // lib-a changed: it uses core (a dependency of the touched set, not itself touched).
        const lib = new Map<string, string>([['libs/lib-a/x.ts', 'lib-a']]);
        const scanner = new NxImpactScanner(new FakeDiff(null, ['libs/lib-a/x.ts']), new FakeNx('["app","lib-a"]'), new FakeOwners(lib));
        const report = (await scanner.scan('/ws', GRAPH, branchAt('b'))) as ImpactReport;
        expect(report.touched).toEqual(['lib-a']);
        expect(report.affected).toEqual(['app']);
        expect(report.dependencies).toEqual(['core']);
        expect(report.globalFiles).toEqual([]);
    });

    it('names the workspace-global files when changes touch no project but nx affects everything', async () => {
        const files = ['pnpm-workspace.yaml', 'pnpm-lock.yaml'];
        const scanner = new NxImpactScanner(new FakeDiff(null, files), new FakeNx('["app","lib-a","core","other"]'), new FakeOwners(owners));
        const report = (await scanner.scan('/ws', GRAPH, branchAt('b'))) as ImpactReport;
        expect(report.touched).toEqual([]);
        expect(report.affected).toHaveLength(4);
        expect(report.globalFiles).toEqual(['pnpm-lock.yaml', 'pnpm-workspace.yaml']);
        expect(report.dependencies).toEqual([]);
    });

    it('claims no global files when nx file ownership was unavailable', async () => {
        const scanner = new NxImpactScanner(new FakeDiff(null, ['pnpm-lock.yaml']), new FakeNx('["core"]'), new FakeOwners(new Map()));
        expect(((await scanner.scan('/ws', GRAPH, branchAt('b'))) as ImpactReport).globalFiles).toEqual([]);
    });

    it('never counts a file owner nx did not call affected', async () => {
        const scanner = new NxImpactScanner(new FakeDiff(null, ['apps/app/main.ts']), new FakeNx('["core"]'), new FakeOwners(owners));
        const report = (await scanner.scan('/ws', GRAPH, branchAt('b'))) as ImpactReport;
        expect(report.touched).toEqual([]);
        expect(report.affected).toEqual(['core']);
    });

    it('reports a fresh branch with a clean tree as AVAILABLE with zero sets and "Nothing changed on this branch yet"', async () => {
        const scanner = new NxImpactScanner(new FakeDiff(null, []), new FakeNx('[]'), new FakeOwners(owners));
        const report = (await scanner.scan('/ws', GRAPH, branchAt(HEAD))) as ImpactReport;
        expect(report.available).toBe(true);
        expect(report.reason).toBe(NOTHING_CHANGED_ON_BRANCH);
        expect([report.touched, report.affected, report.buildInputs, report.dependencies]).toEqual([[], [], [], []]);
        expect(report.changedFiles).toBe(0);
    });

    it("reports the root commit's last-commit comparison as unavailable with its reason, asking nx nothing", async () => {
        const nx = new FakeNx('[]');
        const comparison = plan(new FakeGit('main', null, false)).comparisons[0];
        const scanner = new NxImpactScanner(new FakeDiff(null, []), nx, new FakeOwners(owners));
        const report = (await scanner.scan('/ws', GRAPH, comparison)) as ImpactReport;
        expect(report.available).toBe(false);
        expect(report.reason).toBe(ROOT_COMMIT_REASON);
        expect(nx.calls).toEqual([]);
    });

    it('is unavailable with a failed nx, or output that is not a JSON list', async () => {
        for (const scanner of [
            new NxImpactScanner(new FakeDiff(null, []), new FakeNx(null), new FakeOwners(owners)),
            new NxImpactScanner(new FakeDiff(null, []), new FakeNx('{"a":1}'), new FakeOwners(owners)),
            new NxImpactScanner(new FakeDiff(null, []), new FakeNx('not json'), new FakeOwners(owners)),
        ]) {
            expect(await scanner.scan('/ws', GRAPH, branchAt('b'))).toBeInstanceOf(ImpactUnavailable);
        }
    });
});

/** A resolver whose plan is fixed. */
class FixedResolver extends ImpactScopeResolver {
    constructor(private readonly fixed: ImpactPlan | ImpactUnavailable) {
        super();
    }
    override resolve(): ImpactPlan | ImpactUnavailable {
        return this.fixed;
    }
}

const sidecarOf = (dir: string): string => fs.readFileSync(path.join(dir, IMPACT_SIDECAR_DIR, IMPACT_SIDECAR_FILE), 'utf8');

/** The `{ scans, defaultKind }` the page reads, parsed back out of the sidecar script. */
function sidecarData(dir: string): ImpactSidecarData {
    const json = sidecarOf(dir).split('window.__WP_IMPACT__ = ')[1].trim().replace(/;$/, '');
    return JSON.parse(json) as ImpactSidecarData;
}

const scanKinds = (data: ImpactSidecarData): string[] => data.scans.map((scan: ImpactReport): string => scan.kind);

describe('ImpactRefresh + ImpactSidecar', () => {
    it('writes a self-ignoring sidecar that sets one window global of { scans, defaultKind }', async () => {
        const dir = specTempDirs.make('wp-impact-');
        const scanner = new NxImpactScanner(new FakeDiff(null, ['libs/core/src/a.ts']), new FakeNx('["core","app"]'), new FakeOwners(owners));
        const resolver = new FixedResolver(plan(new FakeGit('dean/x', PARENT, false), FORK));
        const line = await new ImpactRefresh(scanner, new ImpactSidecar(), resolver).run(dir, dir, GRAPH, VISUALIZE_IMPACT_KINDS);
        // One result line per comparison.
        expect(line).toContain('Changed on this branch (since aaaa000): 1 touched · 1 affected · 1 build inputs');
        expect(line).toContain('Changed since eeee000 — Upgrade the thing (#1162): 1 touched');
        expect(sidecarOf(dir)).toContain('window.__WP_IMPACT__ = {"scans":[{"kind":"branch"');
        const data = sidecarData(dir);
        expect(data.defaultKind).toBe('branch');
        expect(scanKinds(data)).toEqual(['branch', 'commit']);
        expect(fs.readFileSync(path.join(dir, IMPACT_SIDECAR_DIR, '.gitignore'), 'utf8')).toMatch(/^\*$/m);
        // Both commands write it; both are named, and the data never leaves the gitignored sidecar.
        expect(fs.readFileSync(path.join(dir, IMPACT_SIDECAR_DIR, '.gitignore'), 'utf8')).toContain(
            'architecture:generate and architecture:visualize',
        );
        expect(sidecarOf(dir)).toContain('architecture:generate or architecture:visualize');
        expect(fs.readdirSync(dir).sort()).toEqual([IMPACT_SIDECAR_DIR]);
    });

    it('generate scans the branch comparison only and never the last commit', async () => {
        expect(GENERATE_IMPACT_KINDS).toEqual([ImpactKind.BRANCH]);
        const dir = specTempDirs.make('wp-impact-generate-');
        const nx = new FakeNx('["core"]');
        const scanner = new NxImpactScanner(new FakeDiff(null, ['libs/core/src/a.ts']), nx, new FakeOwners(owners));
        const resolver = new FixedResolver(plan(new FakeGit('dean/x', PARENT, false), FORK));
        await new ImpactRefresh(scanner, new ImpactSidecar(), resolver).run(dir, dir, GRAPH, GENERATE_IMPACT_KINDS);
        expect(nx.calls).toEqual([['show', 'projects', '--affected', `--base=${FORK}`, '--json']]);
        expect(scanKinds(sidecarData(dir))).toEqual(['branch']);
    });

    it('generate on main writes no Impact data, removing a stale sidecar', async () => {
        const dir = specTempDirs.make('wp-impact-generate-main-');
        const sidecar = new ImpactSidecar();
        sidecar.write(dir, new ImpactSidecarData([], ImpactKind.BRANCH));
        const nx = new FakeNx('["core"]');
        const scanner = new NxImpactScanner(new FakeDiff(null, []), nx, new FakeOwners(owners));
        const resolver = new FixedResolver(plan(new FakeGit('main', PARENT, false)));
        const line = await new ImpactRefresh(scanner, sidecar, resolver).run(dir, dir, GRAPH, GENERATE_IMPACT_KINDS);
        expect(line).toContain('no sidecar written');
        expect(line).toContain('pnpm arch:visualize');
        expect(nx.calls).toEqual([]);
        expect(fs.existsSync(path.join(dir, IMPACT_SIDECAR_DIR, IMPACT_SIDECAR_FILE))).toBe(false);
    });

    it('removes a stale sidecar and writes none when nx cannot answer', async () => {
        const dir = specTempDirs.make('wp-impact-stale-');
        const sidecar = new ImpactSidecar();
        sidecar.write(dir, new ImpactSidecarData([], ImpactKind.BRANCH));
        const scanner = new NxImpactScanner(new FakeDiff(null, []), new FakeNx(null), new FakeOwners(owners));
        const resolver = new FixedResolver(plan(new FakeGit('main', PARENT, false)));
        const line = await new ImpactRefresh(scanner, sidecar, resolver).run(dir, dir, GRAPH, VISUALIZE_IMPACT_KINDS);
        expect(line).toContain('no sidecar written');
        expect(fs.existsSync(path.join(dir, IMPACT_SIDECAR_DIR, IMPACT_SIDECAR_FILE))).toBe(false);
    });

    it('writes the root commit as an unavailable scan with its reason', async () => {
        const dir = specTempDirs.make('wp-impact-root-');
        const scanner = new NxImpactScanner(new FakeDiff(null, []), new FakeNx('[]'), new FakeOwners(owners));
        const resolver = new FixedResolver(plan(new FakeGit('main', null, false)));
        const line = await new ImpactRefresh(scanner, new ImpactSidecar(), resolver).run(dir, dir, GRAPH, VISUALIZE_IMPACT_KINDS);
        expect(line).toContain(ROOT_COMMIT_REASON);
        const data = sidecarData(dir);
        expect(data.scans[0].available).toBe(false);
        expect(data.scans[0].reason).toBe(ROOT_COMMIT_REASON);
    });

    it('defaults to the available scan when the preferred one is not', async () => {
        const dir = specTempDirs.make('wp-impact-default-');
        const failing = new ImpactComparison(ImpactKind.BRANCH, null, 'Changed on this branch', false, 'no fork point');
        const commit = new ImpactComparison(ImpactKind.COMMIT, PARENT, 'Changed since eeee000', false, '');
        const scanner = new NxImpactScanner(new FakeDiff(null, ['libs/core/src/a.ts']), new FakeNx('["core"]'), new FakeOwners(owners));
        const resolver = new FixedResolver(new ImpactPlan([failing, commit], ImpactKind.BRANCH));
        await new ImpactRefresh(scanner, new ImpactSidecar(), resolver).run(dir, dir, GRAPH, VISUALIZE_IMPACT_KINDS);
        expect(sidecarData(dir).defaultKind).toBe('commit');
    });

    it('escapes "<" so a project name cannot close the script', () => {
        const report = new ImpactReport(ImpactKind.BRANCH, 'l', false, true, '', 'b', ['</script>'], [], [], 1, [], []);
        const script = new ImpactSidecar().script(new ImpactSidecarData([report], ImpactKind.BRANCH));
        expect(script).not.toContain('</script>');
    });
});
