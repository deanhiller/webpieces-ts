module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/apps', '<rootDir>/packages'],
    testMatch: ['**/*.spec.ts', '**/*.test.ts'],
    moduleNameMapper: {
        '^@webpieces/core-context$': '<rootDir>/packages/core/core-context/src/index.ts',
        '^@webpieces/core-meta$': '<rootDir>/packages/core/core-meta/src/index.ts',
        '^@webpieces/core-util$': '<rootDir>/packages/core/core-util/src/index.ts',
        '^@webpieces/http-api$': '<rootDir>/packages/http/http-api/src/index.ts',
        '^@webpieces/http-routing$': '<rootDir>/packages/http/http-routing/src/index.ts',
        '^@webpieces/http-filters$': '<rootDir>/packages/http/http-filters/src/index.ts',
        '^@webpieces/http-server$': '<rootDir>/packages/http/http-server/src/index.ts',
        '^@webpieces/http-client$': '<rootDir>/packages/http/http-client/src/index.ts',
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
    // Setup file to replace Jest's console with Node's native console
    // This removes the "at ..." stack traces after each console.log
    setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
};
