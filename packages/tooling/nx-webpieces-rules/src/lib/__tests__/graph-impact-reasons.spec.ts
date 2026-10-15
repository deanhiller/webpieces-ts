/**
 * WHY nx put each project into the affected set (#1264), classified with nx's OWN locators — the
 * same functions `filterAffected` runs, imported straight from nx here — on a synthetic graph.
 *
 * The regression this pins: a changed file that matches another project's `{workspaceRoot}/...`
 * target input glob IMPLICITLY touches that project. It must be labelled "implicitly touched" with
 * the target, the glob and the file — never "dependent: uses a changed project", which the graph
 * around it cannot show.
 */

import { describe, it, expect } from 'vitest';
import type { NxJsonConfiguration, ProjectGraph } from '@nx/devkit';
import type { FileChange } from 'nx/src/project-graph/file-utils';
import { getImplicitlyTouchedProjects, getTouchedProjects } from 'nx/src/project-graph/affected/locators/workspace-projects';
import { jsonDiff } from 'nx/src/utils/json-diff';
import {
    AffectedClass,
    AffectedClassification,
    AffectedClassifier,
    AffectedInputs,
    AffectedReason,
} from '../graph-impact-reasons';
import { ImpactGraphFixture } from './graph-impact-fixture';

const nxLocators = ImpactGraphFixture.locators;
const wholeFile = ImpactGraphFixture.wholeFile;
const project = ImpactGraphFixture.project;
const graphOf = ImpactGraphFixture.graph;

const NX_JSON: NxJsonConfiguration = { namedInputs: { default: ['{projectRoot}/**/*'] } };
const WIRING_GLOB = '{workspaceRoot}/**/src/wiring.ts';

/**
 * svc-a owns the change. gateway uses svc-a. public-api uses NOTHING changed, but its
 * `wiring-check` target reads every service's wiring.ts through a {workspaceRoot} glob; its client
 * uses public-api.
 */
function wiringGraph(): ProjectGraph {
    return graphOf(
        [
            project('svc-a', 'services/a'),
            project('gateway', 'services/gateway'),
            project('public-api', 'services/public-api', {
                'wiring-check': { executor: 'nx:noop', inputs: ['default', WIRING_GLOB] },
            }),
            project('public-api-client', 'libs/public-api-client'),
            project('untouched', 'libs/untouched'),
        ],
        [
            ['gateway', 'svc-a'],
            ['public-api-client', 'public-api'],
        ],
    );
}

async function classify(graph: ProjectGraph, changes: FileChange[], affected: string[], nxJson = NX_JSON): Promise<AffectedClassification> {
    return new AffectedClassifier(nxLocators()).classify(new AffectedInputs(graph, nxJson, ImpactGraphFixture.PACKAGE_JSON, changes, affected));
}

function reasonOf(classification: AffectedClassification, name: string): AffectedReason {
    const reason = classification.reasons.find((candidate: AffectedReason): boolean => candidate.project === name);
    expect(reason, `no reason for ${name}`).toBeDefined();
    return reason as AffectedReason;
}

