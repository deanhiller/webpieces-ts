// @webpieces/dev-config ESLint Configuration
// This is the canonical template for external clients
//
// IMPORTANT: When modifying rules here, also update:
// - /eslint.webpieces.config.mjs (webpieces workspace version with loadWorkspaceRules)
//
// Only includes @webpieces custom rules
// Configure your own TypeScript and general rules in your main eslint.config.mjs as needed

import webpiecesPlugin from '@webpieces/dev-config/eslint-plugin';

export default [
    {
        ignores: ['**/dist', '**/node_modules', '**/coverage', '**/.nx'],
    },
    {
        files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
        plugins: {
            '@webpieces': webpiecesPlugin,
        },
        rules: {
            '@webpieces/catch-error-pattern': 'error',
            '@webpieces/no-unmanaged-exceptions': 'error',
            // '@webpieces/max-method-lines': ['error', { max: 70 }],
            // '@webpieces/max-file-lines': ['error', { max: 700 }],
            '@webpieces/enforce-architecture': 'error',
        },
    },
];
