import { loadWebpiecesRulesConfig } from '@webpieces/rules-config';
import { toValidateCodeOptions } from './from-shared-config';
import { shouldSkipRule } from './resolve-mode';
import runNewMethodsExecutor from './validate-new-methods';
import runModifiedMethodsExecutor from './validate-modified-methods';
import runModifiedFilesExecutor from './validate-modified-files';
import runReturnTypesExecutor from './validate-return-types';
import runNoInlineTypesExecutor from './validate-no-inline-types';
import runNoAnyUnknownExecutor from './validate-no-any-unknown';
import runNoImplicitAnyExecutor from './validate-no-implicit-any';
import runValidateDtosExecutor from './validate-dtos';
import runPrismaConvertersExecutor from './validate-prisma-converters';
import runNoDestructureExecutor from './validate-no-destructure';
import runCatchErrorPatternExecutor from './validate-catch-error-pattern';
import runNoUnmanagedExceptionsExecutor from './validate-no-unmanaged-exceptions';
import runNoDirectApiResolverExecutor from './validate-no-direct-api-resolver';
import runNoSymbolDiTokensExecutor from './validate-no-symbol-di-tokens';
import type {
    MethodMaxLimitMode,
    FileMaxLimitMode,
    ReturnTypeMode,
    NoInlineTypesMode,
    NoAnyUnknownMode,
    NoImplicitAnyMode,
    ValidateDtosMode,
    PrismaConverterMode,
    NoDestructureMode,
    CatchErrorPatternMode,
    NoUnmanagedExceptionsMode,
    NoDirectApiResolverMode,
    NoSymbolDiTokensMode,
    MethodMaxLimitConfig,
    FileMaxLimitConfig,
    ValidateCodeOptions,
} from './validate-code-options';

export interface ExecutorResult {
    success: boolean;
}

interface OverrideInfo {
    active: boolean;
    normalMode: string;
    reason: string;
}

interface ParsedConfig {
    methodLimit: number;
    methodMode: MethodMaxLimitMode;
    methodDisableAllowed: boolean;
    methodOverride: OverrideInfo | undefined;
    fileLimit: number;
    fileMode: FileMaxLimitMode;
    fileDisableAllowed: boolean;
    fileOverride: OverrideInfo | undefined;
    returnTypeMode: ReturnTypeMode;
    returnTypeDisableAllowed: boolean;
    returnTypeIgnoreEpoch: number | undefined;
    returnTypeIgnoreBranch: string | undefined;
    noInlineTypesMode: NoInlineTypesMode;
    noInlineTypesDisableAllowed: boolean;
    noInlineTypesIgnoreEpoch: number | undefined;
    noInlineTypesIgnoreBranch: string | undefined;
    noAnyUnknownMode: NoAnyUnknownMode;
    noAnyUnknownDisableAllowed: boolean;
    noAnyUnknownIgnoreEpoch: number | undefined;
    noAnyUnknownIgnoreBranch: string | undefined;
    noImplicitAnyMode: NoImplicitAnyMode;
    noImplicitAnyDisableAllowed: boolean;
    noImplicitAnyIgnoreEpoch: number | undefined;
    noImplicitAnyIgnoreBranch: string | undefined;
    validateDtosMode: ValidateDtosMode;
    validateDtosDisableAllowed: boolean;
    validateDtosPrismaPath: string | undefined;
    validateDtosSrcPaths: string[];
    validateDtosIgnoreEpoch: number | undefined;
    validateDtosIgnoreBranch: string | undefined;
    prismaConverterMode: PrismaConverterMode;
    prismaConverterDisableAllowed: boolean;
    prismaConverterSchemaPath: string | undefined;
    prismaConverterConvertersPaths: string[];
    prismaConverterEnforcePaths: string[];
    prismaConverterIgnoreEpoch: number | undefined;
    prismaConverterIgnoreBranch: string | undefined;
    noDestructureMode: NoDestructureMode;
    noDestructureDisableAllowed: boolean;
    noDestructureIgnoreEpoch: number | undefined;
    noDestructureIgnoreBranch: string | undefined;
    catchErrorPatternMode: CatchErrorPatternMode;
    catchErrorPatternDisableAllowed: boolean;
    catchErrorPatternIgnoreEpoch: number | undefined;
    catchErrorPatternIgnoreBranch: string | undefined;
    noUnmanagedExceptionsMode: NoUnmanagedExceptionsMode;
    noUnmanagedExceptionsDisableAllowed: boolean;
    noUnmanagedExceptionsIgnoreEpoch: number | undefined;
    noUnmanagedExceptionsIgnoreBranch: string | undefined;
    noDirectApiResolverMode: NoDirectApiResolverMode;
    noDirectApiResolverDisableAllowed: boolean;
    noDirectApiResolverIgnoreEpoch: number | undefined;
    noDirectApiResolverIgnoreBranch: string | undefined;
    noDirectApiResolverEnforcePaths: string[];
    noSymbolDiTokensMode: NoSymbolDiTokensMode;
    noSymbolDiTokensDisableAllowed: boolean;
    noSymbolDiTokensIgnoreEpoch: number | undefined;
    noSymbolDiTokensIgnoreBranch: string | undefined;
    noSymbolDiTokensAllowedPaths: string[];
}

