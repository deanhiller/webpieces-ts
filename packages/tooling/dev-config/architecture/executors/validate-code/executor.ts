import { ExecutorContext } from '@nx/devkit';
import runNewMethodsExecutor from '../validate-new-methods/executor';
import runModifiedMethodsExecutor from '../validate-modified-methods/executor';
import runModifiedFilesExecutor from '../validate-modified-files/executor';
import runReturnTypesExecutor, { ReturnTypeMode } from '../validate-return-types/executor';
import runNoInlineTypesExecutor, { NoInlineTypesMode } from '../validate-no-inline-types/executor';
import runNoAnyUnknownExecutor, { NoAnyUnknownMode } from '../validate-no-any-unknown/executor';

export type MethodMaxLimitMode = 'OFF' | 'NEW_METHODS' | 'NEW_AND_MODIFIED_METHODS' | 'MODIFIED_FILES';
export type FileMaxLimitMode = 'OFF' | 'MODIFIED_FILES';

export interface MethodMaxLimitConfig {
    limit?: number;
    mode?: MethodMaxLimitMode;
    disableAllowed?: boolean;
}

export interface FileMaxLimitConfig {
    limit?: number;
    mode?: FileMaxLimitMode;
    disableAllowed?: boolean;
}

export interface ValidateCodeOptions {
    methodMaxLimit?: MethodMaxLimitConfig;
    fileMaxLimit?: FileMaxLimitConfig;
    requireReturnTypeMode?: ReturnTypeMode;
    noInlineTypeLiteralsMode?: NoInlineTypesMode;
    noAnyUnknownMode?: NoAnyUnknownMode;
}

export interface ExecutorResult {
    success: boolean;
}

interface ParsedConfig {
    methodLimit: number;
    methodMode: MethodMaxLimitMode;
    methodDisableAllowed: boolean;
    fileLimit: number;
    fileMode: FileMaxLimitMode;
    fileDisableAllowed: boolean;
    returnTypeMode: ReturnTypeMode;
    noInlineTypesMode: NoInlineTypesMode;
    noAnyUnknownMode: NoAnyUnknownMode;
}

function parseConfig(options: ValidateCodeOptions): ParsedConfig {
    const methodConfig: MethodMaxLimitConfig = options.methodMaxLimit ?? {};
    const fileConfig: FileMaxLimitConfig = options.fileMaxLimit ?? {};

    return {
        methodLimit: methodConfig.limit ?? 80,
        methodMode: methodConfig.mode ?? 'NEW_AND_MODIFIED_METHODS',
        methodDisableAllowed: methodConfig.disableAllowed ?? true,
        fileLimit: fileConfig.limit ?? 900,
        fileMode: fileConfig.mode ?? 'MODIFIED_FILES',
        fileDisableAllowed: fileConfig.disableAllowed ?? true,
        returnTypeMode: options.requireReturnTypeMode ?? 'OFF',
        noInlineTypesMode: options.noInlineTypeLiteralsMode ?? 'OFF',
        noAnyUnknownMode: options.noAnyUnknownMode ?? 'OFF',
    };
}

function logConfig(config: ParsedConfig): void {
    console.log('\n\ud83d\udccf Running Code Validations\n');
    console.log(`   Method limits: mode=${config.methodMode}, limit=${config.methodLimit}, disableAllowed=${config.methodDisableAllowed}`);
    console.log(`   File limits: mode=${config.fileMode}, limit=${config.fileLimit}, disableAllowed=${config.fileDisableAllowed}`);
    console.log(`   Require return types: ${config.returnTypeMode}`);
    console.log(`   No inline type literals: ${config.noInlineTypesMode}`);
    console.log(`   No any/unknown: ${config.noAnyUnknownMode}`);
    console.log('');
}

function isAllOff(config: ParsedConfig): boolean {
    return config.methodMode === 'OFF' && config.fileMode === 'OFF' &&
        config.returnTypeMode === 'OFF' && config.noInlineTypesMode === 'OFF' &&
        config.noAnyUnknownMode === 'OFF';
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

    const allSuccess = methodResults.every((r) => r.success) &&
        fileResult.success && returnTypesResult.success &&
        noInlineTypesResult.success && noAnyUnknownResult.success;

    console.log(allSuccess ? '\n\u2705 All code validations passed\n' : '\n\u274c Some code validations failed\n');
    return { success: allSuccess };
}
