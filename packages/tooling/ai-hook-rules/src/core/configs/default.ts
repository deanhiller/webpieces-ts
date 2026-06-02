// webpieces-disable no-any-unknown -- rule options are opaque at framework level
export const defaultRules: Record<string, Record<string, unknown>> = {
    'no-any-unknown': { mode: 'ON' },
    'max-file-lines': { mode: 'ON', limit: 900 },
    'file-location': {
        mode: 'ON',
        allowedRootFiles: ['jest.setup.ts'],
        excludePaths: [
            'node_modules', 'dist', '.nx', '.git',
            'architecture', 'tmp', 'scripts',
        ],
    },
    'no-destructure': { mode: 'ON', allowTopLevel: true },
    'require-return-type': { mode: 'ON' },
    'no-unmanaged-exceptions': { mode: 'ON' },
    'catch-error-pattern': { mode: 'ON' },
};

export const defaultRulesDir: readonly string[] = [];
