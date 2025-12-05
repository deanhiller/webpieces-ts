// @webpieces/dev-config base ESLint configuration
// Consumer projects can extend this configuration

import webpiecesPlugin from '../../eslint-plugin/index.js';

/**
 * WebPieces base ESLint configuration using flat config format.
 *
 * This provides sensible defaults for TypeScript projects following
 * WebPieces patterns and conventions.
 *
 * Includes custom WebPieces rules:
 * - catch-error-pattern: Enforces toError() usage in catch blocks
 * - max-method-lines: Enforces maximum method length (70 lines)
 * - max-file-lines: Enforces maximum file length (700 lines)
 * - enforce-architecture: Enforces architecture dependency boundaries
 *
 * Usage in consumer projects:
 *
 * ```javascript
 * // eslint.config.mjs
 * import webpiecesConfig from '@webpieces/dev-config/eslint';
 * import nx from '@nx/eslint-plugin';
 *
 * export default [
 *   ...webpiecesConfig,
 *   ...nx.configs['flat/typescript'],
 *   {
 *     // Project-specific overrides
 *     rules: {}
 *   }
 * ];
 * ```
 */
export default [
    {
        // Ignore common directories
        ignores: [
            '**/dist',
            '**/out-tsc',
            '**/tmp',
            '**/coverage',
            '**/node_modules',
            '**/.nx',
            '**/.vscode',
            '**/.idea',
        ],
    },
    {
        files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
        plugins: {
            '@webpieces': webpiecesPlugin,
        },
        languageOptions: {
            ecmaVersion: 2021,
            sourceType: 'module',
        },
        rules: {
            // WebPieces custom rules
            '@webpieces/catch-error-pattern': 'error',
            '@webpieces/max-method-lines': ['error', { max: 70 }],
            '@webpieces/max-file-lines': ['error', { max: 700 }],
            '@webpieces/enforce-architecture': 'error',
            // General code quality
            'no-console': 'off', // Allow console for logging
            'no-debugger': 'warn',
            'no-alert': 'warn',
            'no-var': 'error',
            'prefer-const': 'warn',
            'prefer-arrow-callback': 'warn',

            // TypeScript rules (when @typescript-eslint is available)
            '@typescript-eslint/no-explicit-any': 'warn', // Prefer unknown over any
            '@typescript-eslint/explicit-function-return-type': 'off', // Allow inference
            '@typescript-eslint/no-unused-vars': [
                'warn',
                {
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                },
            ],
            '@typescript-eslint/no-empty-interface': 'off', // WebPieces uses classes for data
            '@typescript-eslint/no-empty-function': 'off',

            // Import organization
            'sort-imports': 'off', // Handled by IDE
        },
    },
    {
        // Specific rules for test files
        files: ['**/*.spec.ts', '**/*.test.ts'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'off', // Allow any in tests
            '@typescript-eslint/no-non-null-assertion': 'off',
        },
    },
];
