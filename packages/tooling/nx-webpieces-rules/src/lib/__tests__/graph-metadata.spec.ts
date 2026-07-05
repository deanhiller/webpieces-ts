/**
 * Tests for the AI metadata enrichment of architecture/dependencies.json:
 * shortDescription extraction, framework resolution, and enrichGraph()
 * aggregate validation against a temp fixture workspace.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { EnhancedGraph } from '../graph-sorter';
import { ProjectInfo } from '../project-info';
import { resolveFramework } from '../framework-resolver';
import {
    extractShortDescription,
    validateShortDescription,
    MAX_SHORT_DESCRIPTION_LENGTH,
} from '../responsibilities';
import { enrichGraph, MetadataValidationError, validateLibraryTypesMatch } from '../graph-metadata';
import { toError } from '../../toError';

describe('extractShortDescription', () => {
    it('takes the first paragraph after the heading', () => {
        const md = '# Responsibilities — http-routing\n\nMatches filters to routes.\n\n## Detail\nMore text.\n';
        expect(extractShortDescription(md)).toBe('Matches filters to routes.');
    });

    it('collapses a multi-line paragraph to single spaces', () => {
        const md = '# Title\n\nLine one\nline two\nline three.\n\nSecond paragraph.\n';
        expect(extractShortDescription(md)).toBe('Line one line two line three.');
    });

    it('skips multiple leading headings and blank lines', () => {
        const md = '# A\n\n## B\n\n\nThe summary.\n';
        expect(extractShortDescription(md)).toBe('The summary.');
    });

    it('returns empty string for a file with only headings', () => {
        expect(extractShortDescription('# Only a heading\n\n## And another\n')).toBe('');
    });

    it('works without any heading', () => {
        expect(extractShortDescription('Just a summary.\n\n## Detail\n')).toBe('Just a summary.');
    });
});

describe('validateShortDescription', () => {
    it('accepts a normal summary', () => {
        expect(validateShortDescription('A fine summary.', 'x/responsibilities.md')).toBeNull();
    });

    it('rejects an empty summary', () => {
        const problem = validateShortDescription('', 'x/responsibilities.md');
        expect(problem).toContain('no summary paragraph');
    });

    it('rejects a summary over the max length', () => {
        const long = 'a'.repeat(MAX_SHORT_DESCRIPTION_LENGTH + 1);
        const problem = validateShortDescription(long, 'x/responsibilities.md');
        expect(problem).toContain(`max ${MAX_SHORT_DESCRIPTION_LENGTH}`);
    });
});

describe('resolveFramework', () => {
    let tmpRoot: string;

    beforeAll(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-framework-'));
    });

    afterAll(() => {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    function writeProject(name: string, pkgJson: object | null): ProjectInfo {
        const root = path.join('projects', name);
        fs.mkdirSync(path.join(tmpRoot, root), { recursive: true });
        if (pkgJson !== null) {
            fs.writeFileSync(
                path.join(tmpRoot, root, 'package.json'),
                JSON.stringify(pkgJson),
                'utf-8'
            );
        }
        return new ProjectInfo(name, root, []);
    }

    it('explicit framework tag wins over inference', () => {
        const info = writeProject('tagged', { dependencies: { react: '18.0.0' } });
        const tagged = new ProjectInfo(info.name, info.root, ['framework:angular']);
        const resolution = resolveFramework(tagged, tmpRoot);
        expect(resolution.framework).toBe('angular');
        expect(resolution.problem).toBeNull();
    });

    it('reports a problem for multiple framework tags', () => {
        const info = new ProjectInfo('dupe', 'projects/dupe', ['framework:react', 'framework:express']);
        const resolution = resolveFramework(info, tmpRoot);
        expect(resolution.framework).toBeNull();
        expect(resolution.problem).toContain('at most one');
    });

    it('infers angular from @angular/core', () => {
        const info = writeProject('ng', { dependencies: { '@angular/core': '20.0.0' } });
        expect(resolveFramework(info, tmpRoot).framework).toBe('angular');
    });

    it('infers react from react dependency', () => {
        const info = writeProject('rx', { devDependencies: { react: '18.0.0' } });
        expect(resolveFramework(info, tmpRoot).framework).toBe('react');
    });

    it('infers express from express dependency', () => {
        const info = writeProject('ex', { dependencies: { express: '5.0.0' } });
        expect(resolveFramework(info, tmpRoot).framework).toBe('express');
    });

    it('falls back to all with no framework deps', () => {
        const info = writeProject('lib', { dependencies: { inversify: '7.0.0' } });
        expect(resolveFramework(info, tmpRoot).framework).toBe('all');
    });

    it('falls back to all with no package.json', () => {
        const info = writeProject('bare', null);
        expect(resolveFramework(info, tmpRoot).framework).toBe('all');
    });
});

describe('validateLibraryTypesMatch', () => {
    function graphOf(entries: Record<string, { framework?: string; dependsOn: string[] }>): EnhancedGraph {
        const graph: EnhancedGraph = {};
        for (const [name, entry] of Object.entries(entries)) {
            graph[name] = { level: 0, dependsOn: entry.dependsOn, framework: entry.framework };
        }
        return graph;
    }

    it('allows a side project to depend on an all library', () => {
        const problems: string[] = [];
        validateLibraryTypesMatch(
            graphOf({ web: { framework: 'angular', dependsOn: ['lib'] }, lib: { framework: 'all', dependsOn: [] } }),
            problems
        );
        expect(problems).toEqual([]);
    });

    it('allows same-libType dependencies', () => {
        const problems: string[] = [];
        validateLibraryTypesMatch(
            graphOf({ svr: { framework: 'express', dependsOn: ['http'] }, http: { framework: 'express', dependsOn: [] } }),
            problems
        );
        expect(problems).toEqual([]);
    });

    it('flags an express project depending on an angular library', () => {
        const problems: string[] = [];
        validateLibraryTypesMatch(
            graphOf({ svr: { framework: 'express', dependsOn: ['ui'] }, ui: { framework: 'angular', dependsOn: [] } }),
            problems
        );
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain("'svr' (express) must not depend on 'ui' (angular)");
    });

    it('flags an all library depending on a side-specific library', () => {
        const problems: string[] = [];
        validateLibraryTypesMatch(
            graphOf({ shared: { framework: 'all', dependsOn: ['ng'] }, ng: { framework: 'angular', dependsOn: [] } }),
            problems
        );
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain("'shared' (all) must not depend on 'ng' (angular)");
    });

    it('skips edges where either endpoint has no resolved framework', () => {
        const problems: string[] = [];
        validateLibraryTypesMatch(
            graphOf({ a: { dependsOn: ['b'] }, b: { framework: 'angular', dependsOn: [] } }),
            problems
        );
        expect(problems).toEqual([]);
    });
});

class FixtureProject {
    constructor(
        public readonly name: string,
        public readonly responsibilitiesMd: string | null,
        public readonly hasProjectJson: boolean,
        public readonly tags: string[] = []
    ) {}
}

let enrichTmpRoot: string;

function setupWorkspace(prefix: string, projects: FixtureProject[]): Map<string, ProjectInfo> {
    const infos = new Map<string, ProjectInfo>();
    for (const project of projects) {
        const root = path.join(prefix, project.name);
        fs.mkdirSync(path.join(enrichTmpRoot, root), { recursive: true });
        if (project.responsibilitiesMd !== null) {
            fs.writeFileSync(
                path.join(enrichTmpRoot, root, 'responsibilities.md'),
                project.responsibilitiesMd,
                'utf-8'
            );
        }
        if (project.hasProjectJson) {
            fs.writeFileSync(
                path.join(enrichTmpRoot, root, 'project.json'),
                JSON.stringify({ name: project.name }),
                'utf-8'
            );
        }
        infos.set(project.name, new ProjectInfo(project.name, root, project.tags));
    }
    return infos;
}

function enrichAndCatch(graph: EnhancedGraph, infos: Map<string, ProjectInfo>): MetadataValidationError {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        enrichGraph(graph, infos, enrichTmpRoot);
    } catch (err: unknown) {
        const error = toError(err);
        expect(error).toBeInstanceOf(MetadataValidationError);
        return error as MetadataValidationError;
    }
    throw new Error('expected enrichGraph to throw MetadataValidationError');
}

describe('enrichGraph', () => {
    beforeAll(() => {
        enrichTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-enrich-'));
    });

    afterAll(() => {
        fs.rmSync(enrichTmpRoot, { recursive: true, force: true });
    });

    it('fills all metadata fields on a valid workspace', () => {
        const infos = setupWorkspace('good', [
            new FixtureProject('alpha', '# Responsibilities — alpha\n\nDoes alpha things.\n', true),
            new FixtureProject('beta', '# Responsibilities — beta\n\nDoes beta things.\n', false, [
                'framework:express',
            ]),
        ]);
        const graph: EnhancedGraph = {
            alpha: { level: 0, dependsOn: [] },
            beta: { level: 1, dependsOn: ['alpha'] },
        };

        enrichGraph(graph, infos, enrichTmpRoot);

        expect(graph['alpha'].framework).toBe('all');
        expect(graph['alpha'].shortDescription).toBe('Does alpha things.');
        expect(graph['alpha'].responsibilitiesFile).toBe('good/alpha/responsibilities.md');
        expect(graph['alpha'].designFile).toBe('good/alpha/design.json');

        expect(graph['beta'].framework).toBe('express');
        // no project.json → no generated design.json → no designFile
        expect(graph['beta'].designFile).toBeUndefined();
    });

    it('aggregates ALL problems across projects into one error', () => {
        const infos = setupWorkspace('bad', [
            new FixtureProject('missing', null, true),
            new FixtureProject('empty', '# Heading only\n', true),
            new FixtureProject(
                'toolong',
                '# T\n\n' + 'x'.repeat(MAX_SHORT_DESCRIPTION_LENGTH + 50) + '\n',
                true
            ),
        ]);
        const graph: EnhancedGraph = {
            missing: { level: 0, dependsOn: [] },
            empty: { level: 0, dependsOn: [] },
            toolong: { level: 0, dependsOn: [] },
        };

        const thrown = enrichAndCatch(graph, infos);

        expect(thrown.problems).toHaveLength(3);
        expect(thrown.message).toContain('missing required bad/missing/responsibilities.md');
        expect(thrown.message).toContain('no summary paragraph');
        expect(thrown.message).toContain('max ' + MAX_SHORT_DESCRIPTION_LENGTH);
    });

    it('reports projects absent from the nx project graph', () => {
        const graph: EnhancedGraph = { ghost: { level: 0, dependsOn: [] } };
        expect(() => enrichGraph(graph, new Map(), enrichTmpRoot)).toThrow(/ghost: not found/);
    });
});
