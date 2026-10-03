import { SourceRuleRuntime } from '../rule-runtime';
import {
    loadAndValidate,
    LoadedConfig,
    ConfigRepairAccess,
    HomeConfigService,
    CONFIG_MISSING_REPORT,
    L0_FAULT_CONFIG_MISSING,
    RepoRootFinder,
    writeGuardMatrixDoc,
    guardMatrixPointer,
} from '@webpieces/rules-config';
import {
    Rule,
    isRootManifest,
    HookPolicyContributions,
    HookRuleSet,
    HookFileEvaluation,
    ToolKind,
    NormalizedToolInput,
    HookMode,
    BlockedResult,
} from '@webpieces/hook-runtime';
import { loadMatchRules } from './load-rules';

export class SourceHookRuleSet extends HookRuleSet {
    constructor(
        readonly contributedRules: readonly Rule[],
        readonly matchRules: readonly Rule[],
    ) {
        super([...contributedRules, ...matchRules]);
    }
}

export class SourceHookRules {
    load(loaded: LoadedConfig): SourceHookRuleSet {
        const builtIns = new HookPolicyContributions(
            new Map([['@webpieces/ai-hook-rules/rule-runtime', new SourceRuleRuntime()]]),
        ).load(loaded, 'source-hook');
        return new SourceHookRuleSet(builtIns, loadMatchRules(loaded.matchRules));
    }
}

// webpieces-disable no-function-outside-class -- preserves the existing source runner entry point
export function run(
    toolKind: ToolKind,
    input: NormalizedToolInput,
    cwd: string,
    mode: HookMode = 'rules',
): BlockedResult | null {
    if (mode === 'guards') return null;
    if (
        toolKind !== 'Delete' &&
        (new ConfigRepairAccess().isRepairFile(
            new RepoRootFinder().resolveRepoRoot(cwd),
            input.filePath,
        ) ||
            isRootManifest(input.filePath) ||
            new HomeConfigService().isHomeConfigPath(input.filePath))
    )
        return null;
    const loaded = loadAndValidate(cwd);
    if (loaded.configPath === null)
        return new BlockedResult(
            CONFIG_MISSING_REPORT +
                guardMatrixPointer(writeGuardMatrixDoc(new RepoRootFinder().resolveRepoRoot(cwd))),
            L0_FAULT_CONFIG_MISSING,
        );
    return new HookFileEvaluation().evaluate(
        toolKind,
        input,
        loaded,
        new SourceHookRules().load(loaded),
    );
}
