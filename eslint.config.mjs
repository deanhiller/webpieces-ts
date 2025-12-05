// ESLint configuration for webpieces-ts
// Uses @webpieces/dev-config base configuration

import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

// Import webpieces plugin from dist (compiled JavaScript)
// In workspace development, use the compiled output from dist
import webpiecesPlugin from './dist/packages/tooling/dev-config/eslint-plugin/index.js';

export default [
    {
        ignores: ['**/dist', '**/node_modules', '**/coverage', '**/.nx', 'scripts/**'],
    },
    {
        files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
        plugins: {
            '@webpieces': webpiecesPlugin,
            '@typescript-eslint': tseslint,
        },
        languageOptions: {
            parser: tsparser,
            ecmaVersion: 2021,
            sourceType: 'module',
        },
        rules: {
            // WebPieces custom rules
            '@webpieces/catch-error-pattern': 'error',
            '@webpieces/max-method-lines': ['error', { max: 70 }],
            '@webpieces/max-file-lines': ['error', { max: 700 }],
            '@webpieces/enforce-architecture': 'error',

            // TypeScript rules
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/explicit-function-return-type': 'off',
            '@typescript-eslint/no-unused-vars': 'off',
            '@typescript-eslint/no-empty-interface': 'off',
            '@typescript-eslint/no-empty-function': 'off',

            // General code quality
            'no-console': 'off',
            'no-debugger': 'off',
            'no-var': 'error',
            'prefer-const': 'off',
        },
    },
    {
        // Test files - relaxed rules
        files: ['**/*.spec.ts', '**/*.test.ts'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-non-null-assertion': 'off',
            '@webpieces/max-method-lines': 'off',
        },
    },
    {
        // ESLint plugin rules - disable self-checking (false positives on AST node handlers)
        // and allow long methods for rule implementations
        files: ['**/eslint-plugin/rules/**/*.ts'],
        rules: {
            '@webpieces/catch-error-pattern': 'off',
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
            '@webpieces/max-method-lines': 'off',
            '@webpieces/max-file-lines': 'off',
        },
    },
];
