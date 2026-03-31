/**
 * ESLint plugin for WebPieces
 * Provides rules for enforcing WebPieces code patterns
 *
 * This plugin is automatically included in @webpieces/dev-config
 *
 * Available rules:
 * - catch-error-pattern: Enforce toError() usage in catch blocks (HOW to handle)
 * - no-unmanaged-exceptions: Discourage try-catch outside tests (WHERE to handle)
 * - max-method-lines: Enforce maximum method length (default: 70 lines)
 * - max-file-lines: Enforce maximum file length (default: 700 lines)
 * - enforce-architecture: Enforce architecture dependency boundaries
 */

import catchErrorPattern from './rules/catch-error-pattern';
import noUnmanagedExceptions from './rules/no-unmanaged-exceptions';
import maxMethodLines from './rules/max-method-lines';
import maxFileLines from './rules/max-file-lines';
import enforceArchitecture from './rules/enforce-architecture';

export = {
    rules: {
        'catch-error-pattern': catchErrorPattern,
        'no-unmanaged-exceptions': noUnmanagedExceptions,
        'max-method-lines': maxMethodLines,
        'max-file-lines': maxFileLines,
        'enforce-architecture': enforceArchitecture,
    },
};
