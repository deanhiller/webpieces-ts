/**
 * Regression tests for the `excludePackages` escape hatch of the
 * no-file-import-cycles gate.
 *
 * The historical bug: buildMadgeOptions anchored the per-package exclude regex
 * on the excluded package's ABSOLUTE path (`^/abs/pkg(/|$)`), but madge matches
 * excludeRegExp against ids RELATIVE to the base it was invoked with (the
 * project root) — e.g. '../foreignlib/src/a.ts'. An absolute anchor can never
 * match a relative id, so every excludePackages entry was a silent no-op and the
 * gate's outcome depended on whether the excluded package's build output existed
 * on disk (present → madge stops at the package boundary → 0 cycles; absent →
 * madge walks the source and reports the package's inherent cycles).
 *
 * These tests build madge's options exactly as the executor does, run REAL madge
 * against a temp workspace whose "excluded" package has NO build output (only
 * source), and assert the exclusion actually drops the foreign cycle. With the
 * old absolute anchor these assertions fail — which is the whole point.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildMadgeOptions } from './executor';

// madge ships no types; require it the same way the executor's loadMadge does.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const madgeModule = require('madge');
const madge = (madgeModule.default ?? madgeModule) as (
    target: string,
    options: ReturnType<typeof buildMadgeOptions>,
) => Promise<{ circular(): string[][] }>;

function escapeRegex(s: string): string {
    return s.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');
}

/**
 * Temp workspace:
 *   <root>/tsconfig.base.json   → paths map "@fake/foreign" to packages/foreignlib
 *   <root>/packages/foreignlib  → a package with a self-contained a↔b import cycle
 *                                 and NO compiled build output (lib/ absent)
 *   <root>/packages/svc         → a service that imports into foreignlib's source
 *                                 via a relative path (so madge resolves it without
 *                                 needing tsconfig alias resolution)
 */
class Workspace {
    root!: string;
    svcRoot!: string;

    setup(): void {
        this.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nofic-exclude-')));
        this.svcRoot = path.join(this.root, 'packages', 'svc');

        this.write(
            'tsconfig.base.json',
            JSON.stringify({
                compilerOptions: { paths: { '@fake/foreign': ['packages/foreignlib/index.ts'] } },
            }),
        );

        // Excluded package — source only, with an internal a↔b cycle. No lib/.
        this.write('packages/foreignlib/package.json', JSON.stringify({ name: '@fake/foreign', version: '1.0.0' }));
        this.write('packages/foreignlib/index.ts', `export * from './src/a';\n`);
        this.write('packages/foreignlib/src/a.ts', `import './b';\nexport const a = 1;\n`);
        this.write('packages/foreignlib/src/b.ts', `import './a';\nexport const b = 2;\n`);

        // Service reaches into the foreign package's source via a relative import.
        this.write('packages/svc/src/main.ts', `import '../../foreignlib/src/a';\nexport const main = true;\n`);
    }

    teardown(): void {
        fs.rmSync(this.root, { recursive: true, force: true });
    }

