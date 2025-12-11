// ESLint configuration for webpieces-ts workspace
// Imports @webpieces custom rules from eslint.webpieces.config.mjs
// Workspace-specific TypeScript and general rules configured here

import webpiecesConfig from './eslint.webpieces.config.mjs';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
    // Import @webpieces custom rules
    ...webpiecesConfig,

    // Workspace-specific ignores
    {
        ignores: ['scripts/**'],
    },

    // Workspace-specific TypeScript and general rules
    {
        files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
        plugins: {
            '@typescript-eslint': tseslint,
        },
        languageOptions: {
            parser: tsparser,
            ecmaVersion: 2021,
            sourceType: 'module',
        },
        rules: {
            // TypeScript rules (workspace preferences)
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/explicit-function-return-type': 'off',
            '@typescript-eslint/no-unused-vars': 'off',
            '@typescript-eslint/no-empty-interface': 'off',
            '@typescript-eslint/no-empty-function': 'off',

            // General code quality (workspace preferences)
            'no-console': 'off',
            'no-debugger': 'off',
            'no-var': 'error',
            'prefer-const': 'off',
        },
    },
    {
        // Test files - additional relaxed TypeScript rules
        files: ['**/*.spec.ts', '**/*.test.ts'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-non-null-assertion': 'off',
        },
    },
    {
        // ESLint plugin rules - disable self-checking (false positives on AST node handlers)
        // and allow long methods for rule implementations
        files: ['**/eslint-plugin/rules/**/*.ts'],
        rules: {
            '@webpieces/catch-error-pattern': 'off',
            '@webpieces/no-unmanaged-exceptions': 'off',
            '@webpieces/max-method-lines': 'off',
        },
    },
    {
        // ESLint plugin tests - relaxed rules for test infrastructure
        files: ['**/eslint-plugin/__tests__/**/*.ts'],
        rules: {
            '@webpieces/catch-error-pattern': 'off',
        },
    },
    {
        // Architecture tooling - relaxed rules for build infrastructure
        files: ['**/architecture/executors/**/*.ts', '**/architecture/lib/**/*.ts'],
        rules: {
            '@webpieces/catch-error-pattern': 'off',
            '@webpieces/no-unmanaged-exceptions': 'off',
            '@webpieces/max-method-lines': 'off',
            '@webpieces/max-file-lines': 'off',
        },
    },
];
