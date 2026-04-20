// @webpieces/nx-webpieces-rules ESLint Configuration for webpieces-ts workspace
//
// IMPORTANT: This file must stay in sync with:
// - packages/tooling/nx-webpieces-rules/templates/eslint.webpieces.config.mjs (canonical template for clients)
//
// Base rules only — no Angular dependencies.
// For Angular rules see eslint.webpieces-angular.config.mjs

import webpiecesPlugin from '@webpieces/eslint-rules';

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
            // READ tmp/webpieces/webpieces.exceptions.md for AI rollout instructions and rationale
            '@webpieces/no-unmanaged-exceptions': 'error',
            '@webpieces/max-method-lines': ['error', { max: 70 }],
            '@webpieces/max-file-lines': ['error', { max: 700 }],
            '@webpieces/enforce-architecture': 'error',
            '@webpieces/no-json-property-primitive-type': 'error',
        },
    },
];