interface ResolvedMethodMode {
    mode: MethodMaxLimitMode;
    override: OverrideInfo | undefined;
}

interface ResolvedFileMode {
    mode: FileMaxLimitMode;
    override: OverrideInfo | undefined;
}

const VALID_MODES: Record<string, string[]> = {
    methodMaxLimit:       ['OFF', 'NEW_METHODS', 'NEW_AND_MODIFIED_METHODS', 'MODIFIED_FILES'],
    fileMaxLimit:         ['OFF', 'MODIFIED_FILES'],
    requireReturnType:    ['OFF', 'NEW_METHODS', 'NEW_AND_MODIFIED_METHODS', 'MODIFIED_FILES'],
    noInlineTypeLiterals: ['OFF', 'NEW_METHODS', 'NEW_AND_MODIFIED_METHODS', 'MODIFIED_FILES'],
    noAnyUnknown:         ['OFF', 'MODIFIED_CODE', 'MODIFIED_FILES'],
    noImplicitAny:        ['OFF', 'MODIFIED_CODE', 'MODIFIED_FILES'],
    validateDtos:         ['OFF', 'MODIFIED_CLASS', 'MODIFIED_FILES'],
    prismaConverter:      ['OFF', 'NEW_AND_MODIFIED_METHODS', 'MODIFIED_FILES'],
    noDestructure:        ['OFF', 'MODIFIED_CODE', 'MODIFIED_FILES'],
    catchErrorPattern:    ['OFF', 'MODIFIED_CODE', 'MODIFIED_FILES'],
    noUnmanagedExceptions: ['OFF', 'MODIFIED_CODE', 'MODIFIED_FILES'],
    noDirectApiInResolver: ['OFF', 'MODIFIED_CODE', 'NEW_AND_MODIFIED_METHODS', 'MODIFIED_FILES'],
    noSymbolDiTokens: ['OFF', 'MODIFIED_CODE', 'MODIFIED_FILES'],
};

/**
 * Validate that all configured modes are valid. Produces clear error messages naming the rule.
 */
function validateModes(options: ValidateCodeOptions): string[] {
    const errors: string[] = [];

    type ModeEntry = [string, string | undefined];
    const modeEntries: ModeEntry[] = [
        ['methodMaxLimit', options.methodMaxLimit?.mode],
        ['fileMaxLimit', options.fileMaxLimit?.mode],
        ['requireReturnType', options.requireReturnType?.mode],
        ['noInlineTypeLiterals', options.noInlineTypeLiterals?.mode],
        ['noAnyUnknown', options.noAnyUnknown?.mode],
        ['noImplicitAny', options.noImplicitAny?.mode],
        ['validateDtos', options.validateDtos?.mode],
        ['prismaConverter', options.prismaConverter?.mode],
        ['noDestructure', options.noDestructure?.mode],
        ['catchErrorPattern', options.catchErrorPattern?.mode],
        ['noUnmanagedExceptions', options.noUnmanagedExceptions?.mode],
        ['noDirectApiInResolver', options.noDirectApiInResolver?.mode],
        ['noSymbolDiTokens', options.noSymbolDiTokens?.mode],
    ];

    for (const entry of modeEntries) {
        const ruleName = entry[0];
        const modeValue = entry[1];
        if (modeValue === undefined) continue;
        const validModes = VALID_MODES[ruleName];
        if (!validModes.includes(modeValue)) {
            errors.push(`${ruleName}.mode = '${modeValue}' is invalid. Valid modes: ${validModes.join(', ')}`);
        }
    }

    return errors;
}

