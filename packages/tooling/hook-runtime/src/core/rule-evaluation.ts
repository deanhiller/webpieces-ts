import { CONFIG_FILENAME, CONFIG_OUT_OF_SYNC_HEADER, L0_FAULT_CONFIG_OUT_OF_SYNC, seedEntryForRule, WebpiecesRulesConfig, RuleFailError, renderRuleFailForAi } from '@webpieces/rules-config';
import { toError } from '@webpieces/tooling-common/to-error';
import { Rule, EditContext, FileContext, BashContext, Violation, RuleGroup, BlockedResult } from './types';

import { globMatches } from './glob';

// The set of CONFIG KEYS explicitly present in webpieces.config.json (every key except rulesDir).
// webpieces-disable no-function-outside-class -- existing stateless evaluator helpers extracted intact for both hook providers
function configuredRuleNames(config: WebpiecesRulesConfig): ReadonlySet<string> {
    return new Set(Object.keys(config).filter((k: string) => k !== 'rulesDir'));
}

/**
 * Fault Y — a loaded rule whose CONFIG KEY has no entry.
 *
 * Compared on `configKey`, not `name`. Eight of the loaded rules are classes behind two policy keys, so
 * comparing names here would demand entries named `feature-branch-guard`, `pr-merge-guard` and six
 * others — keys the validator then REJECTS as retired. That is the two-enforcement-paths deadlock this
 * repo has already hit once (see the narration in guards.spec.ts), and it blocks every Bash/Write/Edit.
 *
 * De-duplicated on the key too, so one missing policy entry reports ONE paste-ready snippet rather than
 * four copies of the same one under four different headings.
 */
// webpieces-disable no-function-outside-class -- existing stateless evaluator helpers extracted intact for both hook providers
export function checkConfigSync(rules: readonly Rule[], config: WebpiecesRulesConfig): BlockedResult | null {
    const configured = configuredRuleNames(config);
    const seen = new Set<string>();
    const unconfiguredRules = rules.filter((r: Rule): boolean => {
        if (configured.has(r.configKey) || seen.has(r.configKey)) return false;
        seen.add(r.configKey);
        return true;
    });
    if (unconfiguredRules.length === 0) return null;

    // ONE action, no menu, no escalation — the config-validation invariant (guards/L0-tooling.md): every
    // config problem cures to "make the file right", and editing it is never denied. This message used
    // to tell the agent to interview the human about each rule; agents did not do it, so the block just
    // stalled. Each rule now ships a paste-ready entry at its recommended mode.
    //
    // Note this is the CONFIG-BEHIND-CODE direction. The opposite one — the config names a rule the
    // installed validator has no schema for — is unknownRuleError() in rules-config/validate-config.ts
    // and surfaces in the validation banner, not here.
    const lines = [
        // Fault Y's header lives in ./l0-matrix beside the rest of the L0 fault table (same reason as
        // CONFIG_MISSING_REPORT: one place states what this fault is and what cures it).
        CONFIG_OUT_OF_SYNC_HEADER,
        '',
        `Add an entry for each rule below to ${CONFIG_FILENAME}. Editing that file is ALWAYS allowed through`,
        'the guard — including right now, while this block is up — so paste the entries and retry.',
        '',
        'Each entry below is ready to paste at its recommended mode; adjust the option values if your',
        'project needs different ones.',
        '',
        `Do NOT delete a rule from ${CONFIG_FILENAME} to silence it — an entry is REQUIRED for every rule,`,
        'and "mode": "OFF" is how a rule is turned off.',
        '',
    ];

    for (const rule of unconfiguredRules) {
        lines.push(`--- ${rule.configKey} ---`);
        lines.push(`Description: ${rule.description}`);
        const opts = rule.defaultOptions;
        const optKeys = Object.keys(opts);
        if (optKeys.length > 0) {
            lines.push(`Available options (suggested defaults shown):`);
            for (const key of optKeys) {
                lines.push(`  ${key}: ${JSON.stringify(opts[key])}`);
            }
        } else {
            lines.push('Available options: none beyond mode');
        }
        // The SAME entry the installer would seed: recommended mode, both hatches, and every other
        // schema-required field — so pasting it satisfies the loader in one pass.
        lines.push(`Entry to add to ${CONFIG_FILENAME}:`);
        lines.push(`  "${rule.configKey}": ${JSON.stringify(seedEntryForRule(rule.configKey))}`);
        lines.push('');
    }

    // Fault Y, stamped for the audit trail — see configMissingBlock for why the producer names it.
    return new BlockedResult(lines.join('\n'), L0_FAULT_CONFIG_OUT_OF_SYNC);
}

// N-legs pattern: each rule runs independently so one rule can never abort the others. A rule may
// EITHER return Violation[] OR throw — both accumulate here into visible violations the AI sees:
//  - a thrown RuleFailError  → an expected, well-formed violation (its line/snippet/fixOptions kept);
//  - a thrown plain Error    → a "crashed" violation (a bug, surfaced not swallowed).
// webpieces-disable no-function-outside-class -- existing stateless evaluator helpers extracted intact for both hook providers
export function runRuleCheck(rule: Rule, ctx: EditContext | FileContext | BashContext): readonly Violation[] {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        return rule.check(ctx);
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
export function runBashRules(rules: readonly Rule[], bashContext: BashContext): readonly RuleGroup[] {
    const groups: RuleGroup[] = [];
    for (const rule of rules) {
        if (rule.scope !== 'bash') continue;
        if (!rule.shouldRun()) continue;
        const vs = runRuleCheck(rule, bashContext);
        if (vs.length > 0) {
            groups.push(new RuleGroup(
                rule.name, rule.description, rule.fixHint, [...vs],
            ));
        }
    }
    return groups;
}

// webpieces-disable no-function-outside-class -- existing stateless evaluator helpers extracted intact for both hook providers
export function runEditRules(rules: readonly Rule[], editContexts: readonly EditContext[]): readonly RuleGroup[] {
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
            groups.push(new RuleGroup(
                rule.name, rule.description, rule.fixHint, allViolations,
            ));
        }
    }
    return groups;
}

// webpieces-disable no-function-outside-class -- existing stateless evaluator helpers extracted intact for both hook providers
export function runFileRules(rules: readonly Rule[], fileContext: FileContext): readonly RuleGroup[] {
    const groups: RuleGroup[] = [];
    for (const rule of rules) {
        if (rule.scope !== 'file') continue;
        if (!rule.shouldRun()) continue;
        if (!ruleMatchesFile(rule, fileContext.relativePath)) continue;
        const vs = runRuleCheck(rule, fileContext);
        if (vs.length > 0) {
            groups.push(new RuleGroup(
                rule.name, rule.description, rule.fixHint, [...vs],
            ));
        }
    }
    return groups;
}
