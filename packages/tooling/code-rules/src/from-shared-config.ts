/**
 * Adapter: map @webpieces/rules-config ResolvedConfig -> legacy ValidateCodeOptions.
 *
 * We don't want to rewrite the 11 sub-executors in this PR, so this file
 * takes the shared webpieces.config.json entries (kebab-case rule names)
 * and reconstructs the camelCase ValidateCodeOptions shape the executor
 * already understands.
 *
 * Mapping of canonical kebab-case rule name -> ValidateCodeOptions field:
 *   max-method-lines         -> methodMaxLimit
 *   max-file-lines           -> fileMaxLimit
 *   require-return-type      -> requireReturnType
 *   no-inline-type-literals  -> noInlineTypeLiterals
 *   no-any-unknown           -> noAnyUnknown
 *   no-implicit-any          -> noImplicitAny
 *   prisma-validate-dtos      -> validateDtos
 *   prisma-converter          -> prismaConverter
 *   no-destructure            -> noDestructure
 *   catch-error-pattern       -> catchErrorPattern
 *   no-unmanaged-exceptions   -> noUnmanagedExceptions
 *   angular-no-direct-api-in-resolver -> noDirectApiInResolver
 *
 * On/off is driven entirely by `mode`: a `mode:'OFF'` entry flows straight
 * through to the downstream executor, which short-circuits on it.
 */

import type { ResolvedConfig, ResolvedRuleConfig } from '@webpieces/rules-config';
import type { ValidateCodeOptions } from './validate-code-options';

// webpieces-disable no-any-unknown -- coerces opaque option values pulled from JSON
function opt<T>(rule: ResolvedRuleConfig | undefined, key: string): T | undefined {
    if (!rule) return undefined;
    const value = rule.options[key];
    if (value === undefined) return undefined;
    return value as T;
}

function modeOrOff<T extends string>(rule: ResolvedRuleConfig | undefined): T | undefined {
    if (!rule) return undefined;
    const mode = rule.options['mode'];
    return (mode as T) ?? undefined;
}

interface SkipOpts {
    disableAllowed: boolean | undefined;
    ignoreModifiedUntilEpoch: number | undefined;
    ignoreRuleWhileOnBranch: string | undefined;
}

function skipOpts(rule: ResolvedRuleConfig | undefined): SkipOpts {
    return {
        disableAllowed: opt<boolean>(rule, 'disableAllowed'),
        ignoreModifiedUntilEpoch: opt<number>(rule, 'ignoreModifiedUntilEpoch'),
        ignoreRuleWhileOnBranch: opt<string>(rule, 'ignoreRuleWhileOnBranch'),
    };
}

export function toValidateCodeOptions(shared: ResolvedConfig): ValidateCodeOptions {
    const r = (name: string): ResolvedRuleConfig | undefined => shared.rules.get(name);

    return {
        methodMaxLimit: { mode: modeOrOff(r('max-method-lines')), ...skipOpts(r('max-method-lines')), limit: opt<number>(r('max-method-lines'), 'limit') },
        fileMaxLimit: { mode: modeOrOff(r('max-file-lines')), ...skipOpts(r('max-file-lines')), limit: opt<number>(r('max-file-lines'), 'limit') },
        requireReturnType: { mode: modeOrOff(r('require-return-type')), ...skipOpts(r('require-return-type')) },
        noInlineTypeLiterals: { mode: modeOrOff(r('no-inline-type-literals')), ...skipOpts(r('no-inline-type-literals')) },
        noAnyUnknown: { mode: modeOrOff(r('no-any-unknown')), ...skipOpts(r('no-any-unknown')) },
        noImplicitAny: { mode: modeOrOff(r('no-implicit-any')), ...skipOpts(r('no-implicit-any')) },
        validateDtos: {
            mode: modeOrOff(r('prisma-validate-dtos')), ...skipOpts(r('prisma-validate-dtos')),
            prismaSchemaPath: opt<string>(r('prisma-validate-dtos'), 'prismaSchemaPath'),
            dtoSourcePaths: opt<string[]>(r('prisma-validate-dtos'), 'dtoSourcePaths'),
        },
        prismaConverter: {
            mode: modeOrOff(r('prisma-converter')), ...skipOpts(r('prisma-converter')),
            schemaPath: opt<string>(r('prisma-converter'), 'schemaPath'),
            convertersPaths: opt<string[]>(r('prisma-converter'), 'convertersPaths'),
            enforcePaths: opt<string[]>(r('prisma-converter'), 'enforcePaths'),
        },
        noDestructure: { mode: modeOrOff(r('no-destructure')), ...skipOpts(r('no-destructure')) },
        catchErrorPattern: { mode: modeOrOff(r('catch-error-pattern')), ...skipOpts(r('catch-error-pattern')) },
        noUnmanagedExceptions: { mode: modeOrOff(r('no-unmanaged-exceptions')), ...skipOpts(r('no-unmanaged-exceptions')) },
        noDirectApiInResolver: {
            mode: modeOrOff(r('angular-no-direct-api-in-resolver')), ...skipOpts(r('angular-no-direct-api-in-resolver')),
            enforcePaths: opt<string[]>(r('angular-no-direct-api-in-resolver'), 'enforcePaths'),
        },
        noSymbolDiTokens: {
            mode: modeOrOff(r('no-symbol-di-tokens')), ...skipOpts(r('no-symbol-di-tokens')),
            allowedPaths: opt<string[]>(r('no-symbol-di-tokens'), 'allowedPaths'),
        },
    };
}
