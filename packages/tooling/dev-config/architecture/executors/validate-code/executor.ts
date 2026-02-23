import { ExecutorContext } from '@nx/devkit';
import runNewMethodsExecutor from '../validate-new-methods/executor';
import runModifiedMethodsExecutor from '../validate-modified-methods/executor';
import runModifiedFilesExecutor from '../validate-modified-files/executor';
import runReturnTypesExecutor, { ReturnTypeMode } from '../validate-return-types/executor';
import runNoInlineTypesExecutor, { NoInlineTypesMode } from '../validate-no-inline-types/executor';
import runNoAnyUnknownExecutor, { NoAnyUnknownMode } from '../validate-no-any-unknown/executor';
import runValidateDtosExecutor, { ValidateDtosMode } from '../validate-dtos/executor';

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

export interface ValidateDtosConfig {
    mode?: ValidateDtosMode;
    prismaSchemaPath?: string;
    dtoSourcePaths?: string[];
}

export interface ValidateCodeOptions {
    methodMaxLimit?: MethodMaxLimitConfig;
    fileMaxLimit?: FileMaxLimitConfig;
    requireReturnTypeMode?: ReturnTypeMode;
    noInlineTypeLiteralsMode?: NoInlineTypesMode;
    noAnyUnknownMode?: NoAnyUnknownMode;
    validateDtos?: ValidateDtosConfig;
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
    noInlineTypesMode: NoInlineTypesMode;
    noAnyUnknownMode: NoAnyUnknownMode;
    validateDtosMode: ValidateDtosMode;
    validateDtosPrismaPath: string | undefined;
    validateDtosSrcPaths: string[];
}

interface ResolvedMethodMode {
    mode: MethodMaxLimitMode;
    override: OverrideInfo | undefined;
}

interface ResolvedFileMode {
    mode: FileMaxLimitMode;
    override: OverrideInfo | undefined;
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
    console.log(`\n\u26a0\ufe0f  methodMaxLimit.ignoreModifiedUntilEpoch (${epoch}) has expired (${formatEpochDate(epoch)}). Remove it from nx.json. Using normal mode: ${normalMode}\n`);
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
    console.log(`\n\u26a0\ufe0f  fileMaxLimit.ignoreModifiedUntilEpoch (${epoch}) has expired (${formatEpochDate(epoch)}). Remove it from nx.json. Using normal mode: ${normalMode}\n`);
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
        returnTypeMode: options.requireReturnTypeMode ?? 'OFF',
        noInlineTypesMode: options.noInlineTypeLiteralsMode ?? 'OFF',
        noAnyUnknownMode: options.noAnyUnknownMode ?? 'OFF',
        validateDtosMode: options.validateDtos?.mode ?? 'OFF',
        validateDtosPrismaPath: options.validateDtos?.prismaSchemaPath,
        validateDtosSrcPaths: options.validateDtos?.dtoSourcePaths ?? [],
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
    console.log(`   Require return types: ${config.returnTypeMode}`);
    console.log(`   No inline type literals: ${config.noInlineTypesMode}`);
    console.log(`   No any/unknown: ${config.noAnyUnknownMode}`);
    console.log(`   Validate DTOs: ${config.validateDtosMode}`);
    console.log('');
}

function isAllOff(config: ParsedConfig): boolean {
    return config.methodMode === 'OFF' && config.fileMode === 'OFF' &&
        config.returnTypeMode === 'OFF' && config.noInlineTypesMode === 'OFF' &&
        config.noAnyUnknownMode === 'OFF' && config.validateDtosMode === 'OFF';
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

export default async function runExecutor(
    options: ValidateCodeOptions,
    context: ExecutorContext
): Promise<ExecutorResult> {
    const config = parseConfig(options);

    if (isAllOff(config)) {
        console.log('\n\u23ed\ufe0f  Skipping all code validations (all modes: OFF)\n');
        return { success: true };
    }

    logConfig(config);

    const methodResults = await runMethodValidators(config, context);
    const fileResult = await runModifiedFilesExecutor({
        limit: config.fileLimit, mode: config.fileMode, disableAllowed: config.fileDisableAllowed,
    }, context);
    const returnTypesResult = await runReturnTypesExecutor({ mode: config.returnTypeMode }, context);
    const noInlineTypesResult = await runNoInlineTypesExecutor({ mode: config.noInlineTypesMode }, context);
    const noAnyUnknownResult = await runNoAnyUnknownExecutor({ mode: config.noAnyUnknownMode }, context);
    const validateDtosResult = await runValidateDtosExecutor({
        mode: config.validateDtosMode,
        prismaSchemaPath: config.validateDtosPrismaPath,
        dtoSourcePaths: config.validateDtosSrcPaths,
    }, context);

    const allSuccess = methodResults.every((r) => r.success) &&
        fileResult.success && returnTypesResult.success &&
        noInlineTypesResult.success && noAnyUnknownResult.success &&
        validateDtosResult.success;

    console.log(allSuccess ? '\n\u2705 All code validations passed\n' : '\n\u274c Some code validations failed\n');
    return { success: allSuccess };
}
