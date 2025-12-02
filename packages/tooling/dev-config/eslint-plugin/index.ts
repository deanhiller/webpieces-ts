/**
 * ESLint plugin for WebPieces
 * Provides rules for enforcing WebPieces code patterns
 *
 * This plugin is automatically included in @webpieces/dev-config
 */

import catchErrorPattern from './rules/catch-error-pattern';

export = {
    rules: {
        'catch-error-pattern': catchErrorPattern,
    },
};
