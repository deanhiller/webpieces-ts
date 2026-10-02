import { describe, expect, it } from 'vitest';
import * as path from 'path';

// The same constraint is called by Nx before task graph creation.
const boundaries = require(path.join(process.cwd(), 'scripts/hook-boundaries.cjs')) as {
    HookBoundaries: new () => {
        forbidden(owner: string, dependency: string): boolean;
        assert(owner: string, dependency: string, file: string): void;
        validate(root: string): void;
    };
};

describe('independent hook owners', () => {
    it('accepts the complete current manifests and source imports, including test imports', () => {
        new boundaries.HookBoundaries().validate(process.cwd());
    });

    it.each([
        ['ai-hook-rules', 'agent-workflow-rules'],
        ['ai-hook-rules', 'repo-workflow-core'],
        ['agent-workflow-rules', 'ai-hook-rules'],
        ['pr-gate', 'ai-hook-rules'],
        ['hook-runtime', 'agent-workflow-rules'],
    ])('rejects %s importing %s before scheduling', (owner: string, dependency: string): void => {
        expect(() => new boundaries.HookBoundaries().assert(owner, dependency, 'fixture.ts')).toThrow('Forbidden hook dependency');
    });
});
