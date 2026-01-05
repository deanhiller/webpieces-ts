import { ExecutorContext } from '@nx/devkit';
import runNewMethodsExecutor from '../validate-new-methods/executor';
import runModifiedMethodsExecutor from '../validate-modified-methods/executor';
import runModifiedFilesExecutor from '../validate-modified-files/executor';

export type ValidationMode = 'STRICT' | 'NORMAL' | 'OFF';

export interface ValidateCodeOptions {
    mode?: ValidationMode;
    newMethodsMaxLines?: number;
    modifiedMethodsMaxLines?: number;
    modifiedFilesMaxLines?: number;
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

    console.log('\n📏 Running Code Validations\n');
    console.log(`   Validation mode: ${mode}${mode === 'STRICT' ? ' (disable comments ignored for modified code)' : ''}`);
    console.log(`   New methods max: ${options.newMethodsMaxLines ?? 30} lines`);
    console.log(`   Modified methods max: ${options.modifiedMethodsMaxLines ?? 80} lines`);
    console.log(`   Modified files max: ${options.modifiedFilesMaxLines ?? 900} lines`);
    console.log('');

    // Run all three validators sequentially to avoid interleaved output
    const newMethodsResult = await runNewMethodsExecutor(
        { max: options.newMethodsMaxLines ?? 30, mode },
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

    const allSuccess = newMethodsResult.success && modifiedMethodsResult.success && modifiedFilesResult.success;

    if (allSuccess) {
        console.log('\n✅ All code validations passed\n');
    } else {
        console.log('\n❌ Some code validations failed\n');
    }

    return { success: allSuccess };
}
