/**
 * Adapter: map @webpieces/config ResolvedConfig → legacy ValidateCodeOptions.
 *
 * We don't want to rewrite the 11 sub-executors in this PR, so this file
 * takes the shared webpieces.config.json entries (kebab-case rule names)
 * and reconstructs the camelCase ValidateCodeOptions shape the executor
 * already understands.
 *
 * Mapping of canonical kebab-case rule name → ValidateCodeOptions field:
 *   max-method-lines         → methodMaxLimit
 *   max-file-lines           → fileMaxLimit
 *   require-return-type      → requireReturnType
 *   no-inline-type-literals  → noInlineTypeLiterals
 *   no-any-unknown           → noAnyUnknown
 *   no-implicit-any          → noImplicitAny
 *   validate-dtos            → validateDtos
 *   prisma-converter         → prismaConverter
 *   no-destructure           → noDestructure
 *   catch-error-pattern      → catchErrorPattern
 *   no-unmanaged-exceptions  → noUnmanagedExceptions
 *   no-direct-api-in-resolver → noDirectApiInResolver
 *
 * A rule entry with enabled:false is surfaced as mode:'OFF' so the
 * downstream executor short-circuits the same way it did before.
 */

import type { ResolvedConfig, ResolvedRuleConfig } from '@webpieces/config';
import type { ValidateCodeOptions } from './executor';

// webpieces-disable no-any-unknown -- coerces opaque option values pulled from JSON
function opt<T>(rule: ResolvedRuleConfig | undefined, key: string): T | undefined {
    if (!rule) return undefined;
    const value = rule.options[key];
    if (value === undefined) return undefined;
    return value as T;
}

function modeOrOff<T extends string>(rule: ResolvedRuleConfig | undefined): T | undefined {
    if (!rule) return undefined;
    if (rule.enabled === false) return 'OFF' as T;
    const mode = rule.options['mode'];
    return (mode as T) ?? undefined;
}

export function toValidateCodeOptions(shared: ResolvedConfig): ValidateCodeOptions {
    const r = (name: string): ResolvedRuleConfig | undefined => shared.rules.get(name);

    return {
        methodMaxLimit: {
            limit: opt<number>(r('max-method-lines'), 'limit'),
            mode: modeOrOff(r('max-method-lines')),
            disableAllowed: opt<boolean>(r('max-method-lines'), 'disableAllowed'),
            ignoreModifiedUntilEpoch: opt<number>(r('max-method-lines'), 'ignoreModifiedUntilEpoch'),
        },
        fileMaxLimit: {
            limit: opt<number>(r('max-file-lines'), 'limit'),
            mode: modeOrOff(r('max-file-lines')),
            disableAllowed: opt<boolean>(r('max-file-lines'), 'disableAllowed'),
            ignoreModifiedUntilEpoch: opt<number>(r('max-file-lines'), 'ignoreModifiedUntilEpoch'),
        },
        requireReturnType: {
            mode: modeOrOff(r('require-return-type')),
            disableAllowed: opt<boolean>(r('require-return-type'), 'disableAllowed'),
            ignoreModifiedUntilEpoch: opt<number>(r('require-return-type'), 'ignoreModifiedUntilEpoch'),
        },
        noInlineTypeLiterals: {
            mode: modeOrOff(r('no-inline-type-literals')),
            disableAllowed: opt<boolean>(r('no-inline-type-literals'), 'disableAllowed'),
            ignoreModifiedUntilEpoch: opt<number>(r('no-inline-type-literals'), 'ignoreModifiedUntilEpoch'),
        },
        noAnyUnknown: {
            mode: modeOrOff(r('no-any-unknown')),
            disableAllowed: opt<boolean>(r('no-any-unknown'), 'disableAllowed'),
            ignoreModifiedUntilEpoch: opt<number>(r('no-any-unknown'), 'ignoreModifiedUntilEpoch'),
        },
        noImplicitAny: {
            mode: modeOrOff(r('no-implicit-any')),
            disableAllowed: opt<boolean>(r('no-implicit-any'), 'disableAllowed'),
            ignoreModifiedUntilEpoch: opt<number>(r('no-implicit-any'), 'ignoreModifiedUntilEpoch'),
        },
        validateDtos: {
            mode: modeOrOff(r('validate-dtos')),
            disableAllowed: opt<boolean>(r('validate-dtos'), 'disableAllowed'),
            prismaSchemaPath: opt<string>(r('validate-dtos'), 'prismaSchemaPath'),
            dtoSourcePaths: opt<string[]>(r('validate-dtos'), 'dtoSourcePaths'),
            ignoreModifiedUntilEpoch: opt<number>(r('validate-dtos'), 'ignoreModifiedUntilEpoch'),
        },
        prismaConverter: {
            mode: modeOrOff(r('prisma-converter')),
            disableAllowed: opt<boolean>(r('prisma-converter'), 'disableAllowed'),
            schemaPath: opt<string>(r('prisma-converter'), 'schemaPath'),
            convertersPaths: opt<string[]>(r('prisma-converter'), 'convertersPaths'),
            enforcePaths: opt<string[]>(r('prisma-converter'), 'enforcePaths'),
            ignoreModifiedUntilEpoch: opt<number>(r('prisma-converter'), 'ignoreModifiedUntilEpoch'),
        },
        noDestructure: {
            mode: modeOrOff(r('no-destructure')),
            disableAllowed: opt<boolean>(r('no-destructure'), 'disableAllowed'),
            ignoreModifiedUntilEpoch: opt<number>(r('no-destructure'), 'ignoreModifiedUntilEpoch'),
        },
        catchErrorPattern: {
            mode: modeOrOff(r('catch-error-pattern')),
            disableAllowed: opt<boolean>(r('catch-error-pattern'), 'disableAllowed'),
            ignoreModifiedUntilEpoch: opt<number>(r('catch-error-pattern'), 'ignoreModifiedUntilEpoch'),
        },
        noUnmanagedExceptions: {
            mode: modeOrOff(r('no-unmanaged-exceptions')),
            disableAllowed: opt<boolean>(r('no-unmanaged-exceptions'), 'disableAllowed'),
            ignoreModifiedUntilEpoch: opt<number>(r('no-unmanaged-exceptions'), 'ignoreModifiedUntilEpoch'),
        },
        noDirectApiInResolver: {
            mode: modeOrOff(r('no-direct-api-in-resolver')),
            disableAllowed: opt<boolean>(r('no-direct-api-in-resolver'), 'disableAllowed'),
            ignoreModifiedUntilEpoch: opt<number>(r('no-direct-api-in-resolver'), 'ignoreModifiedUntilEpoch'),
            enforcePaths: opt<string[]>(r('no-direct-api-in-resolver'), 'enforcePaths'),
        },
    };
}