function resolveMethodMode(
    normalMode: MethodMaxLimitMode, epoch: number | undefined, branchPattern: string | undefined
): ResolvedMethodMode {
    if (normalMode === 'OFF') {
        return { mode: 'OFF', override: undefined };
    }
    const skip = shouldSkipRule(epoch, branchPattern);
    if (skip.skip) {
        return {
            mode: 'OFF',
            override: { active: true, normalMode, reason: skip.reason! },
        };
    }
    return { mode: normalMode, override: undefined };
}

function resolveFileMode(
    normalMode: FileMaxLimitMode, epoch: number | undefined, branchPattern: string | undefined
): ResolvedFileMode {
    if (normalMode === 'OFF') {
        return { mode: 'OFF', override: undefined };
    }
    const skip = shouldSkipRule(epoch, branchPattern);
    if (skip.skip) {
        return {
            mode: 'OFF',
            override: { active: true, normalMode, reason: skip.reason! },
        };
    }
    return { mode: normalMode, override: undefined };
}

function parseConfig(options: ValidateCodeOptions): ParsedConfig {
    const methodConfig: MethodMaxLimitConfig = options.methodMaxLimit ?? {};
    const fileConfig: FileMaxLimitConfig = options.fileMaxLimit ?? {};

    const normalMethodMode = methodConfig.mode ?? 'NEW_AND_MODIFIED_METHODS';
    const normalFileMode = fileConfig.mode ?? 'MODIFIED_FILES';

    const methodResolved = resolveMethodMode(normalMethodMode, methodConfig.ignoreModifiedUntilEpoch, methodConfig.ignoreRuleWhileOnBranch);
    const fileResolved = resolveFileMode(normalFileMode, fileConfig.ignoreModifiedUntilEpoch, fileConfig.ignoreRuleWhileOnBranch);

    return {
        methodLimit: methodConfig.limit ?? 80,
        methodMode: methodResolved.mode,
        methodDisableAllowed: methodConfig.disableAllowed ?? true,
        methodOverride: methodResolved.override,
        fileLimit: fileConfig.limit ?? 900,
        fileMode: fileResolved.mode,
        fileDisableAllowed: fileConfig.disableAllowed ?? true,
        fileOverride: fileResolved.override,
        returnTypeMode: options.requireReturnType?.mode ?? 'OFF',
        returnTypeDisableAllowed: options.requireReturnType?.disableAllowed ?? true,
        returnTypeIgnoreEpoch: options.requireReturnType?.ignoreModifiedUntilEpoch,
        returnTypeIgnoreBranch: options.requireReturnType?.ignoreRuleWhileOnBranch,
        noInlineTypesMode: options.noInlineTypeLiterals?.mode ?? 'OFF',
        noInlineTypesDisableAllowed: options.noInlineTypeLiterals?.disableAllowed ?? true,
        noInlineTypesIgnoreEpoch: options.noInlineTypeLiterals?.ignoreModifiedUntilEpoch,
        noInlineTypesIgnoreBranch: options.noInlineTypeLiterals?.ignoreRuleWhileOnBranch,
        noAnyUnknownMode: options.noAnyUnknown?.mode ?? 'OFF',
        noAnyUnknownDisableAllowed: options.noAnyUnknown?.disableAllowed ?? true,
        noAnyUnknownIgnoreEpoch: options.noAnyUnknown?.ignoreModifiedUntilEpoch,
        noAnyUnknownIgnoreBranch: options.noAnyUnknown?.ignoreRuleWhileOnBranch,
        noImplicitAnyMode: options.noImplicitAny?.mode ?? 'OFF',
        noImplicitAnyDisableAllowed: options.noImplicitAny?.disableAllowed ?? true,
        noImplicitAnyIgnoreEpoch: options.noImplicitAny?.ignoreModifiedUntilEpoch,
        noImplicitAnyIgnoreBranch: options.noImplicitAny?.ignoreRuleWhileOnBranch,
        validateDtosMode: options.validateDtos?.mode ?? 'OFF',
        validateDtosDisableAllowed: options.validateDtos?.disableAllowed ?? true,
        validateDtosPrismaPath: options.validateDtos?.prismaSchemaPath,
        validateDtosSrcPaths: options.validateDtos?.dtoSourcePaths ?? [],
        validateDtosIgnoreEpoch: options.validateDtos?.ignoreModifiedUntilEpoch,
        validateDtosIgnoreBranch: options.validateDtos?.ignoreRuleWhileOnBranch,
        prismaConverterMode: options.prismaConverter?.mode ?? 'OFF',
        prismaConverterDisableAllowed: options.prismaConverter?.disableAllowed ?? true,
        prismaConverterSchemaPath: options.prismaConverter?.schemaPath,
        prismaConverterConvertersPaths: options.prismaConverter?.convertersPaths ?? [],
        prismaConverterEnforcePaths: options.prismaConverter?.enforcePaths ?? [],
        prismaConverterIgnoreEpoch: options.prismaConverter?.ignoreModifiedUntilEpoch,
        prismaConverterIgnoreBranch: options.prismaConverter?.ignoreRuleWhileOnBranch,
        noDestructureMode: options.noDestructure?.mode ?? 'OFF',
        noDestructureDisableAllowed: options.noDestructure?.disableAllowed ?? true,
        noDestructureIgnoreEpoch: options.noDestructure?.ignoreModifiedUntilEpoch,
        noDestructureIgnoreBranch: options.noDestructure?.ignoreRuleWhileOnBranch,
        catchErrorPatternMode: options.catchErrorPattern?.mode ?? 'OFF',
        catchErrorPatternDisableAllowed: options.catchErrorPattern?.disableAllowed ?? true,
        catchErrorPatternIgnoreEpoch: options.catchErrorPattern?.ignoreModifiedUntilEpoch,
        catchErrorPatternIgnoreBranch: options.catchErrorPattern?.ignoreRuleWhileOnBranch,
        noUnmanagedExceptionsMode: options.noUnmanagedExceptions?.mode ?? 'OFF',
        noUnmanagedExceptionsDisableAllowed: options.noUnmanagedExceptions?.disableAllowed ?? true,
        noUnmanagedExceptionsIgnoreEpoch: options.noUnmanagedExceptions?.ignoreModifiedUntilEpoch,
        noUnmanagedExceptionsIgnoreBranch: options.noUnmanagedExceptions?.ignoreRuleWhileOnBranch,
        noDirectApiResolverMode: options.noDirectApiInResolver?.mode ?? 'OFF',
        noDirectApiResolverDisableAllowed: options.noDirectApiInResolver?.disableAllowed ?? true,
        noDirectApiResolverIgnoreEpoch: options.noDirectApiInResolver?.ignoreModifiedUntilEpoch,
        noDirectApiResolverIgnoreBranch: options.noDirectApiInResolver?.ignoreRuleWhileOnBranch,
        noDirectApiResolverEnforcePaths: options.noDirectApiInResolver?.enforcePaths ?? [],
        noSymbolDiTokensMode: options.noSymbolDiTokens?.mode ?? 'OFF',
        noSymbolDiTokensDisableAllowed: options.noSymbolDiTokens?.disableAllowed ?? true,
        noSymbolDiTokensIgnoreEpoch: options.noSymbolDiTokens?.ignoreModifiedUntilEpoch,
        noSymbolDiTokensIgnoreBranch: options.noSymbolDiTokens?.ignoreRuleWhileOnBranch,
        noSymbolDiTokensAllowedPaths: options.noSymbolDiTokens?.allowedPaths ?? [],
    };
}

