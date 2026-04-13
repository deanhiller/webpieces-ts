import { ExecutorContext } from '@nx/devkit';
import runNewMethodsExecutor from '../validate-new-methods/executor';
import runModifiedMethodsExecutor from '../validate-modified-methods/executor';
import runModifiedFilesExecutor from '../validate-modified-files/executor';
import runReturnTypesExecutor, { ReturnTypeMode } from '../validate-return-types/executor';
import runNoInlineTypesExecutor, { NoInlineTypesMode } from '../validate-no-inline-types/executor';
import runNoAnyUnknownExecutor, { NoAnyUnknownMode } from '../validate-no-any-unknown/executor';
import runValidateDtosExecutor, { ValidateDtosMode } from '../validate-dtos/executor';
import runPrismaConvertersExecutor, { PrismaConverterMode } from '../validate-prisma-converters/executor';
import runNoDestructureExecutor, { NoDestructureMode } from '../validate-no-destructure/executor';
import runCatchErrorPatternExecutor, { CatchErrorPatternMode } from '../validate-catch-error-pattern/executor';
import runNoUnmanagedExceptionsExecutor, { NoUnmanagedExceptionsMode } from '../validate-no-unmanaged-exceptions/executor';
import runNoDirectApiResolverExecutor, { NoDirectApiResolverMode } from '../validate-no-direct-api-resolver/executor';

export type MethodMaxLimitMode = 'OFF' | 'NEW_METHODS' | 'NEW_AND_MODIFIED_METHODS' | 'MODIFIED_FILES';
export type FileMaxLimitMode = 'OFF' | 'MODIFIED_FILES';

export interface MethodMaxLimitConfig {
    limit?: number;
    mode?: MethodMaxLimitMode;
    disableAllowed?: boolean;
    ignoreModifiedUntilEpoch?: number;
}

export interface FileMaxLimitConfig {
    limit?: number;
    mode?: FileMaxLimitMode;
    disableAllowed?: boolean;
    ignoreModifiedUntilEpoch?: number;
}

export interface RequireReturnTypeConfig {
    mode?: ReturnTypeMode;
    disableAllowed?: boolean;
    ignoreModifiedUntilEpoch?: number;
}

export interface NoInlineTypeLiteralsConfig {
    mode?: NoInlineTypesMode;
    disableAllowed?: boolean;
    ignoreModifiedUntilEpoch?: number;
}

export interface NoAnyUnknownConfig {
    mode?: NoAnyUnknownMode;
    disableAllowed?: boolean;
    ignoreModifiedUntilEpoch?: number;
}

export interface ValidateDtosConfig {
    mode?: ValidateDtosMode;
    disableAllowed?: boolean;
    prismaSchemaPath?: string;
    dtoSourcePaths?: string[];
    ignoreModifiedUntilEpoch?: number;
}

export interface PrismaConverterConfig {
    mode?: PrismaConverterMode;
    disableAllowed?: boolean;
    schemaPath?: string;
    convertersPaths?: string[];
    enforcePaths?: string[];
    ignoreModifiedUntilEpoch?: number;
}

export interface NoDestructureConfig {
    mode?: NoDestructureMode;
    disableAllowed?: boolean;
    ignoreModifiedUntilEpoch?: number;
}

export interface CatchErrorPatternConfig {
    mode?: CatchErrorPatternMode;
    disableAllowed?: boolean;
    ignoreModifiedUntilEpoch?: number;
}

export interface NoUnmanagedExceptionsConfig {
    mode?: NoUnmanagedExceptionsMode;
    disableAllowed?: boolean;
    ignoreModifiedUntilEpoch?: number;
}

export interface NoDirectApiResolverConfig {
    mode?: NoDirectApiResolverMode;
    disableAllowed?: boolean;
    ignoreModifiedUntilEpoch?: number;
    enforcePaths?: string[];
}

