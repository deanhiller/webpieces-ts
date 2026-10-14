/**
 * Reviewed remote services (#1203): a `uses` may target one of OUR services that lives outside this
 * workspace (another repo, a VM, partner endpoints) once dependencies.json declares it under
 * `remoteServices` with the contracts it implements. Four layers fail independently, so each is
 * pinned: the strict decoder, the target validation generation runs, the runtime derivation, and the
 * drawing — plus the round trip through dependencies.json and the unchanged-architecture drift check.
 */

import * as fs from 'fs';
import { specTempDirs } from '@webpieces/tooling-testkit';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { RuleFailError } from '@webpieces/rules-config';
import { RemoteService, RemoteServiceApi, RemoteServicesCodec } from '../remote-services';
import type { RemoteServices } from '../remote-services';
import { ServiceTargetValidator } from '../runtime-wiring/service-targets';
import { deriveRuntimeGraphReport } from '../runtime-graph';
import { generateRuntimeDot } from '../runtime-visualizer';
import { loadBlessedGraph, saveGraph } from '../graph-loader';
import {
    CurrentArchitecture,
    describeTableDrift,
} from '../../executors/validate-architecture-unchanged/executor';
import type { EnhancedGraph } from '../graph-sorter';
import type { ApiContracts } from '../api-usage/api-relations';
import { toError } from '../../toError';

const FILE = 'architecture/dependencies.json';

function contracts(): ApiContracts {
    return {
        ReporterTriggerApi: { owner: 'reporter-api', apiKind: 'rpc', basePath: '/reporter', methods: [] },
        ReportTaskApi: { owner: 'reporter-api', apiKind: 'pubsub', basePath: '/tasks', methods: [] },
        InternalApi: { owner: 'internal-api', apiKind: 'rpc', basePath: '/internal', methods: [] },
    };
}

/** `dispatcher` calls `target`; `reporter-vm` is NOT a project here, `internal` is an in-repo service. */
function graph(target: string, api: string = 'ReporterTriggerApi', type: 'rpc' | 'pubsub' = 'rpc'): EnhancedGraph {
    return {
        'reporter-api': { level: 0, dependsOn: [], role: 'api-lib' },
        'internal-api': { level: 0, dependsOn: [], role: 'api-lib' },
        dispatcher: {
            level: 1,
            dependsOn: ['reporter-api'],
            role: 'server',
            serviceName: 'reports-dispatcher',
            apiRelations: {
                'reporter-api': {
                    kind: 'uses',
                    implements: [],
                    uses: [{ api, type, targetService: target }],
                },
            },
        },
        internal: {
            level: 1,
            dependsOn: ['internal-api'],
            role: 'server',
            serviceName: 'internal-svc',
            apiRelations: {
                'internal-api': {
                    kind: 'implements',
                    implements: [{ api: 'InternalApi', type: 'rpc' }],
                    uses: [],
                },
            },
        },
    };
}

function remotes(): RemoteServices {
    return {
        'reporter-vm': new RemoteService('reporter VM', [new RemoteServiceApi('ReporterTriggerApi', 'rpc')]),
    };
}

function failure(run: () => void): string {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- the spec asserts the thrown verdict
    try {
        run();
    } catch (err: unknown) {
        const error = toError(err);
        expect(error).toBeInstanceOf(RuleFailError);
        return error.message;
    }
    throw new Error('expected a RuleFailError');
}

