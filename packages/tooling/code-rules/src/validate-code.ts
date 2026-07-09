import {
    loadAndValidate,
    WebpiecesRulesConfig,
    BaseRuleConfig,
    MaxMethodLinesConfig,
    MaxFileLinesConfig,
    RequireReturnTypeConfig,
    NoInlineTypeLiteralsConfig,
    NoAnyUnknownConfig,
    NoImplicitAnyConfig,
    PrismaValidateDtosConfig,
    PrismaConverterConfig,
    NoDestructureConfig,
    CatchErrorPatternConfig,
    NoUnmanagedExceptionsConfig,
    AngularNoDirectApiInResolverConfig,
    NoSymbolDiTokensConfig,
    NoProcessExitOutsideMainConfig,
    NoFunctionOutsideClassConfig,
    FrameworkTagConfig,
    RoleTagConfig,
} from '@webpieces/rules-config';
import { CodeValidator, ExecutorResult } from './code-validator';
import { runValidators } from './rule-reporter';
import { MaxMethodLinesValidator } from './validate-modified-methods';
import { MaxFileLinesValidator } from './validate-modified-files';
import { RequireReturnTypeValidator } from './validate-return-types';
import { NoInlineTypeLiteralsValidator } from './validate-no-inline-types';
import { NoAnyUnknownValidator } from './validate-no-any-unknown';
import { NoImplicitAnyValidator } from './validate-no-implicit-any';
import { PrismaValidateDtosValidator } from './validate-dtos';
import { PrismaConverterValidator } from './validate-prisma-converters';
import { NoDestructureValidator } from './validate-no-destructure';
import { CatchErrorPatternValidator } from './validate-catch-error-pattern';
import { NoUnmanagedExceptionsValidator } from './validate-no-unmanaged-exceptions';
import { NoDirectApiResolverValidator } from './validate-no-direct-api-resolver';
import { NoSymbolDiTokensValidator } from './validate-no-symbol-di-tokens';
import { NoProcessExitOutsideMainValidator } from './validate-no-process-exit-outside-main';
import { NoFunctionOutsideClassValidator } from './validate-no-function-outside-class';
import { FrameworkTagValidator } from './validate-framework-tag';
import { RoleTagValidator } from './validate-role-tag';
import { MatchRulesValidator } from './validate-match-rules';
import { MatchRuleConfig } from '@webpieces/rules-config';

export { ExecutorResult } from './code-validator';

/**
 * Build every code validator from the typed WebpiecesRulesConfig. Each validator is
 * constructed with its own `*Config` (the genuinely-consumed config class), so the
 * config types are exercised at compile time. Missing rule keys fall back to an empty
 * config instance — `loadAndValidate` already validates that configured rules
 * carry an explicit `mode`, so in practice every key is present.
 */
function buildValidators(
    config: WebpiecesRulesConfig,
    matchRules: readonly MatchRuleConfig[],
): CodeValidator<BaseRuleConfig>[] {
    return [
        new MaxMethodLinesValidator(config['max-method-lines'] ?? new MaxMethodLinesConfig()),
        new MaxFileLinesValidator(config['max-file-lines'] ?? new MaxFileLinesConfig()),
        new RequireReturnTypeValidator(config['require-return-type'] ?? new RequireReturnTypeConfig()),
        new NoInlineTypeLiteralsValidator(config['no-inline-type-literals'] ?? new NoInlineTypeLiteralsConfig()),
        new NoAnyUnknownValidator(config['no-any-unknown'] ?? new NoAnyUnknownConfig()),
        new NoImplicitAnyValidator(config['no-implicit-any'] ?? new NoImplicitAnyConfig()),
        new PrismaValidateDtosValidator(config['prisma-validate-dtos'] ?? new PrismaValidateDtosConfig()),
        new PrismaConverterValidator(config['prisma-converter'] ?? new PrismaConverterConfig()),
        new NoDestructureValidator(config['no-destructure'] ?? new NoDestructureConfig()),
        new CatchErrorPatternValidator(config['catch-error-pattern'] ?? new CatchErrorPatternConfig()),
        new NoUnmanagedExceptionsValidator(config['no-unmanaged-exceptions'] ?? new NoUnmanagedExceptionsConfig()),
        new NoDirectApiResolverValidator(config['angular-no-direct-api-in-resolver'] ?? new AngularNoDirectApiInResolverConfig()),
        new NoSymbolDiTokensValidator(config['no-symbol-di-tokens'] ?? new NoSymbolDiTokensConfig()),
        new NoProcessExitOutsideMainValidator(config['no-process-exit-outside-main'] ?? new NoProcessExitOutsideMainConfig()),
        new NoFunctionOutsideClassValidator(config['no-function-outside-class'] ?? new NoFunctionOutsideClassConfig()),
        new FrameworkTagValidator(config['framework-tag'] ?? new FrameworkTagConfig()),
        new RoleTagValidator(config['role-tag'] ?? new RoleTagConfig()),
        // One validator per client-authored match-rules entry (each with its own name/mode/epoch).
        ...matchRules.map((mr: MatchRuleConfig) => new MatchRulesValidator(mr)),
    ];
}

/**
 * Run all configured code validators against the workspace.
 *
 * Owns config loading: callers just pass the workspace root. Config comes from
 * webpieces.config.json (loaded via @webpieces/rules-config so ai-hooks and this
 * executor agree on every rule's enabled/mode/options). A validator runs only when
 * `shouldRun()` is true (i.e. its mode is not OFF and no branch/epoch escape hatch matches).
 */
export default async function runValidator(workspaceRoot: string): Promise<ExecutorResult> {
    const loaded = loadAndValidate(workspaceRoot);
    if (loaded.configPath === null) {
        console.error('\n❌ No webpieces.config.json found at workspace root (or any ancestor).\n');
        return { success: false };
    }

    console.log(`\n📄 Loaded config: ${loaded.configPath}`);

    const validators = buildValidators(loaded.rulesConfig, loaded.matchRules);
    const active = validators.filter((v: CodeValidator<BaseRuleConfig>) => v.shouldRun());

    if (active.length === 0) {
        console.log('\n⏭️  Skipping all code validations (all modes: OFF)\n');
        return { success: true };
    }

    console.log('\n📏 Running Code Validations\n');
    console.log(`   Active rules: ${active.map((v: CodeValidator<BaseRuleConfig>) => v.name).join(', ')}`);
    console.log('');

    // Per-validator isolation lives in runValidators: a bug in one validator no longer aborts the
    // rest, and a thrown RuleFailError is reported like any other failure.
    const result = await runValidators(active, workspaceRoot);
    const allSuccess = result.success;

    console.log(allSuccess ? '\n✅ All code validations passed\n' : '\n❌ Some code validations failed\n');
    return { success: allSuccess };
}
