export default {
    displayName: 'ai-hooks',
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
    testMatch: ['**/*.test.ts', '**/*.spec.ts'],
    passWithNoTests: true,
    coverageDirectory: '../../../coverage/packages/tooling/ai-hooks',
};