describe('AffectedClassifier (#1264): why nx included each project, by nx\'s own locators', () => {
    it('labels a project a changed wiring.ts reaches through a {workspaceRoot} input as IMPLICITLY touched, never dependent', async () => {
        const graph = wiringGraph();
        const changes = [wholeFile('services/a/src/wiring.ts')];
        // What nx itself would mark: the owner, its dependents, the implicit project and ITS dependents.
        expect(getTouchedProjects(changes, graph.nodes)).toEqual(['svc-a']);
        expect(getImplicitlyTouchedProjects(changes, graph.nodes, NX_JSON)).toEqual(['public-api']);
        const result = await classify(graph, changes, ['gateway', 'public-api', 'public-api-client', 'svc-a']);

        expect(result.of(AffectedClass.CHANGED)).toEqual(['svc-a']);
        expect(result.of(AffectedClass.IMPLICIT)).toEqual(['public-api']);
        expect(result.of(AffectedClass.DEPENDENT)).toEqual(['gateway', 'public-api-client']);
        expect(result.of(AffectedClass.UNEXPLAINED)).toEqual([]);

        const implicit = reasonOf(result, 'public-api');
        expect(implicit.kind).toBe(AffectedClass.IMPLICIT);
        expect(implicit.target).toBe('wiring-check');
        expect(implicit.input).toBe(WIRING_GLOB);
        expect(implicit.files).toEqual(['services/a/src/wiring.ts']);
        expect(implicit.detail).toBe(`wiring-check input ${WIRING_GLOB} matched services/a/src/wiring.ts`);
        expect(implicit.detail).not.toContain('uses');
        expect(implicit.path).toEqual([]);
    });

    it('gives a dependent the edge path to its NEAREST changed or touched project', async () => {
        const result = await classify(wiringGraph(), [wholeFile('services/a/src/wiring.ts')], ['gateway', 'public-api', 'public-api-client', 'svc-a']);
        const gateway = reasonOf(result, 'gateway');
        expect(gateway.path).toEqual(['gateway', 'svc-a']);
        expect(gateway.detail).toBe('uses a changed project: gateway -> svc-a');
        // A dependent of an implicitly touched project says so: it uses no CHANGED project.
        const client = reasonOf(result, 'public-api-client');
        expect(client.path).toEqual(['public-api-client', 'public-api']);
        expect(client.detail).toBe('uses a touched project: public-api-client -> public-api');
    });

    it('lists the changed files a changed project owns, and the changed files nobody owns', async () => {
        const changes = [wholeFile('services/a/src/main.ts'), wholeFile('services/a/README.md'), wholeFile('pnpm-workspace.yaml')];
        const result = await classify(wiringGraph(), changes, ['gateway', 'svc-a']);
        expect(reasonOf(result, 'svc-a').files).toEqual(['services/a/src/main.ts', 'services/a/README.md']);
        expect(reasonOf(result, 'svc-a').detail).toBe('owns 2 changed files');
        expect(result.globalFiles).toEqual(['pnpm-workspace.yaml']);
    });

    it('opens named inputs to find the glob, asking nx\'s locator alone with each input', async () => {
        const graph = graphOf([project('svc-a', 'services/a'), project('docs', 'apps/docs', { build: { inputs: ['wiring'] } })], []);
        const nxJson: NxJsonConfiguration = { namedInputs: { default: ['{projectRoot}/**/*'], wiring: ['{projectRoot}/x.md', { fileset: WIRING_GLOB }] } };
        const result = await classify(graph, [wholeFile('services/a/src/wiring.ts')], ['docs', 'svc-a'], nxJson);
        const docs = reasonOf(result, 'docs');
        expect([docs.kind, docs.target, docs.input]).toEqual([AffectedClass.IMPLICIT, 'build', WIRING_GLOB]);
    });

    it('labels every project nx.json marks as ROOT-FILE touched, except the one that owns a changed file', async () => {
        const changes = [wholeFile('nx.json'), wholeFile('services/a/src/main.ts')];
        const all = ['gateway', 'public-api', 'public-api-client', 'svc-a', 'untouched'];
        const result = await classify(wiringGraph(), changes, all);
        expect(result.of(AffectedClass.CHANGED)).toEqual(['svc-a']);
        expect(result.of(AffectedClass.ROOT_FILE)).toEqual(['gateway', 'public-api', 'public-api-client', 'untouched']);
        expect(reasonOf(result, 'untouched').detail).toBe('nx.json changed: nx marks every project');
        expect(result.of(AffectedClass.DEPENDENT)).toEqual([]);
    });

    it('labels a lockfile change as ROOT-FILE touched with the lockfile named', async () => {
        const result = await classify(wiringGraph(), [wholeFile('pnpm-lock.yaml')], ['gateway', 'svc-a']);
        expect(result.of(AffectedClass.ROOT_FILE)).toEqual(['gateway', 'svc-a']);
        expect(reasonOf(result, 'gateway').detail).toBe('pnpm-lock.yaml changed (nx lockfile changes)');
        expect(reasonOf(result, 'gateway').files).toEqual(['pnpm-lock.yaml']);
    });

    it('labels a project one edge from a package.json-touched npm package as ROOT-FILE touched, with the edge', async () => {
        const graph = graphOf([project('svc-a', 'services/a'), project('gateway', 'services/gateway')], [['svc-a', 'npm:lodash'], ['gateway', 'svc-a']], ['npm:lodash']);
        const before = { dependencies: { lodash: '1.0.0' } };
        const after = { dependencies: { lodash: '2.0.0' } };
        const packageJson: FileChange = { file: 'package.json', getChanges: () => jsonDiff(before, after) };
        const result = await new AffectedClassifier(nxLocators()).classify(new AffectedInputs(graph, NX_JSON, ImpactGraphFixture.PACKAGE_JSON, [packageJson], ['gateway', 'svc-a']));
        const svc = reasonOf(result, 'svc-a');
        expect(svc.kind).toBe(AffectedClass.ROOT_FILE);
        expect(svc.path).toEqual(['svc-a', 'npm:lodash']);
        expect(svc.detail).toBe('uses npm:lodash: package.json changed (nx package.json dependency changes)');
        expect(reasonOf(result, 'gateway').path).toEqual(['gateway', 'svc-a']);
        expect(reasonOf(result, 'gateway').kind).toBe(AffectedClass.DEPENDENT);
    });

    it('says UNEXPLAINED — never dependent — for an affected project no locator and no edge explains', async () => {
        const result = await classify(wiringGraph(), [wholeFile('services/a/src/main.ts')], ['svc-a', 'untouched']);
        expect(result.of(AffectedClass.UNEXPLAINED)).toEqual(['untouched']);
        expect(result.of(AffectedClass.DEPENDENT)).toEqual([]);
    });
});
