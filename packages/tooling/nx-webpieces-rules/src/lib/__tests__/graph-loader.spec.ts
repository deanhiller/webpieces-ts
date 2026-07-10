/**
 * Tests for saving/loading architecture/dependencies.json in the wrapper
 * format ({ aiInstructions, projects }) plus legacy flat-map reading.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { EnhancedGraph } from '../graph-sorter';
import {
    saveGraph,
    loadBlessedGraph,
    AI_INSTRUCTIONS,
    GRAPH_COMMANDS,
    DEFAULT_GRAPH_PATH,
} from '../graph-loader';

let tmpRoot: string;

beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-loader-'));
});

afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeEnrichedGraph(): EnhancedGraph {
    return {
        'http-routing': {
            level: 3,
            dependsOn: ['http-api', 'http-filters'],
            framework: ['browser', 'node'],
            shortDescription: 'Matches filters to routes with "quotes" and \\ backslashes.',
            responsibilitiesFile: 'packages/http/http-routing/responsibilities.md',
            designFile: 'packages/http/http-routing/design.json',
        },
        'core-util': {
            level: 0,
            dependsOn: [],
            framework: ['node'],
            shortDescription: 'Small shared utilities.',
            responsibilitiesFile: 'packages/core/core-util/responsibilities.md',
        },
    };
}

describe('graph-loader wrapper format', () => {
    it('round-trips an enriched graph with aiInstructions', () => {
        const graph = makeEnrichedGraph();

        saveGraph(graph, tmpRoot);

        const raw = JSON.parse(fs.readFileSync(path.join(tmpRoot, DEFAULT_GRAPH_PATH), 'utf-8'));
        expect(raw.aiInstructions).toBe(AI_INSTRUCTIONS);
        expect(raw.commands).toEqual(GRAPH_COMMANDS);
        expect(raw.commands.visualizeDesign).toContain('wp-design-visualize');
        expect(Object.keys(raw.projects)).toEqual(['core-util', 'http-routing']);
        expect(raw.projects['http-routing'].shortDescription).toBe(
            'Matches filters to routes with "quotes" and \\ backslashes.'
        );
        // core-util has no project.json → designFile omitted entirely
        expect('designFile' in raw.projects['core-util']).toBe(false);

        const loaded = loadBlessedGraph(tmpRoot);
        expect(loaded).not.toBeNull();
        expect(loaded!.aiInstructions).toBe(AI_INSTRUCTIONS);
        expect(loaded!.commands).toEqual(GRAPH_COMMANDS);
        expect(loaded!.projects).toEqual(raw.projects);
    });

    it('is deterministic (same graph → byte-identical file)', () => {
        const graph: EnhancedGraph = {
            b: { level: 1, dependsOn: ['a'], framework: ['node'] },
            a: { level: 0, dependsOn: [], framework: ['node'] },
        };
        saveGraph(graph, tmpRoot, 'det/dependencies.json');
        const first = fs.readFileSync(path.join(tmpRoot, 'det/dependencies.json'), 'utf-8');
        saveGraph(graph, tmpRoot, 'det/dependencies.json');
        const second = fs.readFileSync(path.join(tmpRoot, 'det/dependencies.json'), 'utf-8');
        expect(second).toBe(first);
        // keys must be sorted regardless of insertion order
        expect(first.indexOf('"a"')).toBeLessThan(first.indexOf('"b"'));
    });

});

describe('graph-loader apiRelations', () => {
    it('round-trips apiRelations and omits it for plain-lib-only projects', () => {
        const graph: EnhancedGraph = {
            'client-server': {
                level: 5,
                dependsOn: ['client-server-api', 'server2-api'],
                framework: ['express'],
                role: 'server',
                apiRelations: {
                    'client-server-api': {
                        kind: 'implements',
                        implements: [
                            { api: 'SaveApi', type: 'rpc' },
                            { api: 'PublicApi', type: 'rpc' },
                        ],
                        uses: [],
                    },
                    'server2-api': {
                        kind: 'uses',
                        implements: [],
                        uses: [{ api: 'Server2Api', type: 'rpc' }],
                    },
                },
            },
            'core-util': { level: 0, dependsOn: [], framework: ['node'] },
        };

        saveGraph(graph, tmpRoot, 'rel/dependencies.json');
        const raw = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'rel/dependencies.json'), 'utf-8'));
        expect(raw.projects['client-server'].apiRelations['client-server-api'].kind).toBe('implements');
        expect(raw.projects['client-server'].apiRelations['server2-api'].uses[0]).toEqual({
            api: 'Server2Api',
            type: 'rpc',
        });
        // no relations → field omitted entirely
        expect('apiRelations' in raw.projects['core-util']).toBe(false);

        const loaded = loadBlessedGraph(tmpRoot, 'rel/dependencies.json');
        expect(loaded!.projects['client-server'].apiRelations).toEqual(graph['client-server'].apiRelations);
    });
});

describe('graph-loader legacy format', () => {
    it('reads the legacy flat format with empty aiInstructions', () => {
        const legacy = {
            'http-api': { level: 0, dependsOn: [] },
            'http-routing': { level: 1, dependsOn: ['http-api'] },
        };
        const legacyPath = path.join(tmpRoot, 'legacy/dependencies.json');
        fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
        fs.writeFileSync(legacyPath, JSON.stringify(legacy), 'utf-8');

        const loaded = loadBlessedGraph(tmpRoot, 'legacy/dependencies.json');
        expect(loaded).not.toBeNull();
        expect(loaded!.aiInstructions).toBe('');
        expect(loaded!.commands).toEqual({});
        expect(loaded!.projects['http-routing'].dependsOn).toEqual(['http-api']);
    });

    it('reads a wrapper file WITHOUT commands (pre-commands format)', () => {
        const wrapper = {
            aiInstructions: 'old text',
            projects: { 'http-api': { level: 0, dependsOn: [] } },
        };
        const wrapperPath = path.join(tmpRoot, 'nocmd/dependencies.json');
        fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });
        fs.writeFileSync(wrapperPath, JSON.stringify(wrapper), 'utf-8');

        const loaded = loadBlessedGraph(tmpRoot, 'nocmd/dependencies.json');
        expect(loaded).not.toBeNull();
        expect(loaded!.commands).toEqual({});
        expect(loaded!.projects['http-api'].level).toBe(0);
    });

    it('returns null when the file does not exist', () => {
        expect(loadBlessedGraph(tmpRoot, 'nope/dependencies.json')).toBeNull();
    });
});
