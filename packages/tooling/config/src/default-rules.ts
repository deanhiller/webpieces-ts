// webpieces-disable no-any-unknown -- rule options are opaque at framework level
export const defaultRules: Record<string, Record<string, unknown>> = {
    'no-any-unknown': { enabled: true },
    'max-file-lines': { enabled: true, limit: 900 },
    'max-method-lines': { enabled: true, limit: 80 },
    'require-return-type': { enabled: true },
    'no-inline-type-literals': { enabled: true },
    'no-destructure': { enabled: true, allowTopLevel: true },
    'catch-error-pattern': { enabled: true },
    'no-unmanaged-exceptions': { enabled: true },
    'no-shell-substitution': { enabled: true },
    'validate-dtos': { enabled: true },
    'prisma-converter': { enabled: true },
    'no-direct-api-in-resolver': { enabled: true },
    'file-location': {
        enabled: true,
        allowedRootFiles: ['jest.setup.ts'],
        excludePaths: [
            'node_modules', 'dist', '.nx', '.git',
            'architecture', 'tmp', 'scripts',
        ],
    },
    'validate-ts-in-src': {
        enabled: true,
        allowedRootFiles: ['jest.setup.ts'],
        excludePaths: [
            'node_modules', 'dist', '.nx', '.git',
            'architecture', 'tmp', 'scripts',
        ],
    },
};

export const defaultRulesDir: readonly string[] = [];