export interface ValidateCodeOptions {
    methodMaxLimit?: MethodMaxLimitConfig;
    fileMaxLimit?: FileMaxLimitConfig;
    requireReturnType?: RequireReturnTypeConfig;
    noInlineTypeLiterals?: NoInlineTypeLiteralsConfig;
    noAnyUnknown?: NoAnyUnknownConfig;
    validateDtos?: ValidateDtosConfig;
    prismaConverter?: PrismaConverterConfig;
    noDestructure?: NoDestructureConfig;
    catchErrorPattern?: CatchErrorPatternConfig;
    noUnmanagedExceptions?: NoUnmanagedExceptionsConfig;
    noDirectApiInResolver?: NoDirectApiResolverConfig;
}

export interface ExecutorResult {
    success: boolean;
}

interface OverrideInfo {
    active: boolean;
    normalMode: string;
    expiresDate: string;
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
    noInlineTypesMode: NoInlineTypesMode;
    noInlineTypesDisableAllowed: boolean;
    noInlineTypesIgnoreEpoch: number | undefined;
    noAnyUnknownMode: NoAnyUnknownMode;
    noAnyUnknownDisableAllowed: boolean;
    noAnyUnknownIgnoreEpoch: number | undefined;
    validateDtosMode: ValidateDtosMode;
    validateDtosDisableAllowed: boolean;
    validateDtosPrismaPath: string | undefined;
    validateDtosSrcPaths: string[];
    validateDtosIgnoreEpoch: number | undefined;
    prismaConverterMode: PrismaConverterMode;
    prismaConverterDisableAllowed: boolean;
    prismaConverterSchemaPath: string | undefined;
    prismaConverterConvertersPaths: string[];
    prismaConverterEnforcePaths: string[];
    prismaConverterIgnoreEpoch: number | undefined;
    noDestructureMode: NoDestructureMode;
    noDestructureDisableAllowed: boolean;
    noDestructureIgnoreEpoch: number | undefined;
    catchErrorPatternMode: CatchErrorPatternMode;
    catchErrorPatternDisableAllowed: boolean;
    catchErrorPatternIgnoreEpoch: number | undefined;
    noUnmanagedExceptionsMode: NoUnmanagedExceptionsMode;
    noUnmanagedExceptionsDisableAllowed: boolean;
    noUnmanagedExceptionsIgnoreEpoch: number | undefined;
    noDirectApiResolverMode: NoDirectApiResolverMode;
    noDirectApiResolverDisableAllowed: boolean;
    noDirectApiResolverIgnoreEpoch: number | undefined;
    noDirectApiResolverEnforcePaths: string[];
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
    validateDtos:         ['OFF', 'MODIFIED_CLASS', 'MODIFIED_FILES'],
    prismaConverter:      ['OFF', 'NEW_AND_MODIFIED_METHODS', 'MODIFIED_FILES'],
    noDestructure:        ['OFF', 'MODIFIED_CODE', 'MODIFIED_FILES'],
    catchErrorPattern:    ['OFF', 'MODIFIED_CODE', 'MODIFIED_FILES'],
    noUnmanagedExceptions: ['OFF', 'MODIFIED_CODE', 'MODIFIED_FILES'],
    noDirectApiInResolver: ['OFF', 'MODIFIED_CODE', 'NEW_AND_MODIFIED_METHODS', 'MODIFIED_FILES'],
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
        ['validateDtos', options.validateDtos?.mode],
        ['prismaConverter', options.prismaConverter?.mode],
        ['noDestructure', options.noDestructure?.mode],
        ['catchErrorPattern', options.catchErrorPattern?.mode],
        ['noUnmanagedExceptions', options.noUnmanagedExceptions?.mode],
        ['noDirectApiInResolver', options.noDirectApiInResolver?.mode],
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

function formatEpochDate(epoch: number): string {
    return new Date(epoch * 1000).toISOString().split('T')[0];
}

function resolveMethodMode(
    normalMode: MethodMaxLimitMode, epoch: number | undefined
): ResolvedMethodMode {
    if (epoch === undefined) {
        return { mode: normalMode, override: undefined };
    }
    const nowSeconds = Date.now() / 1000;
    if (nowSeconds < epoch) {
        // Active: downgrade to skip modified checking
        const downgraded: MethodMaxLimitMode =
            normalMode === 'OFF' ? 'OFF' : 'NEW_METHODS';
        return {
            mode: downgraded,
            override: { active: true, normalMode, expiresDate: formatEpochDate(epoch) },
        };
    }
    // Expired
    return { mode: normalMode, override: undefined };
}

function resolveFileMode(
    normalMode: FileMaxLimitMode, epoch: number | undefined
): ResolvedFileMode {
    if (epoch === undefined) {
        return { mode: normalMode, override: undefined };
    }
    const nowSeconds = Date.now() / 1000;
    if (nowSeconds < epoch) {
        // Active: file checking is inherently about modified files, so skip entirely
        return {
            mode: 'OFF',
            override: { active: true, normalMode, expiresDate: formatEpochDate(epoch) },
        };
    }
    // Expired
    return { mode: normalMode, override: undefined };
}

function parseConfig(options: ValidateCodeOptions): ParsedConfig {
    const methodConfig: MethodMaxLimitConfig = options.methodMaxLimit ?? {};
    const fileConfig: FileMaxLimitConfig = options.fileMaxLimit ?? {};

    const normalMethodMode = methodConfig.mode ?? 'NEW_AND_MODIFIED_METHODS';
    const normalFileMode = fileConfig.mode ?? 'MODIFIED_FILES';

    const methodResolved = resolveMethodMode(normalMethodMode, methodConfig.ignoreModifiedUntilEpoch);
    const fileResolved = resolveFileMode(normalFileMode, fileConfig.ignoreModifiedUntilEpoch);

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
        noInlineTypesMode: options.noInlineTypeLiterals?.mode ?? 'OFF',
        noInlineTypesDisableAllowed: options.noInlineTypeLiterals?.disableAllowed ?? true,
        noInlineTypesIgnoreEpoch: options.noInlineTypeLiterals?.ignoreModifiedUntilEpoch,
        noAnyUnknownMode: options.noAnyUnknown?.mode ?? 'OFF',
        noAnyUnknownDisableAllowed: options.noAnyUnknown?.disableAllowed ?? true,
        noAnyUnknownIgnoreEpoch: options.noAnyUnknown?.ignoreModifiedUntilEpoch,
        validateDtosMode: options.validateDtos?.mode ?? 'OFF',
        validateDtosDisableAllowed: options.validateDtos?.disableAllowed ?? true,
        validateDtosPrismaPath: options.validateDtos?.prismaSchemaPath,
        validateDtosSrcPaths: options.validateDtos?.dtoSourcePaths ?? [],
        validateDtosIgnoreEpoch: options.validateDtos?.ignoreModifiedUntilEpoch,
        prismaConverterMode: options.prismaConverter?.mode ?? 'OFF',
        prismaConverterDisableAllowed: options.prismaConverter?.disableAllowed ?? true,
        prismaConverterSchemaPath: options.prismaConverter?.schemaPath,
        prismaConverterConvertersPaths: options.prismaConverter?.convertersPaths ?? [],
        prismaConverterEnforcePaths: options.prismaConverter?.enforcePaths ?? [],
        prismaConverterIgnoreEpoch: options.prismaConverter?.ignoreModifiedUntilEpoch,
        noDestructureMode: options.noDestructure?.mode ?? 'OFF',
        noDestructureDisableAllowed: options.noDestructure?.disableAllowed ?? true,
        noDestructureIgnoreEpoch: options.noDestructure?.ignoreModifiedUntilEpoch,
        catchErrorPatternMode: options.catchErrorPattern?.mode ?? 'OFF',
        catchErrorPatternDisableAllowed: options.catchErrorPattern?.disableAllowed ?? true,
        catchErrorPatternIgnoreEpoch: options.catchErrorPattern?.ignoreModifiedUntilEpoch,
        noUnmanagedExceptionsMode: options.noUnmanagedExceptions?.mode ?? 'OFF',
        noUnmanagedExceptionsDisableAllowed: options.noUnmanagedExceptions?.disableAllowed ?? true,
        noUnmanagedExceptionsIgnoreEpoch: options.noUnmanagedExceptions?.ignoreModifiedUntilEpoch,
        noDirectApiResolverMode: options.noDirectApiInResolver?.mode ?? 'OFF',
        noDirectApiResolverDisableAllowed: options.noDirectApiInResolver?.disableAllowed ?? true,
        noDirectApiResolverIgnoreEpoch: options.noDirectApiInResolver?.ignoreModifiedUntilEpoch,
        noDirectApiResolverEnforcePaths: options.noDirectApiInResolver?.enforcePaths ?? [],
    };
}

