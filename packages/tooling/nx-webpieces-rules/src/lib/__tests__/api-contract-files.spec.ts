/**
 * Per-API contract files (#949): `architecture/apis/<ApiName>.json`.
 *
 * The endpoint table used to live in dependencies.json under `apiContracts`, so adding one @Endpoint
 * rewrote the project dependency graph and failed validate-architecture-unchanged. These tests pin
 * the replacement: dependencies.json only LINKS to each API's file, the runtime graph reads the files,
 * stale files are removed, and a dependencies.json still carrying `apiContracts` is rejected.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { RuleFailError, renderRuleFailForHuman, specTempDirs } from '@webpieces/rules-config';
import type { EnhancedGraph } from '../graph-sorter';
import type { ApiContracts } from '../api-usage/api-relations';
import { saveGraph, loadBlessedGraph, DEFAULT_GRAPH_PATH, AI_INSTRUCTIONS } from '../graph-loader';
import { ApiContractFiles } from '../api-contract-files';
import { deriveRuntimeGraph } from '../runtime-graph';
import { toError } from '../../toError';
import {
    CurrentArchitecture,
    describeTableDrift,
} from '../../executors/validate-architecture-unchanged/executor';

let root: string;

beforeEach(() => {
    root = specTempDirs.make('wp-apifiles-');
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

function graph(): EnhancedGraph {
    const task = { api: 'TaskApi', type: 'pubsub' as const };
    return {
        'task-api': { level: 0, dependsOn: [], role: 'api-lib', framework: ['node'] },
        worker: {
            level: 1,
            dependsOn: ['task-api'],
            role: 'server',
            framework: ['node'],
            apiRelations: {
                'task-api': { kind: 'uses-implements', implements: [task], uses: [task] },
            },
        },
    };
}

function contracts(): ApiContracts {
    return {
        TaskApi: {
            owner: 'task-api',
            apiKind: 'pubsub',
            basePath: '/api/tasks',
            methods: [
                {
                    name: 'send',
                    path: '/send',
                    kind: 'cloudtasks',
                    operation: 'write',
                    httpMethod: 'POST',
                    queueName: 'TaskApi-send',
                },
                {
                    name: 'nightly',
                    path: '/nightly',
                    kind: 'cron',
                    operation: 'write',
                    queueName: 'TaskApi-nightly',
                },
            ],
        },
        OtherApi: {
            owner: 'task-api',
            apiKind: 'rpc',
            basePath: '/api/other',
            methods: [{ name: 'get', path: '/get', kind: 'rpc', operation: 'write' }],
        },
    };
}

/** What architecture:generate does with a scanned table: write the api files, then link them. */
function generate(table: ApiContracts): void {
    const files = new ApiContractFiles();
    files.write(root, DEFAULT_GRAPH_PATH, table);
    saveGraph(graph(), root, DEFAULT_GRAPH_PATH, files.refsFor(table));
}

function read(rel: string): string {
    return fs.readFileSync(path.join(root, 'architecture', rel), 'utf-8');
}

/** The error loadBlessedGraph threw, or null when it loaded. */
function loadError(): Error | null {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        loadBlessedGraph(root);
        return null;
    } catch (err: unknown) {
        const error = toError(err);
        return error;
    }
}

