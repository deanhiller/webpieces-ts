import * as path from 'path';
import { loadAndValidate, LoadedConfig, CONFIG_MISSING_REPORT, L0_FAULT_CONFIG_MISSING, RepoRootFinder, writeGuardMatrixDoc, guardMatrixPointer } from '@webpieces/rules-config';
import { Rule, HookRuleSet, HookFileEvaluation, ToolKind, NormalizedToolInput, HookMode, BlockedResult } from '@webpieces/hook-runtime';
import { loadBuiltInRules, loadCustomRules, loadMatchRules } from './load-rules';

export class SourceHookRuleSet extends HookRuleSet {
    constructor(readonly builtInRules: readonly Rule[], readonly extensionRules: readonly Rule[], configuredRules: readonly Rule[]) {
        super([...builtInRules, ...extensionRules], configuredRules);
    }
}

export class SourceHookRules {
    load(loaded: LoadedConfig): SourceHookRuleSet {
        const builtIns = loadBuiltInRules(loaded.rulesConfig);
        const custom = loadCustomRules(loaded.rulesConfig, path.dirname(loaded.configPath ?? ''));
        return new SourceHookRuleSet(builtIns, [...custom, ...loadMatchRules(loaded.matchRules)], [...builtIns, ...custom]);
    }
}

// webpieces-disable no-function-outside-class -- preserves the existing source runner entry point
export function run(toolKind: ToolKind, input: NormalizedToolInput, cwd: string, mode: HookMode = 'rules'): BlockedResult | null {
    if (mode === 'guards') return null;
    const loaded = loadAndValidate(cwd);
    if (loaded.configPath === null) return new BlockedResult(CONFIG_MISSING_REPORT + guardMatrixPointer(writeGuardMatrixDoc(new RepoRootFinder().resolveRepoRoot(cwd))), L0_FAULT_CONFIG_MISSING);
    return new HookFileEvaluation().evaluate(toolKind, input, loaded, new SourceHookRules().load(loaded));
}
