import { isPathExcluded } from './exclude-paths';

const EXCLUDES = [
    'node_modules', 'dist', '.nx', '.git',
    'architecture', 'tmp', 'scripts',
    '**/*.d.ts', '**/jest.config.ts', '**/codegen.ts',
];

describe('isPathExcluded', () => {
    it('matches a bare directory segment at any depth', () => {
        expect(isPathExcluded('libraries/apis/orders-manager-api/scripts/emit-spec.ts', EXCLUDES)).toBe(true);
        expect(isPathExcluded('dist/foo.ts', EXCLUDES)).toBe(true);
    });

    it('matches glob patterns against the full relative path', () => {
        expect(isPathExcluded('libraries/pino-logger-config-mealco/index.d.ts', EXCLUDES)).toBe(true);
        expect(isPathExcluded('libraries/internal-graphql-client-mealco/codegen.ts', EXCLUDES)).toBe(true);
        expect(isPathExcluded('packages/foo/jest.config.ts', EXCLUDES)).toBe(true);
    });

    it('normalizes Windows backslashes', () => {
        expect(isPathExcluded('libraries\\foo\\index.d.ts', EXCLUDES)).toBe(true);
    });

    it('does not match a legitimately misplaced source file', () => {
        expect(isPathExcluded('packages/foo/helper.ts', EXCLUDES)).toBe(false);
        expect(isPathExcluded('packages/foo/src/index.ts', EXCLUDES)).toBe(false);
    });
});
