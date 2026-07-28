/**
 * Tests for the service-name resolver: the runtime name clients address a service by is DECLARED
 * in project.json (metadata.webpieces.serviceName), never derived from the nx project name — the
 * two naming spaces have no mechanical relationship, and a strip-the-suffix rule gets it wrong.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ProjectInfo } from '../project-info';
import { resolveServiceName, validateUniqueServiceNames } from '../service-name-resolver';

let workspaceRoot = '';

/** Write a project.json (or nothing, when `contents` is null) and return its ProjectInfo. */
function project(name: string, contents: string | null): ProjectInfo {
    const root = path.join('packages', name);
    fs.mkdirSync(path.join(workspaceRoot, root), { recursive: true });
    if (contents !== null) fs.writeFileSync(path.join(workspaceRoot, root, 'project.json'), contents, 'utf-8');
    return new ProjectInfo(name, root, ['role:server']);
}

beforeAll(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-service-name-'));
});

afterAll(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('resolveServiceName', () => {
    it('reads metadata.webpieces.serviceName, which need not resemble the project name', () => {
        const info = project('helper-svr', '{ "metadata": { "webpieces": { "serviceName": "helper-portal" } } }');
        const result = resolveServiceName(info, workspaceRoot);
        expect(result.problem).toBeNull();
        expect(result.serviceName).toBe('helper-portal');
    });

    it('trims surrounding whitespace', () => {
        const info = project('padded-svr', '{ "metadata": { "webpieces": { "serviceName": "  lang  " } } }');
        expect(resolveServiceName(info, workspaceRoot).serviceName).toBe('lang');
    });

    it('treats an absent declaration as "not declared", not as a problem (most projects have none)', () => {
        const info = project('plain-lib', '{ "name": "plain-lib" }');
        const result = resolveServiceName(info, workspaceRoot);
        expect(result.problem).toBeNull();
        expect(result.serviceName).toBeNull();
    });

    it('treats a missing project.json as "not declared"', () => {
        const result = resolveServiceName(project('no-project-json', null), workspaceRoot);
        expect(result.problem).toBeNull();
        expect(result.serviceName).toBeNull();
    });

    it('reports a present-but-unusable value — an empty string is a typo, not an absence', () => {
        const info = project('empty-svr', '{ "metadata": { "webpieces": { "serviceName": "   " } } }');
        const result = resolveServiceName(info, workspaceRoot);
        expect(result.serviceName).toBeNull();
        expect(result.problem).toContain('non-empty string');
    });

    it('reports a non-string value', () => {
        const info = project('numeric-svr', '{ "metadata": { "webpieces": { "serviceName": 42 } } }');
        expect(resolveServiceName(info, workspaceRoot).problem).toContain('non-empty string');
    });
});

describe('validateUniqueServiceNames', () => {
    it('accepts distinct names', () => {
        const problems: string[] = [];
        validateUniqueServiceNames(new Map([['a-svr', 'a'], ['b-svr', 'b']]), problems);
        expect(problems).toEqual([]);
    });

    it('rejects two projects claiming one name — a client naming it could not be routed', () => {
        const problems: string[] = [];
        validateUniqueServiceNames(new Map([['a-svr', 'shared'], ['b-svr', 'shared']]), problems);
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain('a-svr, b-svr');
    });
});