    private write(rel: string, content: string): void {
        const full = path.join(this.root, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
    }
}

describe('no-file-import-cycles excludePackages (madge relative-id matching)', () => {
    const ws = new Workspace();
    beforeAll(() => ws.setup());
    afterAll(() => ws.teardown());

    async function cyclesWith(opts: ReturnType<typeof buildMadgeOptions>): Promise<string[][]> {
        const result = await madge(ws.svcRoot, opts);
        return result.circular();
    }

    it('reports the foreign cycle when nothing is excluded (baseline — the cycle is reachable)', async () => {
        const opts = buildMadgeOptions(false, [], ws.root, ws.svcRoot);
        const cycles = await cyclesWith(opts);
        expect(cycles.length).toBeGreaterThan(0);
    });

    it('excludes the foreign package by RELATIVE-anchored regex even with its build output absent', async () => {
        const opts = buildMadgeOptions(false, ['@fake/foreign'], ws.root, ws.svcRoot);
        // The generated pattern must be relative to the madge base (svcRoot), not absolute.
        const relPattern = opts.excludeRegExp?.find((p: string) => p.includes('foreignlib'));
        expect(relPattern).toBeDefined();
        expect(relPattern!.startsWith('^/')).toBe(false); // NOT an absolute anchor
        expect(relPattern).toMatch(/foreignlib/);

        const cycles = await cyclesWith(opts);
        expect(cycles.length).toBe(0);
    });

    it('demonstrates the old absolute anchor would NOT have matched (regression guard)', async () => {
        const foreignDir = fs.realpathSync(path.join(ws.root, 'packages', 'foreignlib'));
        // Reproduce the historical bug's pattern: anchor on the absolute path.
        const opts = buildMadgeOptions(false, [], ws.root, ws.svcRoot);
        opts.excludeRegExp = [...(opts.excludeRegExp ?? []), `^${escapeRegex(foreignDir)}(/|$)`];

        const cycles = await cyclesWith(opts);
        // Absolute anchor never matches madge's relative ids → cycle still reported.
        expect(cycles.length).toBeGreaterThan(0);
    });
});

/**
 * Regression tests for the `excludeRegExp` escape hatch — exempting a cycle that
 * lives INSIDE the project being checked (generated code, a deliberate
 * bidirectional domain model), which `excludePackages` can never reach because it
 * resolves npm package names, not project-internal directories.
 *
 * The project holds a genuine a↔b cycle. A project-relative pattern covering one
 * of the two files must drop the cycle; a workspace-anchored pattern (the natural
 * first mistake — madge ids are relative to the PROJECT, not the workspace) must
 * NOT, proving the pattern is passed to madge verbatim and that anchoring is on
 * the consumer. Testing only the happy path would pass even if the pattern were
 * silently dropped.
 */
class InternalCycleWorkspace {
    root!: string;
    projRoot!: string;

    setup(): void {
        this.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nofic-exclude-regexp-')));
        this.projRoot = path.join(this.root, 'packages', 'proj');

        // A genuine, deliberate a↔b cycle inside the project's own generated tree.
        this.write('packages/proj/src/generated/a.ts', `import './b';\nexport const a = 1;\n`);
        this.write('packages/proj/src/generated/b.ts', `import './a';\nexport const b = 2;\n`);
        // A non-generated file so the project has traversed ids outside src/generated too.
        this.write('packages/proj/src/main.ts', `import './generated/a';\nexport const main = true;\n`);
    }

    teardown(): void {
        fs.rmSync(this.root, { recursive: true, force: true });
    }

    private write(rel: string, content: string): void {
        const full = path.join(this.root, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
    }
}

describe('no-file-import-cycles excludeRegExp (project-internal cycle exemption)', () => {
    const ws = new InternalCycleWorkspace();
    beforeAll(() => ws.setup());
    afterAll(() => ws.teardown());

    async function cyclesWith(opts: ReturnType<typeof buildMadgeOptions>): Promise<string[][]> {
        const result = await madge(ws.projRoot, opts);
        return result.circular();
    }

    it('reports the internal cycle when nothing is excluded (baseline)', async () => {
        const cycles = await cyclesWith(buildMadgeOptions(false, [], ws.root, ws.projRoot));
        expect(cycles.length).toBeGreaterThan(0);
    });

    it('drops the cycle when a PROJECT-relative excludeRegExp covers one of the two files', async () => {
        const opts = buildMadgeOptions(false, [], ws.root, ws.projRoot, ['^src/generated/']);
        // The user pattern is passed to madge verbatim.
        expect(opts.excludeRegExp).toContain('^src/generated/');
        const cycles = await cyclesWith(opts);
        expect(cycles.length).toBe(0);
    });

    it('still reports the cycle when the excludeRegExp is WORKSPACE-anchored (wrong base — no-op)', async () => {
        // madge ids are relative to the project, so a workspace-rooted pattern matches nothing.
        const opts = buildMadgeOptions(false, [], ws.root, ws.projRoot, ['^packages/proj/src/generated/']);
        const cycles = await cyclesWith(opts);
        expect(cycles.length).toBeGreaterThan(0);
    });
});
