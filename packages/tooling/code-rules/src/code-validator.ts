import { AbstractRule, BaseRuleConfig } from '@webpieces/rules-config';

/**
 * Result of running a single code validator.
 */
export interface ExecutorResult {
    success: boolean;
}

/**
 * One named unit of work for {@link RuleReporter} — a validator (or a per-entry match-rule) paired
 * with a thunk that runs it. A value object (not a DAG service), so the engine can build the run list
 * from its injected validators + checker WITHOUT `new`-ing any DAG member.
 */
export class RuleRun {
    constructor(
        readonly name: string,
        readonly run: () => Promise<ExecutorResult>,
    ) {}
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
