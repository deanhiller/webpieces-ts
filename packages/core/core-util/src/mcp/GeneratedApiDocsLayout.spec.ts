import { describe, expect, it } from 'vitest';
import { GeneratedApiDocsLayout, GenerateOutputLookup, LayoutTargets } from './GeneratedApiDocsLayout';

function lookup(targets: LayoutTargets, projectRoot = 'libraries/apis'): GenerateOutputLookup {
    return new GeneratedApiDocsLayout(projectRoot, 'apis', targets).outputTarget();
}

describe('GeneratedApiDocsLayout — the ONE answer to "where do the generated documents live?"', () => {
    it('is the outputPath of the target openapi-generate dependsOn, whatever that target is named', () => {
        const found = lookup({
            tsc: { options: { outputPath: 'dist/libraries/apis' } },
            'openapi-generate': { dependsOn: ['^build', 'tsc'] },
        }).found;

        expect(found?.targetName).toBe('tsc');
        expect(found?.outputPath).toBe('dist/libraries/apis');
    });

    it('resolves nx tokens, so a project-LOCAL dist resolves the way nx resolves it', () => {
        const found = lookup({
            build: { options: { outputPath: '{workspaceRoot}/{projectRoot}/dist' } },
            'openapi-generate': { dependsOn: [{ target: 'build' }] },
        }).found;

        expect(found?.outputPath).toBe('libraries/apis/dist');
    });

    it('refuses no dependsOn, an upstream-only one, and an ambiguous one — naming the edit', () => {
        for (const dependsOn of [[], ['^build'], [{ target: 'build', dependencies: true }], ['build', 'lint']]) {
            const problem = lookup({
                build: { options: { outputPath: 'dist' } },
                'openapi-generate': { dependsOn },
            }).problem;
            expect(problem?.cure, JSON.stringify(dependsOn)).toContain('"dependsOn": ["build"]');
        }
    });

    it('refuses a target with no outputPath, and a project with no openapi-generate target', () => {
        expect(lookup({ build: {}, 'openapi-generate': { dependsOn: ['build'] } }).problem?.cure).toBe(
            'Declare targets.build.options.outputPath in libraries/apis/project.json.',
        );
        expect(lookup({}).problem?.cure).toContain('Tag the project "generate:openapi"');
    });
});
