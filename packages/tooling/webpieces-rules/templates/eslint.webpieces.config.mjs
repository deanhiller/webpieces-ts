// @webpieces/dev-config ESLint Configuration
// This is the canonical template for external clients
//
// IMPORTANT: When modifying rules here, also update:
// - /eslint.webpieces.config.mjs (webpieces workspace version with loadWorkspaceRules)
//
// Base rules only — no Angular dependencies.
// For Angular projects, also use eslint.webpieces-angular.config.mjs

import webpiecesPlugin from '@webpieces/eslint-rules';

export default [
    {
        ignores: ['**/dist', '**/node_modules', '**/coverage', '**/.nx', '**/generated'],
    },
    {
        files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
        plugins: {
            '@webpieces': webpiecesPlugin,
        },
        rules: {
            '@webpieces/catch-error-pattern': 'error',
            // READ .webpieces/instruct-ai/webpieces.exceptions.md for AI rollout instructions and rationale
            '@webpieces/no-unmanaged-exceptions': 'error',
            '@webpieces/max-method-lines': ['error', { max: 150 }],
            '@webpieces/max-file-lines': ['error', { max: 901 }],
            '@webpieces/enforce-architecture': 'error',
            '@webpieces/no-json-property-primitive-type': 'error',
        },
    },
];
