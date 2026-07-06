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
import { enrichGraph, MetadataValidationError, validateLibraryTypesMatch, validateRoleDependencies } from '../graph-metadata';
import { resolveRole } from '../role-resolver';
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
        fs.writeFileSync(path.join(tmpRoot, root, 'package.json'), JSON.stringify(pkgJson), 'utf-8');
    }
    return new ProjectInfo(name, root, []);
}

describe('resolveFramework', () => {
    it('explicit framework tag wins over inference (single-element env set)', () => {
        const info = writeProject('tagged', { dependencies: { react: '18.0.0' } });
        const tagged = new ProjectInfo(info.name, info.root, ['framework:angular']);
        const resolution = resolveFramework(tagged, tmpRoot);
        expect(resolution.frameworks).toEqual(['angular']);
        expect(resolution.problem).toBeNull();
    });

    it('resolves MULTIPLE framework tags to an env set', () => {
        const info = new ProjectInfo('multi', 'projects/multi', ['framework:browser', 'framework:node']);
        const resolution = resolveFramework(info, tmpRoot);
        expect(resolution.frameworks).toEqual(['browser', 'node']);
        expect(resolution.problem).toBeNull();
    });

    it('de-duplicates repeated framework tags', () => {
        const info = new ProjectInfo('dupe', 'projects/dupe', ['framework:node', 'framework:node']);
        expect(resolveFramework(info, tmpRoot).frameworks).toEqual(['node']);
    });

    it('reports a problem for an empty framework value', () => {
        const info = new ProjectInfo('blank', 'projects/blank', ['framework:']);
        const resolution = resolveFramework(info, tmpRoot);
        expect(resolution.frameworks).toBeNull();
        expect(resolution.problem).toContain('empty value');
    });

    it('infers angular from @angular/core', () => {
        const info = writeProject('ng', { dependencies: { '@angular/core': '20.0.0' } });
        expect(resolveFramework(info, tmpRoot).frameworks).toEqual(['angular']);
    });

    it('infers react from react dependency', () => {
        const info = writeProject('rx', { devDependencies: { react: '18.0.0' } });
        expect(resolveFramework(info, tmpRoot).frameworks).toEqual(['react']);
    });

    it('infers express from express dependency', () => {
        const info = writeProject('ex', { dependencies: { express: '5.0.0' } });
        expect(resolveFramework(info, tmpRoot).frameworks).toEqual(['express']);
    });

    it('is a PROBLEM (no silent "all") when nothing is inferable from package.json', () => {
        const info = writeProject('lib', { dependencies: { inversify: '7.0.0' } });
        const resolution = resolveFramework(info, tmpRoot);
        expect(resolution.frameworks).toBeNull();
        expect(resolution.problem).toContain('no');
    });

    it('is a PROBLEM when there is no framework tag and no package.json', () => {
        const info = writeProject('bare', null);
        const resolution = resolveFramework(info, tmpRoot);
        expect(resolution.frameworks).toBeNull();
        expect(resolution.problem).toContain('declare the env set');
    });
});

function graphOf(entries: Record<string, { framework?: string[]; dependsOn: string[] }>): EnhancedGraph {
    const graph: EnhancedGraph = {};
    for (const [name, entry] of Object.entries(entries)) {
        graph[name] = { level: 0, dependsOn: entry.dependsOn, framework: entry.framework };
    }
    return graph;
}

