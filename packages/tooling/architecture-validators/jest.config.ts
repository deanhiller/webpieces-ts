export default {
    displayName: 'architecture-validators',
    preset: '../../../jest.preset.js',
    testEnvironment: 'node',
    transform: {
        '^.+\\.[tj]s$': [
            'ts-jest',
            {
                tsconfig: '<rootDir>/tsconfig.spec.json',
            },
        ],
    },
    moduleFileExtensions: ['ts', 'js', 'html'],
    moduleNameMapper: {
        '^@webpieces/config$': '<rootDir>/../config/src/index.ts',
    },
    testMatch: ['**/*.test.ts', '**/*.spec.ts'],
    passWithNoTests: true,
    coverageDirectory: '../../../coverage/packages/tooling/architecture-validators',
};