function formatOverride(override: OverrideInfo | undefined): string {
    if (!override) {
        return '';
    }
    return ` (override active, normal: ${override.normalMode}, expires: ${override.expiresDate})`;
}

function logConfig(config: ParsedConfig): void {
    console.log('\n\ud83d\udccf Running Code Validations\n');
    console.log(`   Method limits: mode=${config.methodMode}${formatOverride(config.methodOverride)}, limit=${config.methodLimit}, disableAllowed=${config.methodDisableAllowed}`);
    console.log(`   File limits: mode=${config.fileMode}${formatOverride(config.fileOverride)}, limit=${config.fileLimit}, disableAllowed=${config.fileDisableAllowed}`);
    console.log(`   Require return types: mode=${config.returnTypeMode}, disableAllowed=${config.returnTypeDisableAllowed}`);
    console.log(`   No inline type literals: mode=${config.noInlineTypesMode}, disableAllowed=${config.noInlineTypesDisableAllowed}`);
    console.log(`   No any/unknown: mode=${config.noAnyUnknownMode}, disableAllowed=${config.noAnyUnknownDisableAllowed}`);
    console.log(`   Validate DTOs: mode=${config.validateDtosMode}, disableAllowed=${config.validateDtosDisableAllowed}`);
    console.log(`   Prisma converters: mode=${config.prismaConverterMode}, disableAllowed=${config.prismaConverterDisableAllowed}`);
    console.log(`   No destructure: mode=${config.noDestructureMode}, disableAllowed=${config.noDestructureDisableAllowed}`);
    console.log(`   Catch error pattern: mode=${config.catchErrorPatternMode}, disableAllowed=${config.catchErrorPatternDisableAllowed}`);
    console.log(`   No unmanaged exceptions: mode=${config.noUnmanagedExceptionsMode}, disableAllowed=${config.noUnmanagedExceptionsDisableAllowed}`);
    console.log(`   No direct API in resolver: mode=${config.noDirectApiResolverMode}, disableAllowed=${config.noDirectApiResolverDisableAllowed}`);
    console.log('');
}