function formatOverride(override: OverrideInfo | undefined): string {
    if (!override) {
        return '';
    }
    return ` (override active, normal: ${override.normalMode}, ${override.reason})`;
}

function logConfig(config: ParsedConfig): void {
    console.log('\n\ud83d\udccf Running Code Validations\n');
    console.log(`   Method limits: mode=${config.methodMode}${formatOverride(config.methodOverride)}, limit=${config.methodLimit}, disableAllowed=${config.methodDisableAllowed}`);
    console.log(`   File limits: mode=${config.fileMode}${formatOverride(config.fileOverride)}, limit=${config.fileLimit}, disableAllowed=${config.fileDisableAllowed}`);
    console.log(`   Require return types: mode=${config.returnTypeMode}, disableAllowed=${config.returnTypeDisableAllowed}`);
    console.log(`   No inline type literals: mode=${config.noInlineTypesMode}, disableAllowed=${config.noInlineTypesDisableAllowed}`);
    console.log(`   No any/unknown: mode=${config.noAnyUnknownMode}, disableAllowed=${config.noAnyUnknownDisableAllowed}`);
    console.log(`   No implicit any: mode=${config.noImplicitAnyMode}, disableAllowed=${config.noImplicitAnyDisableAllowed}`);
    console.log(`   [Prisma] Validate DTOs: mode=${config.validateDtosMode}, disableAllowed=${config.validateDtosDisableAllowed}`);
    console.log(`   [Prisma] Prisma converters: mode=${config.prismaConverterMode}, disableAllowed=${config.prismaConverterDisableAllowed}`);
    console.log(`   No destructure: mode=${config.noDestructureMode}, disableAllowed=${config.noDestructureDisableAllowed}`);
    console.log(`   Catch error pattern: mode=${config.catchErrorPatternMode}, disableAllowed=${config.catchErrorPatternDisableAllowed}`);
    console.log(`   No unmanaged exceptions: mode=${config.noUnmanagedExceptionsMode}, disableAllowed=${config.noUnmanagedExceptionsDisableAllowed}`);
    console.log(`   [Angular] No direct API in resolver: mode=${config.noDirectApiResolverMode}, disableAllowed=${config.noDirectApiResolverDisableAllowed}`);
    console.log(`   No Symbol DI tokens: mode=${config.noSymbolDiTokensMode}, disableAllowed=${config.noSymbolDiTokensDisableAllowed}`);
    console.log('');
}

