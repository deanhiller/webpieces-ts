/**
 * Adapter: map WebpiecesRulesConfig -> ValidateCodeOptions.
 *
 * Direct field access — no opaque option-bag extraction. The per-rule config
 * classes in @webpieces/rules-config are structurally compatible with the
 * *Config interfaces in validate-code-options.ts (same field names/types),
 * so TypeScript verifies the assignment at compile time.
 *
 * Mapping of webpieces.config.json key -> ValidateCodeOptions field:
 *   max-method-lines              -> methodMaxLimit
 *   max-file-lines                -> fileMaxLimit
 *   require-return-type           -> requireReturnType
 *   no-inline-type-literals       -> noInlineTypeLiterals
 *   no-any-unknown                -> noAnyUnknown
 *   no-implicit-any               -> noImplicitAny
 *   prisma-validate-dtos          -> validateDtos
 *   prisma-converter              -> prismaConverter
 *   no-destructure                -> noDestructure
 *   catch-error-pattern           -> catchErrorPattern
 *   no-unmanaged-exceptions       -> noUnmanagedExceptions
 *   angular-no-direct-api-in-resolver -> noDirectApiInResolver
 *   no-symbol-di-tokens           -> noSymbolDiTokens
 */

import type { WebpiecesRulesConfig } from '@webpieces/rules-config';
import type { ValidateCodeOptions } from './validate-code-options';

export function toValidateCodeOptions(config: WebpiecesRulesConfig): ValidateCodeOptions {
    return {
        methodMaxLimit: config['max-method-lines'],
        fileMaxLimit: config['max-file-lines'],
        requireReturnType: config['require-return-type'],
        noInlineTypeLiterals: config['no-inline-type-literals'],
        noAnyUnknown: config['no-any-unknown'],
        noImplicitAny: config['no-implicit-any'],
        validateDtos: config['prisma-validate-dtos'],
        prismaConverter: config['prisma-converter'],
        noDestructure: config['no-destructure'],
        catchErrorPattern: config['catch-error-pattern'],
        noUnmanagedExceptions: config['no-unmanaged-exceptions'],
        noDirectApiInResolver: config['angular-no-direct-api-in-resolver'],
        noSymbolDiTokens: config['no-symbol-di-tokens'],
    };
}
