/**
 * ESLint plugin for WebPieces
 * Provides rules for enforcing WebPieces code patterns
 *
 * This plugin is automatically included in @webpieces/dev-config
 *
 * Available rules:
 * - catch-error-pattern: Enforce toError() usage in catch blocks
 * - max-method-lines: Enforce maximum method length (default: 70 lines)
 * - max-file-lines: Enforce maximum file length (default: 700 lines)
 * - enforce-architecture: Enforce architecture dependency boundaries
 */

import catchErrorPattern from './rules/catch-error-pattern';
import maxMethodLines from './rules/max-method-lines';
import maxFileLines from './rules/max-file-lines';
import enforceArchitecture from './rules/enforce-architecture';

export = {
    rules: {
        'catch-error-pattern': catchErrorPattern,
        'max-method-lines': maxMethodLines,
        'max-file-lines': maxFileLines,
        'enforce-architecture': enforceArchitecture,
    },
};
