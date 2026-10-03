import { RuleFailError, renderRuleFailForAi } from '@webpieces/rules-config';
import { toError } from '@webpieces/tooling-common/to-error';
import {
    Rule,
    EditContext,
    FileContext,
    BashContext,
    Violation,
    RuleGroup,
    BlockedResult,
} from './types';

import { globMatches } from './glob';

// Every entry was read from its declared owner file and validated before execution.
// webpieces-disable no-function-outside-class -- existing stateless evaluator helpers extracted intact for both hook providers
export function runRuleCheck(
    rule: Rule,
    ctx: EditContext | FileContext | BashContext,
): readonly Violation[] {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        return rule.check(ctx);
    // webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
    } catch (err: unknown) {
        const error = toError(err);
        if (error instanceof RuleFailError) {
            return [violationFromRuleFail(error)];
        }
        return [new Violation(0, '', `Rule '${rule.name}' crashed: ${error.message}`)];
    }
}

// A thrown RuleFailError carries its own AI-facing message + optional location and cures. Fold the
// cures into the message because Violation has no fixHint field (RuleGroup's fixHint comes from the
// rule definition, not a per-throw value). The "Fix Option N:"/"(preferred)" labels come from the ONE
// framework-owned renderer, exactly as report.ts renders a rule's static FixHint — a rule never
// hand-numbers its own cures.
// webpieces-disable no-function-outside-class -- existing stateless evaluator helpers extracted intact for both hook providers
function violationFromRuleFail(error: RuleFailError): Violation {
    return new Violation(error.line ?? 0, error.snippet ?? '', renderRuleFailForAi(error));
}

// webpieces-disable no-function-outside-class -- existing stateless evaluator helpers extracted intact for both hook providers
function ruleMatchesFile(rule: Rule, relativePath: string): boolean {
    for (const pattern of rule.files) {
        if (globMatches(pattern, relativePath)) return true;
    }
    return false;
}

// webpieces-disable no-function-outside-class -- existing stateless evaluator helpers extracted intact for both hook providers
export function runBashRules(
    rules: readonly Rule[],
    bashContext: BashContext,
): readonly RuleGroup[] {
    const groups: RuleGroup[] = [];
    for (const rule of rules) {
        if (rule.scope !== 'bash') continue;
        if (!rule.shouldRun()) continue;
        const vs = runRuleCheck(rule, bashContext);
        if (vs.length > 0) {
            groups.push(new RuleGroup(rule.name, rule.description, rule.fixHint, [...vs]));
        }
    }
    return groups;
}

// webpieces-disable no-function-outside-class -- existing stateless evaluator helpers extracted intact for both hook providers
export function runEditRules(
    rules: readonly Rule[],
    editContexts: readonly EditContext[],
): readonly RuleGroup[] {
    const groups: RuleGroup[] = [];
    for (const rule of rules) {
        if (rule.scope !== 'edit') continue;
        if (!rule.shouldRun()) continue;
        const allViolations: Violation[] = [];
        for (const ctx of editContexts) {
            if (!ruleMatchesFile(rule, ctx.relativePath)) continue;
            const vs = runRuleCheck(rule, ctx);
            for (const v of vs) {
                const copy = new Violation(v.line, v.snippet, v.message);
                copy.editIndex = ctx.editIndex;
                copy.editCount = ctx.editCount;
                allViolations.push(copy);
            }
        }
        if (allViolations.length > 0) {
            groups.push(new RuleGroup(rule.name, rule.description, rule.fixHint, allViolations));
        }
    }
    return groups;
}

// webpieces-disable no-function-outside-class -- existing stateless evaluator helpers extracted intact for both hook providers
export function runFileRules(
    rules: readonly Rule[],
    fileContext: FileContext,
): readonly RuleGroup[] {
    const groups: RuleGroup[] = [];
    for (const rule of rules) {
        if (rule.scope !== 'file') continue;
        if (!rule.shouldRun()) continue;
        if (!ruleMatchesFile(rule, fileContext.relativePath)) continue;
        const vs = runRuleCheck(rule, fileContext);
        if (vs.length > 0) {
            groups.push(new RuleGroup(rule.name, rule.description, rule.fixHint, [...vs]));
        }
    }
    return groups;
}
