/**
 * External system declarations — the two ways a repo says "this thing outside us is a DATABASE".
 *
 * Both sites exist because the two real cases differ in whether a contract exists to mark:
 *  - a WRAPPED vendor seam (`FirestoreAdminApi`) carries an `@externalSystem` JSDoc tag;
 *  - an UNWRAPPED datastore (a `pg.Pool`, a TypeORM `DataSource`) has no contract at all, so the
 *    declaration is an `external:<kind>:<identity>` nx tag on the project that opens it.
 *
 * The cases that matter most here are the ones a reader would get wrong by guessing: that identity
 * (not display text) decides node convergence, that a tag never fans out to dependents, and that
 * declaring nothing leaves the graph byte-identical to before this feature existed.
 */

import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { buildExternalSystems, resolveExternalSystems, attachExternalSystems } from '../api-usage/external-systems';
import { externalApiInfoFrom } from '../api-usage/api-ast';
import type { ApiClassInfo, ExternalSystemDecls } from '../api-usage/api-relations';
import type { RuntimeGraph, RuntimeService } from '../runtime-graph-model';
import { ProjectInfo } from '../project-info';
import { generateRuntimeDot } from '../runtime-visualizer';

/** Parse `source` and hand the FIRST interface/abstract-class declaration to externalApiInfoFrom. */
function scanContract(source: string, project: string = 'lib-firestore'): ApiClassInfo | null {
    const file = ts.createSourceFile('seam.ts', source, ts.ScriptTarget.Latest, true);
    let found: ApiClassInfo | null = null;
    const walk = (node: ts.Node): void => {
        if (found === null) found = externalApiInfoFrom(node, project);
        ts.forEachChild(node, walk);
    };
    walk(file);
    return found;
}

function service(uses: string[]): RuntimeService {
    return { level: 0, implements: [], uses, dependsOn: [] };
}

describe('@externalSystem JSDoc tag on a wrapped vendor contract', () => {
    it('reads the kind and the explicit label', () => {
        const info = scanContract(`
            /**
             * The vendor seam for Firestore.
             * @externalSystem database Firestore
             */
            export interface FirestoreAdminApi { get(): Promise<void>; }
        `);
        expect(info?.externalSystem).toEqual({ kind: 'database', label: 'Firestore' });
    });

    it('defaults the label to the contract name minus its Api suffix', () => {
        const info = scanContract(`
            /** @externalSystem database */
            export interface FirestoreAdminApi { get(): Promise<void>; }
        `);
        expect(info?.externalSystem).toEqual({ kind: 'database', label: 'FirestoreAdmin' });
    });

    it('keeps a multi-word label intact', () => {
        const info = scanContract(`
            /** @externalSystem database Postgres (kami) */
            export interface KamiApi { get(): Promise<void>; }
        `);
        expect(info?.externalSystem?.label).toBe('Postgres (kami)');
    });

    it('IGNORES an unrecognised kind rather than defaulting it', () => {
        // A typo drawing the WRONG shape teaches the reader something false about the architecture;
        // falling back to the generic box merely fails to teach them something new.
        const info = scanContract(`
            /** @externalSystem databse Firestore */
            export interface FirestoreAdminApi { get(): Promise<void>; }
        `);
        expect(info).not.toBeNull();
        expect(info?.externalSystem).toBeUndefined();
    });

    it('leaves an undeclared vendor contract exactly as it was', () => {
        const info = scanContract('export interface GmailApi { send(): Promise<void>; }');
        expect(info?.api).toBe('GmailApi');
        expect(info?.externalSystem).toBeUndefined();
    });
});

describe('external:<kind>:<identity> nx tag on an unwrapped project', () => {
    const infos = (tags: string[]): Map<string, ProjectInfo> =>
        new Map([['pg-dataaccess', new ProjectInfo('pg-dataaccess', 'services/pg-dataaccess', tags)]]);

    it('declares the system from the tag', () => {
        const systems = buildExternalSystems(new Map(), infos(['role:server', 'external:database:postgres']));
        expect(systems['postgres']).toEqual({
            kind: 'database',
            label: 'postgres',
            apis: [],
            projects: ['pg-dataaccess'],
        });
    });

    it('ignores unrelated tags and malformed external tags', () => {
        const bad = ['role:server', 'external:database', 'external:databse:pg', 'external::pg', 'external:database:'];
        expect(buildExternalSystems(new Map(), infos(bad))).toEqual({});
    });
});