function isAllOff(config: ParsedConfig): boolean {
    return config.methodMode === 'OFF' && config.fileMode === 'OFF' &&
        config.returnTypeMode === 'OFF' && config.noInlineTypesMode === 'OFF' &&
        config.noAnyUnknownMode === 'OFF' && config.validateDtosMode === 'OFF' &&
        config.prismaConverterMode === 'OFF' && config.noDestructureMode === 'OFF' &&
        config.catchErrorPatternMode === 'OFF' && config.noUnmanagedExceptionsMode === 'OFF' &&
        config.noDirectApiResolverMode === 'OFF';
}

async function runMethodValidators(config: ParsedConfig, context: ExecutorContext): Promise<ExecutorResult[]> {
    const results: ExecutorResult[] = [];
    const runNew = config.methodMode === 'NEW_METHODS' || config.methodMode === 'NEW_AND_MODIFIED_METHODS';
    const runModified = config.methodMode === 'NEW_AND_MODIFIED_METHODS' || config.methodMode === 'MODIFIED_FILES';

    if (runNew) {
        results.push(await runNewMethodsExecutor({
            limit: config.methodLimit,
            mode: config.methodMode, disableAllowed: config.methodDisableAllowed,
        }, context));
    }
    if (runModified) {
        results.push(await runModifiedMethodsExecutor({
            limit: config.methodLimit, mode: config.methodMode, disableAllowed: config.methodDisableAllowed,
        }, context));
    }
    return results;
}

