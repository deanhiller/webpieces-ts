export default {
    displayName: 'ai-hook-rules',
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
        '^@webpieces/rules-config$': '<rootDir>/../rules-config/src/index.ts',
    },
    testMatch: ['**/*.test.ts', '**/*.spec.ts'],
    passWithNoTests: true,
    coverageDirectory: '../../../coverage/packages/tooling/ai-hook-rules',
};
