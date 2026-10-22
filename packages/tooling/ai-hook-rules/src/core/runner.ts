import * as path from 'path';

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
    HotfixCheckout,
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
    TargetTreeResolver,
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
    // A file checked out on a `/hotfix/` branch runs no edit-time code rule, matching `hotfix-ci` (compile +
    // tests only; issue #1371). The branch is the one in the tree that OWNS the file, never the session's.
    const owner = new TargetTreeResolver().resolve(input.filePath, path.dirname(loaded.configPath));
    if (new HotfixCheckout().isHotfix(owner.root)) return null;
    return new HookFileEvaluation().evaluate(
        toolKind,
        input,
        loaded,
        new SourceHookRules().load(loaded),
    );
}