describe('resolving declarations to arrows', () => {
    it('converges two projects declaring the same identity on ONE node', () => {
        const infos = new Map([
            ['pg-dataaccess', new ProjectInfo('pg-dataaccess', 'services/pg', ['external:database:postgres'])],
            ['ai-chat', new ProjectInfo('ai-chat', 'services/ai', ['external:database:postgres'])],
        ]);
        const decls = buildExternalSystems(new Map(), infos);
        const resolved = resolveExternalSystems(decls, {
            'pg-dataaccess': service([]),
            'ai-chat': service([]),
        });
        expect(Object.keys(resolved)).toEqual(['postgres']);
        expect(resolved['postgres'].usedBy).toEqual(['ai-chat', 'pg-dataaccess']);
    });

    it('gives a contract-declared system an arrow from every service that USES the contract', () => {
        const decls: ExternalSystemDecls = {
            Firestore: { kind: 'database', label: 'Firestore', apis: ['FirestoreAdminApi'], projects: [] },
        };
        const resolved = resolveExternalSystems(decls, {
            'helper-fsdb-svr': service(['FirestoreAdminApi']),
            'lang-fsdb-svr': service(['FirestoreAdminApi']),
            unrelated: service(['SomethingElseApi']),
        });
        expect(resolved['Firestore'].usedBy).toEqual(['helper-fsdb-svr', 'lang-fsdb-svr']);
    });

    it('does NOT fan a tag out to projects that merely depend on the tagged one', () => {
        // A tag asserts "I open this connection". Fanning out would invent an arrow for a service
        // that depends on the entity library only for a DTO type.
        const decls: ExternalSystemDecls = {
            postgres: { kind: 'database', label: 'postgres', apis: [], projects: ['pg-dataaccess'] },
        };
        const resolved = resolveExternalSystems(decls, {
            'pg-dataaccess': service([]),
            'ai-chat': service([]),
        });
        expect(resolved['postgres'].usedBy).toEqual(['pg-dataaccess']);
    });

    it('drops a declaration nothing reaches instead of drawing a floating node', () => {
        const decls: ExternalSystemDecls = {
            postgres: { kind: 'database', label: 'postgres', apis: [], projects: ['deleted-svc'] },
        };
        expect(resolveExternalSystems(decls, { 'ai-chat': service([]) })).toEqual({});
    });
});

describe('attaching to the runtime graph', () => {
    const emptyGraph = (): RuntimeGraph => ({
        services: {},
        apis: { FirestoreAdminApi: { implementedBy: [], usedBy: ['svc'] } },
        runtimeEdges: [],
        unresolvedUses: [],
        queues: {},
        triggers: [],
    });

    it('stamps the declaring contract so the viz does not ALSO draw it as a generic box', () => {
        const graph = emptyGraph();
        attachExternalSystems(graph, {
            Firestore: { kind: 'database', label: 'Firestore', usedBy: ['svc'], apis: ['FirestoreAdminApi'] },
        });
        expect(graph.apis['FirestoreAdminApi'].externalSystem).toEqual({ kind: 'database', label: 'Firestore' });
    });

    it('leaves a graph with nothing declared completely untouched', () => {
        // The adoption promise: a repo that declares none of this keeps a byte-identical file, so
        // shipping the feature is a no-op diff rather than a forced migration.
        const graph = emptyGraph();
        attachExternalSystems(graph, {});
        expect(graph.externalSystems).toBeUndefined();
        expect(graph.apis['FirestoreAdminApi'].externalSystem).toBeUndefined();
    });
});

describe('rendering a declared external system', () => {
    /** A graph where `svc` uses a firestore seam declared as a database. */
    function graphWithDatabase(): RuntimeGraph {
        const graph: RuntimeGraph = {
            services: { svc: service(['FirestoreAdminApi']) },
            apis: { FirestoreAdminApi: { implementedBy: [], usedBy: ['svc'], type: 'external', owner: 'lib-firestore' } },
            runtimeEdges: [],
            unresolvedUses: [{ service: 'svc', api: 'FirestoreAdminApi' }],
            queues: {},
            triggers: [],
        };
        attachExternalSystems(graph, {
            Firestore: { kind: 'database', label: 'Firestore', usedBy: ['svc'], apis: ['FirestoreAdminApi'] },
        });
        return graph;
    }

    it('draws it as a cylinder, not the generic grey box', () => {
        const dot = generateRuntimeDot(graphWithDatabase());
        expect(dot).toContain('shape=cylinder');
        expect(dot).toContain('(external database)');
    });

    it('draws the arrow SOLID — a database read blocks and returns a value', () => {
        // Dashed means "event, returns once queued". A firestore call is neither, and drawing it
        // dashed is what made a blocking read look asynchronous.
        const dot = generateRuntimeDot(graphWithDatabase());
        const line = dot.split('\n').find((l: string) => l.includes('"svc" -> "system__Firestore"'));
        expect(line).toBeDefined();
        expect(line).not.toContain('style=dashed');
    });

    it('does not ALSO draw the contract as a generic external box', () => {
        const dot = generateRuntimeDot(graphWithDatabase());
        expect(dot).not.toContain('external__lib-firestore');
    });

    it('still draws an UNdeclared external exactly as before', () => {
        const dot = generateRuntimeDot({
            services: { svc: service(['ReporterTriggerApi']) },
            apis: { ReporterTriggerApi: { implementedBy: [], usedBy: ['svc'], owner: 'reporter-trigger-api' } },
            runtimeEdges: [],
            unresolvedUses: [{ service: 'svc', api: 'ReporterTriggerApi' }],
            queues: {},
            triggers: [],
        });
        expect(dot).toContain('external__reporter-trigger-api');
        expect(dot).toContain('style="dashed,filled"');
    });
});
