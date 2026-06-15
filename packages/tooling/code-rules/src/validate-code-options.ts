/**
 * ValidateCodeOptions and its sub-config types.
 *
 * This is a leaf module: it owns the option/config shape shared by `validate-code.ts`
 * (which consumes the options) and `from-shared-config.ts` (which produces them). Keeping
 * the type here breaks the otherwise-circular import between those two files — a type that
 * two modules share must not live inside one of them.
 *
 * It imports only the per-rule `*Mode` unions from the individual rule executors (leaves),
 * and re-exports them so consumers have a single import site.
 */

import type { ReturnTypeMode } from './validate-return-types';
import type { NoInlineTypesMode } from './validate-no-inline-types';
import type { NoAnyUnknownMode } from './validate-no-any-unknown';
import type { NoImplicitAnyMode } from './validate-no-implicit-any';
import type { ValidateDtosMode } from './validate-dtos';
import type { PrismaConverterMode } from './validate-prisma-converters';
import type { NoDestructureMode } from './validate-no-destructure';
import type { CatchErrorPatternMode } from './validate-catch-error-pattern';
import type { NoUnmanagedExceptionsMode } from './validate-no-unmanaged-exceptions';
import type { NoDirectApiResolverMode } from './validate-no-direct-api-resolver';
import type { NoSymbolDiTokensMode } from './validate-no-symbol-di-tokens';

export type {
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
};

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

export interface NoImplicitAnyConfig {
    mode?: NoImplicitAnyMode;
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

export interface NoSymbolDiTokensConfig {
    mode?: NoSymbolDiTokensMode;
    disableAllowed?: boolean;
    ignoreModifiedUntilEpoch?: number;
    allowedPaths?: string[];
}

export interface ValidateCodeOptions {
    methodMaxLimit?: MethodMaxLimitConfig;
    fileMaxLimit?: FileMaxLimitConfig;
    requireReturnType?: RequireReturnTypeConfig;
    noInlineTypeLiterals?: NoInlineTypeLiteralsConfig;
    noAnyUnknown?: NoAnyUnknownConfig;
    noImplicitAny?: NoImplicitAnyConfig;
    validateDtos?: ValidateDtosConfig;
    prismaConverter?: PrismaConverterConfig;
    noDestructure?: NoDestructureConfig;
    catchErrorPattern?: CatchErrorPatternConfig;
    noUnmanagedExceptions?: NoUnmanagedExceptionsConfig;
    noDirectApiInResolver?: NoDirectApiResolverConfig;
    noSymbolDiTokens?: NoSymbolDiTokensConfig;
}
