import * as path from 'path';
import { LoadedConfig } from '@webpieces/rules-config';
import { HookRuleSet } from '@webpieces/hook-runtime';
import { loadRules, GuardHintCommands } from './load-rules';

export class WorkflowHookRules {
    load(loaded: LoadedConfig): HookRuleSet {
        const rules = loadRules(loaded.rulesConfig, path.dirname(loaded.configPath ?? ''),
            new GuardHintCommands(loaded.commands.upsertPr, loaded.commands.mergeComplete));
        return new HookRuleSet(rules, rules);
    }
}
