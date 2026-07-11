import 'reflect-metadata';
import { Container } from 'inversify';
import { buildProviderModule } from '@inversifyjs/binding-decorators';
import { loadAndValidate, BaseRuleConfig } from '@webpieces/rules-config';

import { ExecutorResult } from './code-validator';
import { CodeRulesApp } from './code-rules-app';
import { WorkspaceRoot, MatchRulesHolder } from './code-rules-context';
import { CONFIG_BINDINGS } from './code-rules-config-table';

export { ExecutorResult } from './code-validator';

/**
 * Run all configured code validators against the workspace root (the nx `validate-code` executor's
 * entry, via `@webpieces/code-rules`'s `validateCode` export).
 *
 * Composition root: binds the workspace root + each rule's typed config into an inversify container,
 * then RESOLVES {@link CodeRulesApp} so inversify constructs the ENTIRE validator DAG — nothing in the
 * DAG is `new`-ed (every validator, the reporter, and the match-rules checker are injected). Config
 * comes from webpieces.config.json (loaded via @webpieces/rules-config so ai-hooks and this executor
 * agree on every rule's mode/options).
 */
export default async function runValidator(workspaceRoot: string): Promise<ExecutorResult> {
    const loaded = loadAndValidate(workspaceRoot);
    if (loaded.configPath === null) {
        console.error('\n❌ No webpieces.config.json found at workspace root (or any ancestor).\n');
        return { success: false };
    }
    console.log(`\n📄 Loaded config: ${loaded.configPath}`);

    const container = new Container();
    container.bind(WorkspaceRoot).toConstantValue(new WorkspaceRoot(workspaceRoot));
    container.bind(MatchRulesHolder).toConstantValue(new MatchRulesHolder(loaded.matchRules));
    for (const binding of CONFIG_BINDINGS) {
        const ConfigClass = binding[0];
        const configured = loaded.rulesConfig[binding[1]] as BaseRuleConfig | undefined;
        container.bind(ConfigClass).toConstantValue(configured ?? new ConfigClass());
    }
    await container.load(buildProviderModule());

    return container.get(CodeRulesApp).run();
}
