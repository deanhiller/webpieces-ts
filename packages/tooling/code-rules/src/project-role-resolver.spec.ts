import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ProjectRoleResolver } from './project-role-resolver';

function writeFile(root: string, relPath: string, content: string): void {
    const fullPath = path.join(root, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
}

describe('ProjectRoleResolver', () => {
    let root: string;
    const resolver = new ProjectRoleResolver();

    beforeEach(() => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'role-resolver-')));
    });
    afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

    it('returns the role value of the nearest owning project.json', () => {
        writeFile(root, 'libs/core/project.json', JSON.stringify({ name: 'core', tags: ['framework:node', 'role:lib'] }));
        writeFile(root, 'libs/core/src/Foo.ts', 'export const x = 1;');
        expect(resolver.roleOf(root, 'libs/core/src/Foo.ts')).toBe('lib');
    });

    it('walks up past nested dirs to the owning project', () => {
        writeFile(root, 'apps/web/project.json', JSON.stringify({ name: 'web', tags: ['role:client'] }));
        writeFile(root, 'apps/web/src/a/b/c/Deep.ts', 'export const x = 1;');
        expect(resolver.roleOf(root, 'apps/web/src/a/b/c/Deep.ts')).toBe('client');
    });

    it('returns null when the project has no role tag', () => {
        writeFile(root, 'libs/x/project.json', JSON.stringify({ name: 'x', tags: ['framework:node'] }));
        writeFile(root, 'libs/x/src/Foo.ts', 'export const x = 1;');
        expect(resolver.roleOf(root, 'libs/x/src/Foo.ts')).toBeNull();
    });

    it('returns null when the file belongs to no project', () => {
        writeFile(root, 'loose/Foo.ts', 'export const x = 1;');
        expect(resolver.roleOf(root, 'loose/Foo.ts')).toBeNull();
    });

    it('does not throw on malformed project.json (returns null)', () => {
        writeFile(root, 'libs/bad/project.json', '{ not valid json');
        writeFile(root, 'libs/bad/src/Foo.ts', 'export const x = 1;');
        expect(resolver.roleOf(root, 'libs/bad/src/Foo.ts')).toBeNull();
    });
});