describe('validateLibraryTypesMatch (up-set lattice on env sets)', () => {
    it('lets react consume its own browser ancestor (react → browser)', () => {
        const problems: string[] = [];
        validateLibraryTypesMatch(
            graphOf({ web: { framework: ['react'], dependsOn: ['lib'] }, lib: { framework: ['browser'], dependsOn: [] } }),
            problems
        );
        expect(problems).toEqual([]);
    });

    it('allows same-env dependencies', () => {
        const problems: string[] = [];
        validateLibraryTypesMatch(
            graphOf({ svr: { framework: ['express'], dependsOn: ['http'] }, http: { framework: ['express'], dependsOn: [] } }),
            problems
        );
        expect(problems).toEqual([]);
    });

    it('lets both express and react depend on a browser+node lib', () => {
        const dual = { web: { framework: ['react'], dependsOn: ['shared'] }, api: { framework: ['express'], dependsOn: ['shared'] }, shared: { framework: ['browser', 'node'], dependsOn: [] } };
        const problems: string[] = [];
        validateLibraryTypesMatch(graphOf(dual), problems);
        expect(problems).toEqual([]);
    });

    it('rejects an express app depending on a browser-only lib', () => {
        const problems: string[] = [];
        validateLibraryTypesMatch(
            graphOf({ api: { framework: ['express'], dependsOn: ['ui'] }, ui: { framework: ['browser'], dependsOn: [] } }),
            problems
        );
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain("'api' [express] must not depend on 'ui' [browser]");
    });

    it('rejects a react app depending on a node-only lib', () => {
        const problems: string[] = [];
        validateLibraryTypesMatch(
            graphOf({ web: { framework: ['react'], dependsOn: ['svc'] }, svc: { framework: ['node'], dependsOn: [] } }),
            problems
        );
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain("'web' [react] must not depend on 'svc' [node]");
    });

    it('rejects a browser+node consumer when the dep only covers one env', () => {
        const problems: string[] = [];
        validateLibraryTypesMatch(
            graphOf({ dual: { framework: ['browser', 'node'], dependsOn: ['b'] }, b: { framework: ['browser'], dependsOn: [] } }),
            problems
        );
        expect(problems).toHaveLength(1);
        // the node env is unsatisfiable by a browser-only dep
        expect(problems[0]).toContain('node');
    });

    it('skips edges where either endpoint has no resolved framework', () => {
        const problems: string[] = [];
        validateLibraryTypesMatch(
            graphOf({ a: { dependsOn: ['b'] }, b: { framework: ['angular'], dependsOn: [] } }),
            problems
        );
        expect(problems).toEqual([]);
    });
});

describe('validateRoleDependencies', () => {
    function graphOf(entries: Record<string, { role?: string; dependsOn: string[] }>): EnhancedGraph {
        const graph: EnhancedGraph = {};
        for (const [name, entry] of Object.entries(entries)) {
            graph[name] = { level: 0, dependsOn: entry.dependsOn, role: entry.role };
        }
        return graph;
    }

    it('allows depending on lib and designed-lib', () => {
        const problems: string[] = [];
        validateRoleDependencies(
            graphOf({
                svr: { role: 'server', dependsOn: ['plain', 'designed'] },
                plain: { role: 'lib', dependsOn: [] },
                designed: { role: 'designed-lib', dependsOn: [] },
            }),
            problems
        );
        expect(problems).toEqual([]);
    });

    it('flags a lib depending on a server (inverted direction)', () => {
        const problems: string[] = [];
        validateRoleDependencies(
            graphOf({ a: { role: 'lib', dependsOn: ['svr'] }, svr: { role: 'server', dependsOn: [] } }),
            problems
        );
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain("'a' (role:lib) must not depend on 'svr' (role:server)");
    });

    it('allows a server to depend on another server (e2e/orchestrator)', () => {
        const problems: string[] = [];
        validateRoleDependencies(
            graphOf({
                e2e: { role: 'server', dependsOn: ['svr1', 'svr2'] },
                svr1: { role: 'server', dependsOn: [] },
                svr2: { role: 'server', dependsOn: [] },
            }),
            problems
        );
        expect(problems).toEqual([]);
    });

    it('flags anything depending on a client (fully terminal)', () => {
        const problems: string[] = [];
        validateRoleDependencies(
            graphOf({ a: { role: 'server', dependsOn: ['ng'] }, ng: { role: 'client', dependsOn: [] } }),
            problems
        );
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain("'ng' (role:client)");
    });

    it('skips edges whose target has no resolved role', () => {
        const problems: string[] = [];
        validateRoleDependencies(graphOf({ a: { role: 'lib', dependsOn: ['b'] }, b: { dependsOn: [] } }), problems);
        expect(problems).toEqual([]);
    });
});

