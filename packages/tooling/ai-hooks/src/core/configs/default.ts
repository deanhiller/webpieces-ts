// webpieces-disable no-any-unknown -- rule options are opaque at framework level
export const defaultRules: Record<string, Record<string, unknown>> = {
    'no-any-unknown': { enabled: true },
    'max-file-lines': { enabled: true, limit: 900 },
    'file-location': {
        enabled: true,
        allowedRootFiles: ['jest.setup.ts'],
        excludePaths: [
            'node_modules', 'dist', '.nx', '.git',
            'architecture', 'tmp', 'scripts',
        ],
    },
    'no-destructure': { enabled: true, allowTopLevel: true },
    'require-return-type': { enabled: true },
    'no-unmanaged-exceptions': { enabled: true },
    'catch-error-pattern': { enabled: true },
};

export const defaultRulesDir: readonly string[] = [];