async function runAllValidators(config: ParsedConfig, context: ExecutorContext): Promise<ExecutorResult[]> {
    const results: ExecutorResult[] = [];
    const methodResults = await runMethodValidators(config, context);
    results.push(...methodResults);
    results.push(await runModifiedFilesExecutor({
        limit: config.fileLimit, mode: config.fileMode, disableAllowed: config.fileDisableAllowed,
    }, context));
    results.push(await runReturnTypesExecutor({
        mode: config.returnTypeMode,
        disableAllowed: config.returnTypeDisableAllowed,
        ignoreModifiedUntilEpoch: config.returnTypeIgnoreEpoch,
    }, context));
    results.push(await runNoInlineTypesExecutor({
        mode: config.noInlineTypesMode,
        disableAllowed: config.noInlineTypesDisableAllowed,
        ignoreModifiedUntilEpoch: config.noInlineTypesIgnoreEpoch,
    }, context));
    results.push(await runNoAnyUnknownExecutor({
        mode: config.noAnyUnknownMode,
        disableAllowed: config.noAnyUnknownDisableAllowed,
        ignoreModifiedUntilEpoch: config.noAnyUnknownIgnoreEpoch,
    }, context));
    results.push(await runValidateDtosExecutor({
        mode: config.validateDtosMode,
        disableAllowed: config.validateDtosDisableAllowed,
        prismaSchemaPath: config.validateDtosPrismaPath,
        dtoSourcePaths: config.validateDtosSrcPaths,
        ignoreModifiedUntilEpoch: config.validateDtosIgnoreEpoch,
    }, context));
    results.push(await runPrismaConvertersExecutor({
        mode: config.prismaConverterMode,
        disableAllowed: config.prismaConverterDisableAllowed,
        schemaPath: config.prismaConverterSchemaPath,
        convertersPaths: config.prismaConverterConvertersPaths,
        enforcePaths: config.prismaConverterEnforcePaths,
        ignoreModifiedUntilEpoch: config.prismaConverterIgnoreEpoch,
    }, context));
    results.push(await runNoDestructureExecutor({
        mode: config.noDestructureMode,
        disableAllowed: config.noDestructureDisableAllowed,
        ignoreModifiedUntilEpoch: config.noDestructureIgnoreEpoch,
    }, context));
    results.push(await runCatchErrorPatternExecutor({
        mode: config.catchErrorPatternMode,
        disableAllowed: config.catchErrorPatternDisableAllowed,
        ignoreModifiedUntilEpoch: config.catchErrorPatternIgnoreEpoch,
    }, context));
    results.push(await runNoUnmanagedExceptionsExecutor({
        mode: config.noUnmanagedExceptionsMode,
        disableAllowed: config.noUnmanagedExceptionsDisableAllowed,
        ignoreModifiedUntilEpoch: config.noUnmanagedExceptionsIgnoreEpoch,
    }, context));
    results.push(await runNoDirectApiResolverExecutor({
        mode: config.noDirectApiResolverMode,
        disableAllowed: config.noDirectApiResolverDisableAllowed,
        ignoreModifiedUntilEpoch: config.noDirectApiResolverIgnoreEpoch,
        enforcePaths: config.noDirectApiResolverEnforcePaths,
    }, context));
    return results;
}

export default async function runExecutor(
    options: ValidateCodeOptions,
    context: ExecutorContext
): Promise<ExecutorResult> {
    const modeErrors = validateModes(options);
    if (modeErrors.length > 0) {
        console.error('');
        for (const err of modeErrors) {
            console.error(`❌ ${err}`);
        }
        console.error('');
        return { success: false };
    }

    const config = parseConfig(options);

    if (isAllOff(config)) {
        console.log('\n\u23ed\ufe0f  Skipping all code validations (all modes: OFF)\n');
        return { success: true };
    }

    logConfig(config);

    const results = await runAllValidators(config, context);
    const allSuccess = results.every((r) => r.success);

    console.log(allSuccess ? '\n\u2705 All code validations passed\n' : '\n\u274c Some code validations failed\n');
    return { success: allSuccess };
}
