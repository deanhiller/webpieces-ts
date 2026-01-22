import { ExecutorContext } from '@nx/devkit';
import runNewMethodsExecutor from '../validate-new-methods/executor';
import runModifiedMethodsExecutor from '../validate-modified-methods/executor';
import runModifiedFilesExecutor from '../validate-modified-files/executor';
import runReturnTypesExecutor, { ReturnTypeMode } from '../validate-return-types/executor';
import runNoInlineTypesExecutor, { NoInlineTypesMode } from '../validate-no-inline-types/executor';
import runNoAnyUnknownExecutor, { NoAnyUnknownMode } from '../validate-no-any-unknown/executor';

export type ValidationMode = 'STRICT' | 'NORMAL' | 'OFF';

export interface ValidateCodeOptions {
    mode?: ValidationMode;
    newMethodsMaxLines?: number;
    strictNewMethodMaxLines?: number;
    modifiedMethodsMaxLines?: number;
    modifiedFilesMaxLines?: number;
    requireReturnTypeMode?: ReturnTypeMode;
    noInlineTypeLiteralsMode?: NoInlineTypesMode;
    noAnyUnknownMode?: NoAnyUnknownMode;
}

export interface ExecutorResult {
    success: boolean;
}

export default async function runExecutor(
    options: ValidateCodeOptions,
    context: ExecutorContext
): Promise<ExecutorResult> {
    const mode: ValidationMode = options.mode ?? 'NORMAL';

    if (mode === 'OFF') {
        console.log('\n⏭️  Skipping all code validations (validationMode: OFF)\n');
        return { success: true };
    }

    const returnTypeMode: ReturnTypeMode = options.requireReturnTypeMode ?? 'OFF';
    const noInlineTypesMode: NoInlineTypesMode = options.noInlineTypeLiteralsMode ?? 'OFF';
    const noAnyUnknownMode: NoAnyUnknownMode = options.noAnyUnknownMode ?? 'OFF';

    console.log('\n📏 Running Code Validations\n');
    console.log(`   Validation mode: ${mode}${mode === 'STRICT' ? ' (disable comments ignored for modified code)' : ''}`);
    console.log(`   New methods max: ${options.newMethodsMaxLines ?? 30} lines (soft limit)`);
    if (options.strictNewMethodMaxLines) {
        console.log(`   New methods max: ${options.strictNewMethodMaxLines} lines (hard limit, no escape)`);
    }
    console.log(`   Modified methods max: ${options.modifiedMethodsMaxLines ?? 80} lines`);
    console.log(`   Modified files max: ${options.modifiedFilesMaxLines ?? 900} lines`);
    console.log(`   Require return types: ${returnTypeMode}`);
    console.log(`   No inline type literals: ${noInlineTypesMode}`);
    console.log(`   No any/unknown: ${noAnyUnknownMode}`);
    console.log('');

    // Run all three validators sequentially to avoid interleaved output
    const newMethodsResult = await runNewMethodsExecutor(
        { max: options.newMethodsMaxLines ?? 30, strictMax: options.strictNewMethodMaxLines, mode },
        context
    );

    const modifiedMethodsResult = await runModifiedMethodsExecutor(
        { max: options.modifiedMethodsMaxLines ?? 80, mode },
        context
    );

    const modifiedFilesResult = await runModifiedFilesExecutor(
        { max: options.modifiedFilesMaxLines ?? 900, mode },
        context
    );

    const returnTypesResult = await runReturnTypesExecutor({ mode: returnTypeMode }, context);

    const noInlineTypesResult = await runNoInlineTypesExecutor({ mode: noInlineTypesMode }, context);

    const noAnyUnknownResult = await runNoAnyUnknownExecutor({ mode: noAnyUnknownMode }, context);

    const allSuccess =
        newMethodsResult.success &&
        modifiedMethodsResult.success &&
        modifiedFilesResult.success &&
        returnTypesResult.success &&
        noInlineTypesResult.success &&
        noAnyUnknownResult.success;

    if (allSuccess) {
        console.log('\n✅ All code validations passed\n');
    } else {
        console.log('\n❌ Some code validations failed\n');
    }

    return { success: allSuccess };
}
