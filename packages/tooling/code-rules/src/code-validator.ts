import { AbstractRule, BaseRuleConfig } from '@webpieces/rules-config';

/**
 * Result of running a single code validator.
 */
export interface ExecutorResult {
    success: boolean;
}

/**
 * Base class for every code-rules validator.
 *
 * Extends the shared {@link AbstractRule} (which owns `name` + the on/off + escape-hatch
 * decision in `shouldRun()`) and adds the code-rules execution surface: `run(workspaceRoot)`.
 * Each validator is constructed with its typed `*Config` from `@webpieces/rules-config`, so
 * the config classes are genuinely consumed (find-usages / rename work across packages).
 */
export abstract class CodeValidator<C extends BaseRuleConfig> extends AbstractRule<C> {
    abstract run(workspaceRoot: string): Promise<ExecutorResult>;
}