describe('ServiceTargetValidator — targets outside the workspace', () => {
    const validator = new ServiceTargetValidator();

    it('accepts a uses whose target is a declared remote service implementing that api + transport', () => {
        expect(() => validator.validate(graph('reporter-vm'), contracts(), {}, remotes())).not.toThrow();
    });

    it('rejects an undeclared target name, naming the remoteServices table', () => {
        const message = failure(() => validator.validate(graph('reporter-vm'), contracts(), {}, {}));
        expect(message).toContain('target reporter-vm');
        expect(message).toContain('neither a workspace serviceName nor a declared remote service');
    });

    it('rejects a remote that does not declare the called api', () => {
        const declared: RemoteServices = {
            'reporter-vm': new RemoteService(undefined, [new RemoteServiceApi('ReportTaskApi', 'pubsub')]),
        };
        const message = failure(() => validator.validate(graph('reporter-vm'), contracts(), {}, declared));
        expect(message).toContain('remote service reporter-vm does not implement reporter-api#ReporterTriggerApi (rpc)');
        expect(message).toContain('declares only ReportTaskApi (pubsub)');
    });

    it('rejects a remote that declares the api over a different transport', () => {
        const message = failure(() =>
            validator.validate(graph('reporter-vm', 'ReportTaskApi', 'pubsub'), contracts(), {}, remotes()),
        );
        expect(message).toContain('does not implement reporter-api#ReportTaskApi (pubsub)');
    });

    it('rejects a remote name that collides with a workspace serviceName', () => {
        const colliding: RemoteServices = {
            'internal-svc': new RemoteService(undefined, [new RemoteServiceApi('InternalApi', 'rpc')]),
        };
        const message = failure(() => validator.validate(graph('reporter-vm'), contracts(), {}, colliding));
        expect(message).toContain('remoteServices.internal-svc collides with the workspace serviceName of internal');
    });

    it('rejects a remote name that collides with a workspace project', () => {
        const colliding: RemoteServices = {
            internal: new RemoteService(undefined, [new RemoteServiceApi('InternalApi', 'rpc')]),
        };
        const message = failure(() => validator.validate(graph('reporter-vm'), contracts(), {}, colliding));
        expect(message).toContain('remoteServices.internal collides with the workspace project internal');
    });

    it('rejects a declared api that no approved contract file declares', () => {
        const unknown: RemoteServices = {
            'reporter-vm': new RemoteService(undefined, [
                new RemoteServiceApi('ReporterTriggerApi', 'rpc'),
                new RemoteServiceApi('GhostApi', 'rpc'),
            ]),
        };
        const message = failure(() => validator.validate(graph('reporter-vm'), contracts(), {}, unknown));
        expect(message).toContain('remoteServices.reporter-vm: unknown qualified contract GhostApi (rpc)');
    });

    it('rejects a declared api whose approved contract has another transport', () => {
        const wrongKind: RemoteServices = {
            'reporter-vm': new RemoteService(undefined, [new RemoteServiceApi('ReporterTriggerApi', 'pubsub')]),
        };
        const message = failure(() => validator.validate(graph('reporter-vm'), contracts(), {}, wrongKind));
        expect(message).toContain('unknown qualified contract reporter-api#ReporterTriggerApi (pubsub)');
        expect(message).toContain('the approved contract is rpc');
    });
});

describe('RemoteServicesCodec — the reviewed table is decoded strictly', () => {
    const codec = new RemoteServicesCodec();

    it('reads absent as no remote services', () => {
        expect(codec.decode(undefined, FILE)).toEqual({});
    });

    it('decodes label and implements into classes', () => {
        const decoded = codec.decode(
            { 'reporter-vm': { label: 'reporter VM', implements: [{ api: 'ReporterTriggerApi', type: 'rpc' }] } },
            FILE,
        );
        expect(decoded['reporter-vm']).toBeInstanceOf(RemoteService);
        expect(decoded['reporter-vm'].label).toBe('reporter VM');
        expect(decoded['reporter-vm'].implementsApi('ReporterTriggerApi', 'rpc')).toBe(true);
    });

    it.each([
        ['an unknown key', { x: { implements: [{ api: 'A', type: 'rpc' }], owner: 'y' } }, 'unknown key "owner"'],
        ['an empty implements', { x: { implements: [] } }, 'implements must be a non-empty array'],
        ['an external transport', { x: { implements: [{ api: 'A', type: 'external' }] } }, 'must be "rpc" or "pubsub"'],
        ['a duplicate api', { x: { implements: [{ api: 'A', type: 'rpc' }, { api: 'A', type: 'pubsub' }] } }, 'declared twice'],
        ['an empty label', { x: { label: '', implements: [{ api: 'A', type: 'rpc' }] } }, 'label must be a non-empty string'],
    ])('rejects %s', (_name: string, value: Record<string, unknown>, expected: string) => {
        expect(failure(() => codec.decode(value, FILE))).toContain(expected);
    });
});