function isAllOff(config: ParsedConfig): boolean {
    return config.methodMode === 'OFF' && config.fileMode === 'OFF' &&
        config.returnTypeMode === 'OFF' && config.noInlineTypesMode === 'OFF' &&
        config.noAnyUnknownMode === 'OFF' && config.noImplicitAnyMode === 'OFF' &&
        config.validateDtosMode === 'OFF' &&
        config.prismaConverterMode === 'OFF' && config.noDestructureMode === 'OFF' &&
        config.catchErrorPatternMode === 'OFF' && config.noUnmanagedExceptionsMode === 'OFF' &&
        config.noDirectApiResolverMode === 'OFF' && config.noSymbolDiTokensMode === 'OFF';
}

async function runMethodValidators(config: ParsedConfig, workspaceRoot: string): Promise<ExecutorResult[]> {
    const results: ExecutorResult[] = [];
    const runNew = config.methodMode === 'NEW_METHODS' || config.methodMode === 'NEW_AND_MODIFIED_METHODS';
    const runModified = config.methodMode === 'NEW_AND_MODIFIED_METHODS' || config.methodMode === 'MODIFIED_FILES';

    if (runNew) {
        results.push(await runNewMethodsExecutor({
            limit: config.methodLimit,
            mode: config.methodMode, disableAllowed: config.methodDisableAllowed,
        }, workspaceRoot));
    }
    if (runModified) {
        results.push(await runModifiedMethodsExecutor({
            limit: config.methodLimit, mode: config.methodMode, disableAllowed: config.methodDisableAllowed,
        }, workspaceRoot));
    }
    return results;
}

async function runLintStyleValidators(config: ParsedConfig, workspaceRoot: string): Promise<ExecutorResult[]> {
    const r: ExecutorResult[] = [];
    r.push(await runNoDestructureExecutor({ mode: config.noDestructureMode, disableAllowed: config.noDestructureDisableAllowed, ignoreModifiedUntilEpoch: config.noDestructureIgnoreEpoch, ignoreRuleWhileOnBranch: config.noDestructureIgnoreBranch }, workspaceRoot));
    r.push(await runCatchErrorPatternExecutor({ mode: config.catchErrorPatternMode, disableAllowed: config.catchErrorPatternDisableAllowed, ignoreModifiedUntilEpoch: config.catchErrorPatternIgnoreEpoch, ignoreRuleWhileOnBranch: config.catchErrorPatternIgnoreBranch }, workspaceRoot));
    r.push(await runNoUnmanagedExceptionsExecutor({ mode: config.noUnmanagedExceptionsMode, disableAllowed: config.noUnmanagedExceptionsDisableAllowed, ignoreModifiedUntilEpoch: config.noUnmanagedExceptionsIgnoreEpoch, ignoreRuleWhileOnBranch: config.noUnmanagedExceptionsIgnoreBranch }, workspaceRoot));
    r.push(await runNoDirectApiResolverExecutor({ mode: config.noDirectApiResolverMode, disableAllowed: config.noDirectApiResolverDisableAllowed, ignoreModifiedUntilEpoch: config.noDirectApiResolverIgnoreEpoch, ignoreRuleWhileOnBranch: config.noDirectApiResolverIgnoreBranch, enforcePaths: config.noDirectApiResolverEnforcePaths }, workspaceRoot));
    r.push(await runNoSymbolDiTokensExecutor({ mode: config.noSymbolDiTokensMode, disableAllowed: config.noSymbolDiTokensDisableAllowed, ignoreModifiedUntilEpoch: config.noSymbolDiTokensIgnoreEpoch, ignoreRuleWhileOnBranch: config.noSymbolDiTokensIgnoreBranch, allowedPaths: config.noSymbolDiTokensAllowedPaths }, workspaceRoot));
    return r;
}

