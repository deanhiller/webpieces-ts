import * as path from 'node:path';

/**
 * The tsconfig `paths` the inheritance fixture's two PACKAGES resolve through (#1055) — handed to the
 * compiler by `InheritedFields.spec.ts` and by the repo sweep, so both read the same program.
 */
export class InheritanceFixturePaths {
    // webpieces-disable no-function-outside-class -- static accessor of a test-fixture constant
    static paths(): Record<string, string[]> {
        return {
            // A workspace package, resolved to its SOURCE — how a monorepo's tsconfig.base.json does it.
            '@fixture/source-dtos': [
                path.join(__dirname, 'packages', 'source-dtos', 'src', 'index.ts'),
            ],
            // A published package, resolved to its DECLARATIONS — what an npm consumer has installed.
            '@fixture/published-dtos': [path.join(__dirname, 'packages', 'published-dtos')],
        };
    }
}