describe('architecture/apis/<Api>.json', () => {
    it('writes the FULL contract per api and only a link in dependencies.json', () => {
        generate(contracts());
        const deps = JSON.parse(read('dependencies.json'));
        expect(deps.apiContracts).toBeUndefined();
        expect(deps.apiContractFiles).toEqual({
            OtherApi: 'apis/OtherApi.json',
            TaskApi: 'apis/TaskApi.json',
        });

        const task = JSON.parse(read('apis/TaskApi.json'));
        expect(task).toEqual({ api: 'TaskApi', ...contracts().TaskApi });
    });

    it("tells agents where an api's endpoints live", () => {
        generate(contracts());
        expect(AI_INSTRUCTIONS).toContain('apis/<ApiName>.json');
        expect(JSON.parse(read('dependencies.json')).aiInstructions).toContain('apiContractFiles');
    });

    it('adding an endpoint changes only apis/<Api>.json, never dependencies.json', () => {
        generate(contracts());
        const depsBefore = read('dependencies.json');
        const otherBefore = read('apis/OtherApi.json');
        const taskBefore = read('apis/TaskApi.json');

        const grown = contracts();
        grown.TaskApi.methods.push({
            name: 'listRuns',
            path: '/list-runs',
            kind: 'rpc',
            operation: 'write',
        });
        generate(grown);

        expect(read('dependencies.json')).toBe(depsBefore);
        expect(read('apis/OtherApi.json')).toBe(otherBefore);
        expect(read('apis/TaskApi.json')).not.toBe(taskBefore);
        expect(read('apis/TaskApi.json')).toContain('/list-runs');
    });

    it('deletes the file of an api that no longer exists', () => {
        generate(contracts());
        const shrunk = contracts();
        delete shrunk.OtherApi;
        const result = new ApiContractFiles().write(root, DEFAULT_GRAPH_PATH, shrunk);

        expect(fs.existsSync(path.join(root, 'architecture/apis/OtherApi.json'))).toBe(false);
        expect(fs.existsSync(path.join(root, 'architecture/apis/TaskApi.json'))).toBe(true);
        expect(result.deleted).toEqual([path.join(root, 'architecture/apis/OtherApi.json')]);
    });

    it('removes the apis directory once no api is left', () => {
        generate(contracts());
        new ApiContractFiles().write(root, DEFAULT_GRAPH_PATH, {});
        expect(fs.existsSync(path.join(root, 'architecture/apis'))).toBe(false);
    });

    it('keeps the files beside a non-default graphPath', () => {
        new ApiContractFiles().write(root, 'draw/dependencies.json', contracts());
        expect(fs.existsSync(path.join(root, 'draw/apis/TaskApi.json'))).toBe(true);
    });
});

describe('the runtime graph reads the per-api files', () => {
    it('derives the same queues and triggers from the loaded files as from the in-memory table', () => {
        generate(contracts());
        const loaded = loadBlessedGraph(root)!;
        const fromFiles = new ApiContractFiles().load(
            root,
            DEFAULT_GRAPH_PATH,
            loaded.apiContractFiles,
        );
        expect(fromFiles).toEqual(contracts());

        const derived = deriveRuntimeGraph(loaded.projects, new Set<string>(), fromFiles);
        expect(derived).toEqual(deriveRuntimeGraph(graph(), new Set<string>(), contracts()));
        expect(Object.keys(derived.queues)).toEqual(['TaskApi.send']);
        expect(derived.queues['TaskApi.send'].queueName).toBe('TaskApi-send');
        expect(derived.triggers).toEqual([
            {
                kind: 'cron',
                api: 'TaskApi',
                method: 'nightly',
                service: 'worker',
                queueName: 'TaskApi-nightly',
            },
        ]);
    });

    it('fails loudly when a linked file is missing', () => {
        generate(contracts());
        fs.rmSync(path.join(root, 'architecture/apis/TaskApi.json'));
        const loaded = loadBlessedGraph(root)!;
        const load = (): ApiContracts =>
            new ApiContractFiles().load(root, DEFAULT_GRAPH_PATH, loaded.apiContractFiles);
        expect(load).toThrow(RuleFailError);
        expect(load).toThrow(/TaskApi/);
    });
});

describe('a dependencies.json in the old shape', () => {
    it('is rejected with a message naming the new location and the command', () => {
        const file = path.join(root, 'architecture/dependencies.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(
            file,
            JSON.stringify({ aiInstructions: '', projects: graph(), apiContracts: contracts() }),
            'utf-8',
        );

        const error = loadError();
        expect(error).toBeInstanceOf(RuleFailError);
        const rendered = renderRuleFailForHuman(error as RuleFailError);
        expect(rendered).toContain('apiContracts');
        expect(rendered).toContain('architecture/apis/<ApiName>.json');
        expect(rendered).toContain('architecture:generate');
    });
});

describe('validate-architecture-unchanged ignores endpoint changes', () => {
    it('reports no drift when only an endpoint was added', () => {
        generate(contracts());
        const saved = loadBlessedGraph(root)!;
        const grown = contracts();
        grown.TaskApi.methods.push({
            name: 'listRuns',
            path: '/list-runs',
            kind: 'rpc',
            operation: 'write',
        });

        const current = new CurrentArchitecture(graph(), new ApiContractFiles().refsFor(grown), {});
        expect(describeTableDrift(current, saved)).toBeNull();
    });

    it('still reports an api that was added without regenerating', () => {
        generate(contracts());
        const saved = loadBlessedGraph(root)!;
        const grown = contracts();
        grown.NewApi = { owner: 'task-api', apiKind: 'rpc', basePath: '/new', methods: [] };

        const current = new CurrentArchitecture(graph(), new ApiContractFiles().refsFor(grown), {});
        expect(describeTableDrift(current, saved)).toContain('NewApi');
    });
});
