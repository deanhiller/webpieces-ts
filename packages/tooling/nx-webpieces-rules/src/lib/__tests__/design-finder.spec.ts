/**
 * Tests for design.json discovery + selection resolution used by the
 * wp-design-visualize CLI.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findDesignFiles, resolveSelections, DesignFileRef } from '../di-graph/design-finder';

let tmpRoot: string;

function writeDesign(relDir: string, project: string): void {
    const dir = path.join(tmpRoot, relDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'design.json'),
        JSON.stringify({ schemaVersion: 2, project, designs: [] }),
        'utf-8'
    );
}

beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-finder-'));
    writeDesign('services/helper-portal-svr', 'helper-portal-svr');
    writeDesign('services/lang-server', 'lang-server');
    writeDesign('libraries/server-auth', 'server-auth');
    // must be skipped:
    writeDesign('node_modules/some-pkg', 'ignored-nm');
    writeDesign('dist/services/x', 'ignored-dist');
});

afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('findDesignFiles', () => {
    it('finds committed design.json files sorted by project, skipping build dirs', () => {
        const files = findDesignFiles(tmpRoot);
        expect(files.map((file: DesignFileRef) => file.project)).toEqual([
            'helper-portal-svr',
            'lang-server',
            'server-auth',
        ]);
        expect(files[0].relPath).toBe('services/helper-portal-svr/design.json');
    });
});

describe('resolveSelections', () => {
    it("'all' selects everything", () => {
        const files = findDesignFiles(tmpRoot);
        expect(resolveSelections(['all'], files)).toHaveLength(3);
    });

    it('resolves 1-based numbers', () => {
        const files = findDesignFiles(tmpRoot);
        const picked = resolveSelections(['2'], files);
        expect(picked.map((file: DesignFileRef) => file.project)).toEqual(['lang-server']);
    });

    it('resolves exact names and substrings, deduplicated', () => {
        const files = findDesignFiles(tmpRoot);
        const picked = resolveSelections(['lang-server', 'server'], files);
        expect(picked.map((file: DesignFileRef) => file.project).sort()).toEqual([
            'lang-server',
            'server-auth',
        ]);
    });

    it('throws with the known-project list on no match', () => {
        const files = findDesignFiles(tmpRoot);
        expect(() => resolveSelections(['nope-xyz'], files)).toThrow(/Known projects: helper-portal-svr/);
    });
});
