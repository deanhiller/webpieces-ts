import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { specTempDirs } from '@webpieces/rules-config';
import { runDevHookInstall } from './dev-hook-install';

const fixture = vi.hoisted(() => ({ home: '' }));
vi.mock('os', async (importOriginal: <T>() => Promise<T>) => ({ ...await importOriginal<typeof import('os')>(), homedir: () => fixture.home }));

afterEach(() => vi.restoreAllMocks());

describe('development hook installation after separating source and workflow packages', () => {
    it('installs both hooks from their owning builds without touching the real home', async () => {
        const root = specTempDirs.make('wp-dev-hooks-');
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
        const root = specTempDirs.make('wp-dev-hooks-missing-');
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
});
