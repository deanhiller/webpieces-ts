/**
 * Precondition tests for the `missing-design-annotation` build rule.
 *
 * The di-graph-generate executor fails a server/designed-lib project when its
 * design graph is empty (no @DocumentDesign root). These tests pin the analyzer
 * behaviour the executor branches on: a project with DI-registered classes but
 * no @DocumentDesign class produces zero designs in BOTH root modes.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createProjectProgram } from '../di-graph/program';
import { buildDiGraph } from '../di-graph/analyzer';
import { DiGraph } from '../di-graph/model';

const TSCONFIG = JSON.stringify({
    compilerOptions: {
        target: 'ES2021',
        module: 'commonjs',
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        skipLibCheck: true,
        strict: false,
    },
    include: ['src/**/*.ts'],
});

// A DI-registered class with NO @DocumentDesign — exactly the shape that makes a
// server/designed-lib project's design empty and the build fail under the rule.
const NO_DESIGN_ROOT_FIXTURE: Record<string, string> = {
    'service.ts': `
import { provideSingleton } from '@webpieces/http-routing';

@provideSingleton()
export class LonelyService {}
`,
};

let workspaceRoot = '';

function buildGraph(rootMode: 'controller' | 'apiImplementation'): DiGraph {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'missing-design-spec-'));
    const projectRoot = 'proj';
    const projDir = path.join(workspaceRoot, projectRoot);
    fs.mkdirSync(path.join(projDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projDir, 'tsconfig.json'), TSCONFIG);
    for (const name of Object.keys(NO_DESIGN_ROOT_FIXTURE)) {
        fs.writeFileSync(path.join(projDir, 'src', name), NO_DESIGN_ROOT_FIXTURE[name]);
    }
    const program = createProjectProgram(projDir);
    expect(program).not.toBeNull();
    if (!program) throw new Error('program not created');
    // includeLibraryRoots=false mirrors InversifyAnalyzer for both server and designed-lib.
    return buildDiGraph(program, workspaceRoot, projectRoot, 'proj', false, rootMode);
}

afterEach(() => {
    if (workspaceRoot) fs.rmSync(workspaceRoot, { recursive: true, force: true });
    workspaceRoot = '';
});

describe('missing-design-annotation precondition', () => {
    it('server mode: no @DocumentDesign class → empty designs (executor fails the build)', () => {
        expect(buildGraph('controller').designs).toEqual([]);
    });

    it('designed-lib mode: no @DocumentDesign class → empty designs (executor fails the build)', () => {
        expect(buildGraph('apiImplementation').designs).toEqual([]);
    });
});
