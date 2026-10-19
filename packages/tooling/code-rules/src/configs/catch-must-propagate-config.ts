import { FieldDef, SchemaShape, BaseRuleConfig } from '@webpieces/rules-sdk';
import { ModifiedCodeMode, MODIFIED_CODE_MODES } from '@webpieces/rules-sdk';

/**
 * `catch-must-propagate` (#1313) — a caught error must leave its catch WHOLE: rethrown, thrown as a
 * cause, handed to a configured forwarder, returned, or stored on a member. Using only `err.message`,
 * `String(err)` or a template, or dropping the error (`catch {}`, an unused binding), is refused.
 *
 * ONE rule, ONE syntax-only implementation (`CatchPropagationAnalyzer` in
 * `@webpieces/tooling-common/catch-propagation`), run by BOTH runners: the Write/Edit guard and the build
 * gate. This pack owns the config; `@webpieces/ai-hook-rules` contributes the guard half.
 *
 * Every field that decides behaviour is REQUIRED with no default (`.claude/rules/no-rule-defaults.md`):
 * - `mode` — OFF | NEW_AND_MODIFIED_CODE (only a catch whose clause spans a changed line) |
 *   NEW_AND_MODIFIED_FILES (every catch in a changed file) | MODIFIED_PROJECTS / RUN_EVERY_TIME (every
 *   catch in each touched project / the whole repo — #1027).
 * - `forwards` — the callee names a caught error may be handed to whole and count as propagated
 *   (`log.warn('x', err)` → `warn`; an entry with a dot, `logger.warn`, matches the call's tail). It may
 *   be empty — then only a throw, a return or a member store propagates — but it must be stated, because
 *   it decides which catches pass. The seed lists the usual logger levels plus `reject`.
 *
 * The framework-owned `excludePaths` exempts whole trees. The per-site escape hatch is
 * `// webpieces-disable catch-must-propagate -- <reason of at least 20 characters>` on the catch's line or
 * the line above it.
 */
export class CatchMustPropagateConfig extends BaseRuleConfig {
    declare mode?: ModifiedCodeMode;
    forwards!: string[];

    static readonly SCHEMA: SchemaShape<CatchMustPropagateConfig> = {
        mode: new FieldDef('string', MODIFIED_CODE_MODES),
        forwards: new FieldDef('string[]'),
    };
}
