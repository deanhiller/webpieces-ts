/**
 * ESLint plugin for WebPieces
 * Provides rules for enforcing WebPieces code patterns
 *
 * This plugin is automatically included in @webpieces/dev-config
 */

import catchErrorPattern from './rules/catch-error-pattern';
import maxMethodLines from './rules/max-method-lines';
import maxFileLines from './rules/max-file-lines';

export = {
    rules: {
        'catch-error-pattern': catchErrorPattern,
        'max-method-lines': maxMethodLines,
        'max-file-lines': maxFileLines,
    },
};
