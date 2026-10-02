import { specTempDirs } from '@webpieces/tooling-testkit';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const state = vi.hoisted(() => ({
    evaluate: vi.fn(),
    loaded: { rulesConfig: {} },
    builtin: { name: 'source' }, guard: { name: 'guard' },
    custom: { name: 'custom' }, match: { name: 'match' },
    sourceLoad: vi.fn(), guardLoad: vi.fn(),
}));
vi.mock('@webpieces/rules-config', async (original) => ({
    ...await original<typeof import('@webpieces/rules-config')>(),
    loadAndValidate: (): typeof state.loaded => state.loaded,
}));
vi.mock('@webpieces/ai-hook-rules', () => ({ SourceHookRules: class {
    load(loaded: object): object {
        state.sourceLoad(loaded);
        return { builtInRules: [state.builtin], extensionRules: [state.custom, state.match], configuredRules: [state.builtin, state.custom, state.match] };
    }
} }));
vi.mock('@webpieces/agent-workflow-rules', () => ({ WorkflowHookRules: class {
    load(loaded: object): object {
        state.guardLoad(loaded);
        return { rules: [state.guard], configuredRules: [state.guard] };
    }
} }));
vi.mock('@webpieces/hook-runtime', async (original) => ({
    ...await original<typeof import('@webpieces/hook-runtime')>(),
    HookFileEvaluation: class { evaluate = state.evaluate; },
}));
import handler from './openclaw-plugin';
import { CONFIG_FILENAME } from '@webpieces/rules-config';

describe('OpenClaw uses one composed evaluation', () => {
    let root: string;
    beforeEach((): void => {
        vi.clearAllMocks();
        state.evaluate.mockReset();
        root = specTempDirs.make('wp-openclaw-composition-');
        fs.writeFileSync(path.join(root, CONFIG_FILENAME), '{}');
    });
    afterEach((): void => { fs.rmSync(root, { recursive: true, force: true }); });

    it('preserves source, guard, custom and match ordering for Write', async (): Promise<void> => {
        const file = path.join(root, 'file.ts');
        expect(await handler({ toolName: 'write', arguments: { path: file, content: 'new' } }, {})).toEqual({ status: 'approved', reason: undefined });
        expect(state.evaluate).toHaveBeenCalledTimes(1);
        const [kind, input, loaded, contributions] = state.evaluate.mock.calls[0];
        expect(kind).toBe('Write');
        expect(input.filePath).toBe(file);
        expect(loaded).toBe(state.loaded);
        expect(contributions.rules).toEqual([state.builtin, state.guard, state.custom, state.match]);
        expect(contributions.configuredRules).toEqual([state.builtin, state.custom, state.match, state.guard]);
        expect(state.sourceLoad).toHaveBeenCalledWith(state.loaded);
        expect(state.guardLoad).toHaveBeenCalledWith(state.loaded);
    });

    it('returns the combined evaluator denial for Edit', async (): Promise<void> => {
        state.evaluate.mockReturnValue({ report: 'guard denial' });
        expect(await handler({ toolName: 'edit', arguments: { path: path.join(root, 'file.ts'), old_string: 'old', new_string: 'new' } }, {})).toEqual({ status: 'rejected', reason: 'guard denial' });
        expect(state.evaluate).toHaveBeenCalledTimes(1);
        expect(state.evaluate.mock.calls[0][0]).toBe('Edit');
    });

    it('ignores unsupported tools', async (): Promise<void> => {
        expect(await handler({ toolName: 'bash', arguments: {} }, {})).toBeUndefined();
        expect(state.evaluate).not.toHaveBeenCalled();
    });

    it('fails closed when the combined evaluator crashes', async (): Promise<void> => {
        state.evaluate.mockImplementation((): never => { throw new Error('broken evaluator'); });
        expect(await handler({ toolName: 'write', arguments: { path: path.join(root, 'file.ts') } }, {})).toEqual({ status: 'rejected', reason: '[ai-hooks] openclaw adapter crashed — failing closed: broken evaluator' });
    });
});
