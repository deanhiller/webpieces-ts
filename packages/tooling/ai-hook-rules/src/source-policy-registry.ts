import { OwnedRuleDefinition, RULE_SCHEMA_API_VERSION } from '@webpieces/rules-sdk';
import {
    ThrowCauseRequiredConfig,
    NoJsFilesConfig,
    ValidateTsInSrcConfig,
} from './configs/rule-configs';
import { optionalTuning, recommendedSeeds } from './rule-settings';
import { ruleHelp } from './rule-help';

export const ownedRules = [
    new OwnedRuleDefinition(
        'throw-cause-required',
        ThrowCauseRequiredConfig.SCHEMA,
        RULE_SCHEMA_API_VERSION,
        optionalTuning['throw-cause-required'],
        recommendedSeeds['throw-cause-required'],
        'rules',
        ruleHelp['throw-cause-required'],
    ),
    new OwnedRuleDefinition(
        'no-js-files',
        NoJsFilesConfig.SCHEMA,
        RULE_SCHEMA_API_VERSION,
        optionalTuning['no-js-files'],
        recommendedSeeds['no-js-files'],
        'rules',
        ruleHelp['no-js-files'],
    ),
    new OwnedRuleDefinition(
        'validate-ts-in-src',
        ValidateTsInSrcConfig.SCHEMA,
        RULE_SCHEMA_API_VERSION,
        optionalTuning['validate-ts-in-src'],
        recommendedSeeds['validate-ts-in-src'],
        'rules',
        ruleHelp['validate-ts-in-src'],
    ),
];

export class SourcePolicy {
    constructor(
        readonly id: string,
        readonly ownerPack: string,
        readonly implementationExport: string,
    ) {}
}

/** Source implementations and their canonical owners are declared exactly once. */
export const SOURCE_POLICIES: readonly SourcePolicy[] = [
    new SourcePolicy('no-any-unknown', '@webpieces/code-rules', 'NoAnyUnknownRule'),
    new SourcePolicy('no-implicit-any', '@webpieces/code-rules', 'NoImplicitAnyRule'),
    new SourcePolicy('max-file-lines', '@webpieces/code-rules', 'MaxFileLinesRule'),
    new SourcePolicy('max-method-lines', '@webpieces/code-rules', 'MaxMethodLinesRule'),
    new SourcePolicy('validate-ts-in-src', '@webpieces/ai-hook-rules', 'ValidateTsInSrcRule'),
    new SourcePolicy('no-destructure', '@webpieces/code-rules', 'NoDestructureRule'),
    new SourcePolicy('require-return-type', '@webpieces/code-rules', 'RequireReturnTypeRule'),
    new SourcePolicy(
        'no-unmanaged-exceptions',
        '@webpieces/code-rules',
        'NoUnmanagedExceptionsRule',
    ),
    new SourcePolicy('catch-error-pattern', '@webpieces/code-rules', 'CatchErrorPatternRule'),
    new SourcePolicy('throw-cause-required', '@webpieces/ai-hook-rules', 'ThrowCauseRequiredRule'),
    new SourcePolicy('no-symbol-di-tokens', '@webpieces/code-rules', 'NoSymbolDiTokensRule'),
    new SourcePolicy('no-custom-css', '@webpieces/code-rules', 'NoCustomCssRule'),
    new SourcePolicy(
        'no-process-exit-outside-main',
        '@webpieces/code-rules',
        'NoProcessExitOutsideMainRule',
    ),
    new SourcePolicy('no-js-files', '@webpieces/ai-hook-rules', 'NoJsFilesRule'),
];