describe('the runtime graph draws remote services as service nodes', () => {
    it('claims the call for the remote instead of an unresolved vendor box', () => {
        const report = deriveRuntimeGraphReport(graph('reporter-vm'), new Set(), contracts(), {}, remotes());
        expect(report.problems).toEqual([]);
        expect(report.graph.unresolvedUses).toEqual([]);
        expect(report.graph.remoteServices).toEqual({
            'reporter-vm': {
                level: 0, levelBecause: 'outbound sink',
                label: 'reporter VM',
                implements: ['ReporterTriggerApi (rpc)'],
                calledBy: [{ from: 'dispatcher', via: ['ReporterTriggerApi'], type: 'rpc' }],
            },
        });
    });

    it('omits the table entirely when nothing is declared, so existing graphs are byte-identical', () => {
        const report = deriveRuntimeGraphReport(graph('reporter-vm'), new Set(), contracts());
        expect(report.graph.remoteServices).toBeUndefined();
        expect(report.graph.unresolvedUses).toEqual([{ level: 0, levelBecause: 'outbound sink', service: 'dispatcher', api: 'ReporterTriggerApi' }]);
    });

    it('reports a remote that does not declare the called api', () => {
        const declared: RemoteServices = {
            'reporter-vm': new RemoteService(undefined, [new RemoteServiceApi('ReportTaskApi', 'pubsub')]),
        };
        const report = deriveRuntimeGraphReport(graph('reporter-vm'), new Set(), contracts(), {}, declared);
        expect(report.problems.join('\n')).toContain("remote service 'reporter-vm'");
    });

    it('never lets a remote name shadow a workspace module', () => {
        const colliding: RemoteServices = {
            'internal-svc': new RemoteService(undefined, [new RemoteServiceApi('InternalApi', 'rpc')]),
        };
        const report = deriveRuntimeGraphReport(graph('reporter-vm'), new Set(), contracts(), {}, colliding);
        expect(report.problems.join('\n')).toContain("remoteServices declares 'internal-svc'");
    });

    it('renders a distinct remote service node with an edge from its caller', () => {
        const report = deriveRuntimeGraphReport(graph('reporter-vm'), new Set(), contracts(), {}, remotes());
        const dot = generateRuntimeDot(report.graph);
        expect(dot).toContain('"remote__reporter_vm" [shape=box, style="filled,rounded,bold"');
        expect(dot).toContain('reporter VM\\nreporter-vm\\n(remote service)');
        expect(dot).toMatch(/"dispatcher" -> "remote__reporter_vm" \[label="ReporterTriggerApi"/);
        expect(dot).not.toContain('external__');
    });
});

describe('dependencies.json carries the reviewed table unchanged', () => {
    it('round-trips through saveGraph and loadBlessedGraph', () => {
        const root = specTempDirs.make('remote-services-');
        saveGraph(graph('reporter-vm'), root, FILE, {}, {}, remotes());
        const text = fs.readFileSync(path.join(root, FILE), 'utf-8');
        expect(text).toContain('"remoteServices": {');
        const loaded = loadBlessedGraph(root, FILE)!;
        expect(loaded.remoteServices).toEqual(remotes());
    });

    it('omits the block when nothing is declared', () => {
        const root = specTempDirs.make('remote-services-');
        saveGraph(graph('reporter-vm'), root, FILE);
        expect(fs.readFileSync(path.join(root, FILE), 'utf-8')).not.toContain('remoteServices');
    });

    it('reports remoteServices drift like the other saved tables', () => {
        const root = specTempDirs.make('remote-services-');
        saveGraph(graph('reporter-vm'), root, FILE);
        const saved = loadBlessedGraph(root, FILE)!;
        const current = new CurrentArchitecture(graph('reporter-vm'), {}, {}, remotes());
        expect(describeTableDrift(current, saved)).toContain('remoteServices drift');
    });
});
