/**
 * Edge changes against the base (#1264): the LIVE graph against the FORK POINT's committed graph.
 * git is injected, so these pin which commit is read (the fork point, and nothing else — never
 * HEAD's committed copy), what counts as gained or lost, and that a missing base is an answer.
 */
import { describe, it, expect } from 'vitest';
import type { EnhancedGraph } from '../graph-sorter';
import type { RuntimeGraph } from '../runtime-graph-model';
import { DEFAULT_GRAPH_PATH } from '../graph-loader';
import { DEFAULT_RUNTIME_GRAPH_PATH } from '../runtime-graph-io';
import {
    EdgeChange,
    EdgeChangeKind,
    EdgeChangeScanner,
    EdgeDiffer,
    EdgeRelation,
    FixedLiveGraphs,
    GitFileAt,
    LiveGraphs,
} from '../graph-edge-diff';

const FORK = 'aaaa000011112222333344445555666677778888';

/** svc-a used lib-b at the fork point; on the branch it uses lib-c instead. */
const BASE_PROJECTS: EnhancedGraph = {
    'svc-a': { level: 2, dependsOn: ['lib-b'] },
    'lib-b': { level: 0, dependsOn: [] },
    'lib-c': { level: 0, dependsOn: [] },
};
const LIVE_PROJECTS: EnhancedGraph = {
    'svc-a': { level: 2, dependsOn: ['lib-c'] },
    'lib-b': { level: 0, dependsOn: [] },
    'lib-c': { level: 0, dependsOn: [] },
};

function runtime(edges: [string, string, string[]][]): RuntimeGraph {
    const graph = { maxLevel: 1, contractQueues: {}, services: {}, apis: {}, runtimeEdges: [], unresolvedUses: [], queues: {}, triggers: [] } as unknown as RuntimeGraph;
    for (const edge of edges) graph.runtimeEdges.push({ from: edge[0], to: edge[1], via: edge[2], type: 'rpc' });
    return graph;
}

/** git, answering `git show <sha>:<file>` from a table; records every read. */
class FakeGitFileAt extends GitFileAt {
    readonly reads: string[] = [];
    constructor(private readonly files: Map<string, string>) {
        super();
    }
    override read(_root: string, sha: string, file: string): string | null {
        this.reads.push(`${sha}:${file}`);
        return this.files.get(`${sha}:${file}`) ?? null;
    }
}

const texts = (changes: EdgeChange[]): string[] => changes.map((change: EdgeChange): string => `${change.change}: ${change.text}`);

describe('EdgeDiffer (#1264)', () => {
    it('reports one gained and one lost dependency edge', () => {
        const changes = new EdgeDiffer().dependency(BASE_PROJECTS, LIVE_PROJECTS);
        expect(texts(changes)).toEqual([
            'lost: svc-a no longer depends on lib-b',
            'gained: new on this branch: svc-a now depends on lib-c',
        ]);
        expect(changes.map((change: EdgeChange): EdgeRelation => change.relation)).toEqual([EdgeRelation.DEPENDS, EdgeRelation.DEPENDS]);
    });

    it('reports runtime calls per API: a new edge, a lost edge, and an API swapped on a kept edge', () => {
        const base = runtime([['web', 'orders', ['OrderApi']], ['web', 'billing', ['BillingApi']]]);
        const live = runtime([['web', 'orders', ['OrderApi', 'RefundApi']], ['web', 'search', ['SearchApi']]]);
        expect(texts(new EdgeDiffer().runtime(base, live))).toEqual([
            'lost: web no longer calls billing (BillingApi)',
            'gained: new on this branch: web now calls orders (RefundApi)',
            'gained: new on this branch: web now calls search (SearchApi)',
        ]);
    });

    it('reports nothing for identical graphs', () => {
        expect(new EdgeDiffer().dependency(LIVE_PROJECTS, LIVE_PROJECTS)).toEqual([]);
    });
});

describe('EdgeChangeScanner (#1264)', () => {
    const files = new Map<string, string>([
        [`${FORK}:${DEFAULT_GRAPH_PATH}`, JSON.stringify({ projects: BASE_PROJECTS })],
        [`${FORK}:${DEFAULT_RUNTIME_GRAPH_PATH}`, JSON.stringify(runtime([['web', 'billing', ['BillingApi']]]))],
    ]);

    it('compares the LIVE graph with the FORK POINT\'s committed files, reading no other commit', async () => {
        const git = new FakeGitFileAt(files);
        const live = new FixedLiveGraphs(new LiveGraphs(LIVE_PROJECTS, runtime([['web', 'search', ['SearchApi']]])));
        const report = await new EdgeChangeScanner(git).scan('/ws', FORK, live);
        expect(git.reads).toEqual([`${FORK}:${DEFAULT_GRAPH_PATH}`, `${FORK}:${DEFAULT_RUNTIME_GRAPH_PATH}`]);
        expect(report.base).toBe('aaaa000');
        expect([report.dependencyReason, report.runtimeReason]).toEqual(['', '']);
        expect(report.dependency.map((change: EdgeChange): EdgeChangeKind => change.change)).toEqual([EdgeChangeKind.LOST, EdgeChangeKind.GAINED]);
        expect(texts(report.runtime)).toEqual([
            'lost: web no longer calls billing (BillingApi)',
            'gained: new on this branch: web now calls search (SearchApi)',
        ]);
    });

    it('finds the change even when the branch already regenerated and committed the graph: only the fork point is read', async () => {
        // HEAD's committed dependencies.json would equal LIVE_PROJECTS here; it is never consulted.
        const git = new FakeGitFileAt(new Map<string, string>([...files, [`HEAD:${DEFAULT_GRAPH_PATH}`, JSON.stringify({ projects: LIVE_PROJECTS })]]));
        const report = await new EdgeChangeScanner(git).scan('/ws', FORK, new FixedLiveGraphs(new LiveGraphs(LIVE_PROJECTS, null, 'no runtime')));
        expect(git.reads.every((read: string): boolean => read.startsWith(FORK))).toBe(true);
        expect(report.dependency).toHaveLength(2);
        expect(report.runtimeReason).toBe('no runtime');
    });

    it('says so — and does not throw — when the fork point has no architecture graph (first adoption)', async () => {
        const report = await new EdgeChangeScanner(new FakeGitFileAt(new Map())).scan('/ws', FORK, new FixedLiveGraphs(new LiveGraphs(LIVE_PROJECTS, null)));
        expect(report.dependency).toEqual([]);
        expect(report.runtime).toEqual([]);
        expect(report.dependencyReason).toContain('No architecture graph at the fork point aaaa000 (first adoption)');
    });

    it('says why when there is no fork point (main or a detached HEAD)', async () => {
        const report = await new EdgeChangeScanner(new FakeGitFileAt(files)).scan('/ws', null, new FixedLiveGraphs(new LiveGraphs(LIVE_PROJECTS, null)));
        expect(report.dependencyReason).toContain('no branch comparison here');
    });

    it('turns a live-graph failure into the reason, never a thrown error', async () => {
        class Failing extends FixedLiveGraphs {
            override async graphs(): Promise<LiveGraphs> {
                throw new Error('responsibilities.md missing');
            }
        }
        const report = await new EdgeChangeScanner(new FakeGitFileAt(files)).scan('/ws', FORK, new Failing(new LiveGraphs({}, null)));
        expect(report.dependencyReason).toBe('Edge changes unavailable: responsibilities.md missing');
    });
});
