module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/apps', '<rootDir>/packages'],
  testMatch: ['**/*.spec.ts', '**/*.test.ts'],
  moduleNameMapper: {
    '^@webpieces/core-di$': '<rootDir>/packages/core/core-di/src/index.ts',
    '^@webpieces/core-context$': '<rootDir>/packages/core/core-context/src/index.ts',
    '^@webpieces/core-future$': '<rootDir>/packages/core/core-future/src/index.ts',
    '^@webpieces/core-meta$': '<rootDir>/packages/core/core-meta/src/index.ts',
    '^@webpieces/http-routing$': '<rootDir>/packages/http/http-routing/src/index.ts',
    '^@webpieces/http-filters$': '<rootDir>/packages/http/http-filters/src/index.ts',
    '^@webpieces/http-server$': '<rootDir>/packages/http/http-server/src/index.ts',
  },
  collectCoverageFrom: [
    'packages/**/*.ts',
    'apps/**/*.ts',
    '!**/*.spec.ts',
    '!**/*.test.ts',
    '!**/node_modules/**',
  ],
  coverageDirectory: 'coverage',
  verbose: true,
};
