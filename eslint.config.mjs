// ESLint configuration for webpieces-ts
// Uses @webpieces/dev-config base configuration

import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

// Import webpieces plugin from dist (compiled JavaScript)
// In workspace development, use the compiled output from dist
import webpiecesPlugin from './dist/packages/tooling/dev-config/eslint-plugin/index.js';

export default [
    {
        ignores: ['**/dist', '**/node_modules', '**/coverage', '**/.nx'],
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

            // TypeScript rules
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/explicit-function-return-type': 'off',
            '@typescript-eslint/no-unused-vars': [
                'warn',
                {
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                },
            ],
            '@typescript-eslint/no-empty-interface': 'off',
            '@typescript-eslint/no-empty-function': 'off',

            // General code quality
            'no-console': 'off',
            'no-debugger': 'warn',
            'no-var': 'error',
            'prefer-const': 'warn',
        },
    },
    {
        // Test files - relaxed rules
        files: ['**/*.spec.ts', '**/*.test.ts'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-non-null-assertion': 'off',
        },
    },
];
