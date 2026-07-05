/**
 * Tests for findUntaggedProjects — the core of the framework-tag rule: given a
 * set of changed files, every owning project.json must carry a `framework:` tag.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findUntaggedProjects } from '../validate-framework-tag';

let root: string;

function writeProjectJson(projectDir: string, content: unknown): void {
    const dir = path.join(root, projectDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(content), 'utf-8');
}

describe('findUntaggedProjects', () => {
    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-fwtag-'));
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('returns nothing when the owning project carries a framework tag', () => {
        writeProjectJson('packages/lib', { name: 'lib', tags: ['type:util', 'framework:all'] });
        const untagged = findUntaggedProjects(root, ['packages/lib/src/index.ts']);
        expect(untagged).toEqual([]);
    });

    it('flags a project whose owning project.json has no framework tag', () => {
        writeProjectJson('packages/lib', { name: 'lib', tags: ['type:util'] });
        const untagged = findUntaggedProjects(root, ['packages/lib/src/index.ts']);
        expect(untagged).toHaveLength(1);
        expect(untagged[0].name).toBe('lib');
        expect(untagged[0].projectJsonPath).toBe('packages/lib/project.json');
    });

    it('treats an empty framework: value as no tag', () => {
        writeProjectJson('packages/lib', { name: 'lib', tags: ['framework:'] });
        const untagged = findUntaggedProjects(root, ['packages/lib/src/index.ts']);
        expect(untagged).toHaveLength(1);
    });

    it('walks up to the nearest project.json from a deeply nested file', () => {
        writeProjectJson('apps/web', { name: 'web', tags: [] });
        const untagged = findUntaggedProjects(root, ['apps/web/src/app/deep/thing.ts']);
        expect(untagged).toHaveLength(1);
        expect(untagged[0].name).toBe('web');
    });

    it('reports each owning project once even with multiple changed files', () => {
        writeProjectJson('packages/a', { name: 'a', tags: [] });
        writeProjectJson('packages/b', { name: 'b', tags: ['framework:express'] });
        const untagged = findUntaggedProjects(root, [
            'packages/a/src/one.ts',
            'packages/a/src/two.ts',
            'packages/b/src/three.ts',
        ]);
        const names = untagged.map((project: { name: string }) => project.name);
        expect(names).toEqual(['a']);
    });

    it('ignores files that belong to no project', () => {
        const untagged = findUntaggedProjects(root, ['README.md', 'nx.json']);
        expect(untagged).toEqual([]);
    });
});