describe('resolveRole', () => {
    function infoOf(tags: string[]): ProjectInfo {
        return new ProjectInfo('proj', 'packages/proj', tags);
    }

    it('reads the explicit role: tag', () => {
        expect(resolveRole(infoOf(['framework:express', 'role:server'])).role).toBe('server');
        expect(resolveRole(infoOf(['role:designed-lib'])).role).toBe('designed-lib');
    });

    it('defaults to lib when no role tag is present', () => {
        const res = resolveRole(infoOf(['framework:all']));
        expect(res.role).toBe('lib');
        expect(res.problem).toBeNull();
    });

    it('flags more than one role tag', () => {
        const res = resolveRole(infoOf(['role:server', 'role:lib']));
        expect(res.role).toBeNull();
        expect(res.problem).toContain('at most one');
    });

    it('flags an empty role value', () => {
        const res = resolveRole(infoOf(['role:']));
        expect(res.role).toBeNull();
        expect(res.problem).toContain('empty value');
    });
});

class FixtureProject {
    constructor(
        public readonly name: string,
        public readonly responsibilitiesMd: string | null,
        public readonly hasProjectJson: boolean,
        public readonly tags: string[] = [],
        // Raw design.json contents to write (when hasProjectJson). null → no file.
        public readonly designJson: string | null = null
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
        if (project.designJson !== null) {
            fs.writeFileSync(path.join(enrichTmpRoot, root, 'design.json'), project.designJson, 'utf-8');
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
        // Non-empty designs[] → a real generated design → designFile set (clickable).
        const alphaDesign = JSON.stringify({ schemaVersion: 2, project: 'alpha', designs: [{ root: 'A' }] });
        const infos = setupWorkspace('good', [
            new FixtureProject('alpha', '# Responsibilities — alpha\n\nDoes alpha things.\n', true,
                ['framework:node'], alphaDesign),
            new FixtureProject('beta', '# Responsibilities — beta\n\nDoes beta things.\n', false, [
                'framework:express',
            ]),
        ]);
        const graph: EnhancedGraph = {
            alpha: { level: 0, dependsOn: [] },
            beta: { level: 1, dependsOn: ['alpha'] },
        };

        enrichGraph(graph, infos, enrichTmpRoot);

        expect(graph['alpha'].framework).toEqual(['node']);
        expect(graph['alpha'].shortDescription).toBe('Does alpha things.');
        expect(graph['alpha'].responsibilitiesFile).toBe('good/alpha/responsibilities.md');
        expect(graph['alpha'].designFile).toBe('good/alpha/design.json');

        expect(graph['beta'].framework).toEqual(['express']);
        // no project.json → no generated design.json → no designFile
        expect(graph['beta'].designFile).toBeUndefined();
    });

    it('aggregates ALL problems across projects into one error', () => {
        const infos = setupWorkspace('bad', [
            new FixtureProject('missing', null, true, ['framework:node']),
            new FixtureProject('empty', '# Heading only\n', true, ['framework:node']),
            new FixtureProject(
                'toolong',
                '# T\n\n' + 'x'.repeat(MAX_SHORT_DESCRIPTION_LENGTH + 50) + '\n',
                true,
                ['framework:node']
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

describe('enrichGraph designFile gating', () => {
    beforeAll(() => {
        enrichTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-enrich-gate-'));
    });
    afterAll(() => {
        fs.rmSync(enrichTmpRoot, { recursive: true, force: true });
    });

    it('leaves designFile unset for a plain lib whose design.json has an empty designs[]', () => {
        // A plain lib still gets a design.json written, but with no roots → not clickable.
        const emptyDesign = JSON.stringify({ schemaVersion: 2, project: 'gamma', designs: [] });
        const infos = setupWorkspace('plainlib', [
            new FixtureProject('gamma', '# Responsibilities — gamma\n\nDoes gamma things.\n', true,
                ['framework:node'], emptyDesign),
        ]);
        const graph: EnhancedGraph = { gamma: { level: 0, dependsOn: [] } };

        enrichGraph(graph, infos, enrichTmpRoot);

        expect(graph['gamma'].designFile).toBeUndefined();
    });
});
