/**
 * Tests for findRoleUntaggedProjects — the core of the role-tag rule: given a
 * set of changed files, every owning project.json must carry a `role:` tag.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findRoleUntaggedProjects } from '../validate-role-tag';

let root: string;

function writeProjectJson(projectDir: string, content: unknown): void {
    const dir = path.join(root, projectDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(content), 'utf-8');
}

describe('findRoleUntaggedProjects', () => {
    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-roletag-'));
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('returns nothing when the owning project carries a role tag', () => {
        writeProjectJson('packages/lib', { name: 'lib', tags: ['framework:all', 'role:lib'] });
        expect(findRoleUntaggedProjects(root, ['packages/lib/src/index.ts'])).toEqual([]);
    });

    it('flags a project whose project.json has a framework tag but no role tag', () => {
        writeProjectJson('packages/lib', { name: 'lib', tags: ['framework:all'] });
        const missing = findRoleUntaggedProjects(root, ['packages/lib/src/index.ts']);
        expect(missing).toHaveLength(1);
        expect(missing[0].name).toBe('lib');
        expect(missing[0].projectJsonPath).toBe('packages/lib/project.json');
    });

    it('treats an empty role: value as no tag', () => {
        writeProjectJson('packages/lib', { name: 'lib', tags: ['role:'] });
        expect(findRoleUntaggedProjects(root, ['packages/lib/src/index.ts'])).toHaveLength(1);
    });

    it('accepts each known role value', () => {
        for (const role of ['server', 'app', 'bundle', 'designed-lib', 'lib', 'client', 'api-lib']) {
            writeProjectJson('packages/p', { name: 'p', tags: [`role:${role}`] });
            expect(findRoleUntaggedProjects(root, ['packages/p/src/a.ts'])).toEqual([]);
        }
    });

    it('ignores files that belong to no project', () => {
        expect(findRoleUntaggedProjects(root, ['README.md', 'nx.json'])).toEqual([]);
    });
});
