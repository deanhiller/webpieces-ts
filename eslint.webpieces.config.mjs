// @webpieces/dev-config ESLint Configuration for webpieces-ts workspace
//
// IMPORTANT: This file must stay in sync with:
// - packages/tooling/dev-config/templates/eslint.webpieces.config.mjs (canonical template for clients)
//
// Only includes @webpieces custom rules
// Workspace-specific TypeScript and general rules are in eslint.config.mjs

import { loadWorkspaceRules } from '@nx/eslint-plugin';

// Load webpieces plugin directly from TypeScript source using loadWorkspaceRules
// This avoids the chicken-egg problem where ESLint config needs the plugin
// before dev-config has been built. loadWorkspaceRules automatically handles
// TypeScript transpilation.
const webpiecesRules = await loadWorkspaceRules(
    'packages/tooling/dev-config/eslint-plugin',
    'packages/tooling/dev-config/tsconfig.lib.json'
);

const webpiecesPlugin = { rules: webpiecesRules };

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
        },
    },
];
