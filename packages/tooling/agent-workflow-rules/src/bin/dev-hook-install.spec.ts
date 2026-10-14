import { policyFixture } from '@webpieces/tooling-testkit';
import { specTempDirs } from '@webpieces/tooling-testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

import { runDevHookInstall } from './dev-hook-install';

const fixture = vi.hoisted(() => ({ home: '' }));
vi.mock('os', async (importOriginal: <T>() => Promise<T>) => ({ ...await importOriginal<typeof import('os')>(), homedir: () => fixture.home }));

afterEach(() => vi.restoreAllMocks());

describe('development hook installation after separating source and workflow packages', () => {
    it('installs both hooks from their owning builds without touching the real home', async () => {
        const root = policyFixture.makeRepo('wp-dev-hooks-');
        fixture.home = join(root, 'home');
        vi.spyOn(process, 'cwd').mockReturnValue(root);
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const source = join(root, 'dist/packages/tooling/ai-hook-rules/src/adapters/rules-hook.js');
        const guards = join(root, 'dist/packages/tooling/agent-workflow-rules/src/adapters/guards-hook.js');
        for (const file of [source, guards]) {
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, '');
        }
        mkdirSync(join(root, 'dist/packages/tooling/rules-config'), { recursive: true });

        await runDevHookInstall();

        const settings = readFileSync(join(fixture.home, '.claude/settings.json'), 'utf8');
        expect(settings).toContain(`node ${source}`);
        expect(settings).toContain(`node ${guards}`);
        expect(readFileSync(join(fixture.home, '.webpieces/dev-hook-backup.json'), 'utf8')).toContain('"previousHooks": null');
    });

    it.each(['ai-hook-rules', 'agent-workflow-rules'])('names the missing %s build and an executable cure', async (missing: string) => {
        const root = policyFixture.makeRepo('wp-dev-hooks-missing-');
        vi.spyOn(process, 'cwd').mockReturnValue(root);
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        if (missing === 'agent-workflow-rules') {
            const source = join(root, 'dist/packages/tooling/ai-hook-rules/src/adapters/rules-hook.js');
            mkdirSync(dirname(source), { recursive: true });
            writeFileSync(source, '');
        }

        await expect(runDevHookInstall()).rejects.toThrow(`  Run \`pnpm nx run ${missing}:build\` first.`);

        expect(error).not.toHaveBeenCalled();
    });

    it.each(['rules-config', 'backup'])('carries the %s failure and cure in the thrown error', async (state: string) => {
        const root = policyFixture.makeRepo('wp-dev-hooks-state-');
        fixture.home = join(root, 'home');
        vi.spyOn(process, 'cwd').mockReturnValue(root);
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        for (const owner of ['ai-hook-rules', 'agent-workflow-rules']) {
            const name = owner === 'ai-hook-rules' ? 'rules-hook.js' : 'guards-hook.js';
            const file = join(root, 'dist/packages/tooling', owner, 'src/adapters', name);
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, '');
        }
        if (state === 'backup') {
            mkdirSync(join(root, 'dist/packages/tooling/rules-config'), { recursive: true });
            mkdirSync(join(fixture.home, '.webpieces'), { recursive: true });
            writeFileSync(join(fixture.home, '.webpieces/dev-hook-backup.json'), 'preserve this backup');
        }
        const cure = state === 'backup' ? 'node dist/packages/tooling/agent-workflow-rules/src/bin/dev-hook-uninstall.js' : 'pnpm nx run rules-config:build';

        await expect(runDevHookInstall()).rejects.toThrow(cure);

        expect(error).not.toHaveBeenCalled();
        if (state === 'backup') expect(readFileSync(join(fixture.home, '.webpieces/dev-hook-backup.json'), 'utf8')).toBe('preserve this backup');
    });
});
