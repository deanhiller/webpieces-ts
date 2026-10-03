import { OwnedRuleDefinition, RULE_SCHEMA_API_VERSION } from '@webpieces/rules-sdk';
import { LintRuleConfig } from './lint-rule-config';
import { optionalTuning, recommendedSeeds } from './rule-settings';
import { ruleHelp } from './rule-help';

export class LintPolicy {
    constructor(
        readonly id: string,
        readonly ownerPack: string,
        readonly implementationExport: string,
    ) {}
}

export const LINT_POLICIES: readonly LintPolicy[] = [
    new LintPolicy('catch-error-pattern', '@webpieces/code-rules', 'catchErrorPattern'),
    new LintPolicy('no-unmanaged-exceptions', '@webpieces/code-rules', 'noUnmanagedExceptions'),
    new LintPolicy('max-method-lines', '@webpieces/code-rules', 'maxMethodLines'),
    new LintPolicy('max-file-lines', '@webpieces/code-rules', 'maxFileLines'),
    new LintPolicy('enforce-architecture', '@webpieces/eslint-rules', 'enforceArchitecture'),
    new LintPolicy(
        'no-json-property-primitive-type',
        '@webpieces/eslint-rules',
        'noJsonPropertyPrimitiveType',
    ),
    new LintPolicy('require-typed-template', '@webpieces/eslint-rules', 'requireTypedTemplate'),
    new LintPolicy('no-mat-cell-def', '@webpieces/eslint-rules', 'noMatCellDef'),
];

export const ownedRules = LINT_POLICIES.filter(
    (policy: LintPolicy) => policy.ownerPack === '@webpieces/eslint-rules',
).map(
    (policy: LintPolicy) =>
        new OwnedRuleDefinition(
            policy.id,
            LintRuleConfig.SCHEMA,
            RULE_SCHEMA_API_VERSION,
            optionalTuning[policy.id],
            recommendedSeeds[policy.id],
            'lint',
            ruleHelp[policy.id],
        ),
);
