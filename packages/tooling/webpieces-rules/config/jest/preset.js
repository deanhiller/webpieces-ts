/**
 * WebPieces Jest preset configuration
 *
 * This provides a base Jest configuration for TypeScript projects
 * using the WebPieces framework.
 *
 * Usage in consumer projects:
 *
 * ```javascript
 * // jest.config.js
 * module.exports = {
 *   preset: '@webpieces/webpieces-rules/jest',
 *   // Project-specific overrides
 * };
 * ```
 */

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/*.spec.ts', '**/*.test.ts'],
  collectCoverageFrom: [
    '**/*.ts',
    '!**/*.spec.ts',
    '!**/*.test.ts',
    '!**/node_modules/**',
    '!**/dist/**',
  ],
  coverageDirectory: 'coverage',
  verbose: true,
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: {
        emitDecoratorMetadata: true,
        experimentalDecorators: true,
      },
    }],
  },
};
