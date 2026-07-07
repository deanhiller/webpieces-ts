// @webpieces/eslint-rules recommended ESLint configuration
// Consumer projects can extend this configuration

import webpiecesPlugin from '@webpieces/eslint-rules';

/**
 * WebPieces recommended ESLint configuration using flat config format.
 *
 * Includes custom WebPieces rules:
 * - catch-error-pattern: Enforces toError() usage in catch blocks
 * - no-unmanaged-exceptions: Discourages try-catch outside test files
 * - max-method-lines: Enforces maximum method length (70 lines)
 * - max-file-lines: Enforces maximum file length (700 lines)
 * - enforce-architecture: Enforces architecture dependency boundaries
 * - no-json-property-primitive-type: Enforces DTO field typing conventions
 *
 * Usage in consumer projects:
 *
 * ```javascript
 * // eslint.config.mjs
 * import webpiecesConfig from '@webpieces/eslint-rules/recommended';
 *
 * export default [
 *   ...webpiecesConfig,
 *   {
 *     // Project-specific overrides
 *     rules: {}
 *   }
 * ];
 * ```
 */
export default [
    {
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
            '@webpieces/catch-error-pattern': 'error',
            '@webpieces/no-unmanaged-exceptions': 'error',
            '@webpieces/max-method-lines': ['error', { max: 70 }],
            '@webpieces/max-file-lines': ['error', { max: 700 }],
            '@webpieces/enforce-architecture': 'error',
            '@webpieces/no-json-property-primitive-type': 'error',
            'no-console': 'off',
            'no-debugger': 'warn',
            'no-alert': 'warn',
            'no-var': 'error',
            'prefer-const': 'warn',
            'prefer-arrow-callback': 'warn',
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
            'sort-imports': 'off',
        },
    },
    {
        files: ['**/*.spec.ts', '**/*.test.ts'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-non-null-assertion': 'off',
        },
    },
];
