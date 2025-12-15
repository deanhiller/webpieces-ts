export default {
    displayName: 'example-server',
    preset: '../../jest.preset.js',
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
    coverageDirectory: '../../coverage/apps/example-server',
};