async function runAllValidators(config: ParsedConfig, workspaceRoot: string): Promise<ExecutorResult[]> {
    const results: ExecutorResult[] = [];
    results.push(...await runMethodValidators(config, workspaceRoot));
    results.push(await runModifiedFilesExecutor({
        limit: config.fileLimit, mode: config.fileMode, disableAllowed: config.fileDisableAllowed,
    }, workspaceRoot));
    results.push(await runReturnTypesExecutor({ mode: config.returnTypeMode, disableAllowed: config.returnTypeDisableAllowed, ignoreModifiedUntilEpoch: config.returnTypeIgnoreEpoch, ignoreRuleWhileOnBranch: config.returnTypeIgnoreBranch }, workspaceRoot));
    results.push(await runNoInlineTypesExecutor({ mode: config.noInlineTypesMode, disableAllowed: config.noInlineTypesDisableAllowed, ignoreModifiedUntilEpoch: config.noInlineTypesIgnoreEpoch, ignoreRuleWhileOnBranch: config.noInlineTypesIgnoreBranch }, workspaceRoot));
    results.push(await runNoAnyUnknownExecutor({ mode: config.noAnyUnknownMode, disableAllowed: config.noAnyUnknownDisableAllowed, ignoreModifiedUntilEpoch: config.noAnyUnknownIgnoreEpoch, ignoreRuleWhileOnBranch: config.noAnyUnknownIgnoreBranch }, workspaceRoot));
    results.push(await runNoImplicitAnyExecutor({ mode: config.noImplicitAnyMode, disableAllowed: config.noImplicitAnyDisableAllowed, ignoreModifiedUntilEpoch: config.noImplicitAnyIgnoreEpoch, ignoreRuleWhileOnBranch: config.noImplicitAnyIgnoreBranch }, workspaceRoot));
    results.push(await runValidateDtosExecutor({
        mode: config.validateDtosMode, disableAllowed: config.validateDtosDisableAllowed,
        prismaSchemaPath: config.validateDtosPrismaPath, dtoSourcePaths: config.validateDtosSrcPaths,
        ignoreModifiedUntilEpoch: config.validateDtosIgnoreEpoch, ignoreRuleWhileOnBranch: config.validateDtosIgnoreBranch,
    }, workspaceRoot));
    results.push(await runPrismaConvertersExecutor({
        mode: config.prismaConverterMode, disableAllowed: config.prismaConverterDisableAllowed,
        schemaPath: config.prismaConverterSchemaPath, convertersPaths: config.prismaConverterConvertersPaths,
        enforcePaths: config.prismaConverterEnforcePaths,
        ignoreModifiedUntilEpoch: config.prismaConverterIgnoreEpoch, ignoreRuleWhileOnBranch: config.prismaConverterIgnoreBranch,
    }, workspaceRoot));
    results.push(...await runLintStyleValidators(config, workspaceRoot));
    return results;
}

export default async function runValidator(
    _nxOptions: ValidateCodeOptions,
    workspaceRoot: string
): Promise<ExecutorResult> {
    // Config comes from webpieces.config.json at the workspace root,
    // loaded via the shared @webpieces/rules-config loader so ai-hooks and
    // this executor agree on every rule's enabled/mode/options.
    const loaded = loadWebpiecesRulesConfig(workspaceRoot);
    if (!loaded) {
        console.error('\n❌ No webpieces.config.json found at workspace root (or any ancestor).\n');
        return { success: false };
    }
    const options = toValidateCodeOptions(loaded.config);

    const modeErrors = validateModes(options);
    if (modeErrors.length > 0) {
        console.error('');
        for (const err of modeErrors) {
            console.error(`❌ ${err}`);
        }
        console.error('');
        return { success: false };
    }

    console.log(`\n📄 Loaded config: ${loaded.configPath}`);

    const config = parseConfig(options);

    if (isAllOff(config)) {
        console.log('\n\u23ed\ufe0f  Skipping all code validations (all modes: OFF)\n');
        return { success: true };
    }

    logConfig(config);

    const results = await runAllValidators(config, workspaceRoot);
    const allSuccess = results.every((r) => r.success);

    console.log(allSuccess ? '\n\u2705 All code validations passed\n' : '\n\u274c Some code validations failed\n');
    return { success: allSuccess };
}
