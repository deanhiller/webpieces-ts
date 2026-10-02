import * as path from 'path';
import { LoadedConfig, HomeConfigService } from '@webpieces/rules-config';
import { ToolKind, NormalizedToolInput } from '../protocol';
import { Rule, BlockedResult } from './types';

import { TargetTreeResolver } from './target-tree';
import { DeleteScopedRules } from './delete-scoped-rules';
import { filterByExcludedPaths } from './excluded-paths';
import { buildContexts } from './build-context';
import { checkConfigSync, runEditRules, runFileRules } from './rule-evaluation';
import { formatReport } from './report';
import { isRootManifest } from './root-manifest';

export class HookRuleSet {
    constructor(readonly rules: readonly Rule[], readonly configuredRules: readonly Rule[]) {}
}

export class HookFileEvaluation {
    evaluate(toolKind: ToolKind, input: NormalizedToolInput, loaded: LoadedConfig, contributions: HookRuleSet): BlockedResult | null {
        if (loaded.configPath === null) return null;
        if (path.resolve(input.filePath) === path.resolve(loaded.configPath)
            || isRootManifest(input.filePath) || new HomeConfigService().isHomeConfigPath(input.filePath)) return null;
        const root = path.dirname(loaded.configPath);
        const governed = new TargetTreeResolver().governedPath(input.filePath, root);
        const rules = new DeleteScopedRules().narrow(toolKind, filterByExcludedPaths(contributions.rules, governed, loaded.excludePaths));
        if (rules.length === 0) return null;
        const sync = checkConfigSync(rules.filter((rule: Rule): boolean => contributions.configuredRules.includes(rule)), loaded.rulesConfig);
        if (sync) return sync;
        const contexts = buildContexts(toolKind, input, root, governed);
        const groups = [...runEditRules(rules, contexts.editContexts), ...runFileRules(rules, contexts.fileContext)];
        return groups.length === 0 ? null : new BlockedResult(formatReport(governed.relativePath, groups));
    }
}
