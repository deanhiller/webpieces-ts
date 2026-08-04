/**
 * Which design artifacts reach disk — the half of di-graph-generate that decides whether a project
 * gets committed files at all.
 *
 * An empty `{ "designs": [] }` used to be written for EVERY project without a DI root: legacy Express
 * services, plain libs, api-libs, bundles. Three committed files apiece saying nothing, in every diff
 * and every PR file list, forever. These tests pin that an empty graph now emits nothing and reaps
 * anything stale, and — just as importantly — that a real graph is completely unaffected.
 *
 * The safety argument is asserted in graph-metadata.spec.ts territory rather than here: nothing
 * downstream can distinguish "empty file" from "no file" (hasGeneratedDesign treats a MISSING
 * design.json as "no design"), which is what makes not writing it a no-op for the architecture viz.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { removeDesignFiles, writeDesignFiles } from '../../executors/di-graph-generate/executor';
import { DiDesign, DiGraph } from '../di-graph/model';

const DESIGN_FILES = ['design.json', 'design.md', 'design.html'];
const PROJECT_ROOT = 'services/legacy-thing';

let projectRootAbs = '';

function emptyGraph(): DiGraph {
    return new DiGraph('legacy-thing');
}

// A graph with one real root — the shape a webpieces service produces.
function realGraph(): DiGraph {
    const graph = new DiGraph('real-service');
    graph.designs.push(new DiDesign('MyApp', 'controller', `${PROJECT_ROOT}/src/my-app.ts`));
    return graph;
}

function present(): string[] {
    return DESIGN_FILES.filter((name: string): boolean => fs.existsSync(path.join(projectRootAbs, name)));
}

function writeStaleDesignFiles(): void {
    for (const name of DESIGN_FILES) {
        fs.writeFileSync(path.join(projectRootAbs, name), '{"schemaVersion":2,"designs":[]}');
    }
}

beforeEach((): void => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-emission-'));
    projectRootAbs = path.join(root, PROJECT_ROOT);
    fs.mkdirSync(projectRootAbs, { recursive: true });
});

describe('design file emission — a project with NO design root', () => {
    it('writes nothing at all', (): void => {
        writeDesignFiles(projectRootAbs, PROJECT_ROOT, emptyGraph());
        expect(present()).toEqual([]);
    });

    it('REAPS files left behind by an earlier run, rather than leaving them stale', (): void => {
        writeStaleDesignFiles();
        expect(present()).toEqual(DESIGN_FILES);

        writeDesignFiles(projectRootAbs, PROJECT_ROOT, emptyGraph());
        expect(present()).toEqual([]);
    });

    it('is idempotent — a second run on an already-clean project is a no-op', (): void => {
        writeDesignFiles(projectRootAbs, PROJECT_ROOT, emptyGraph());
        writeDesignFiles(projectRootAbs, PROJECT_ROOT, emptyGraph());
        expect(present()).toEqual([]);
    });
});

describe('design file emission — a project WITH a design root', () => {
    it('writes all three files, exactly as before', (): void => {
        writeDesignFiles(projectRootAbs, PROJECT_ROOT, realGraph());
        expect(present()).toEqual(DESIGN_FILES);
    });

    it('writes a design.json whose designs[] is non-empty — what makes the arch box clickable', (): void => {
        writeDesignFiles(projectRootAbs, PROJECT_ROOT, realGraph());
        // webpieces-disable no-any-unknown -- the file we just serialized, narrowed on the next line
        const parsed = JSON.parse(fs.readFileSync(path.join(projectRootAbs, 'design.json'), 'utf-8')) as { designs: unknown[] };
        expect(parsed.designs.length).toBe(1);
    });

    it('replaces a stale design rather than reaping it', (): void => {
        writeStaleDesignFiles();
        writeDesignFiles(projectRootAbs, PROJECT_ROOT, realGraph());
        expect(present()).toEqual(DESIGN_FILES);
        expect(fs.readFileSync(path.join(projectRootAbs, 'design.json'), 'utf-8')).toContain('MyApp');
    });
});

describe('removeDesignFiles', () => {
    it('reports exactly what it deleted, so the executor log names real files', (): void => {
        writeStaleDesignFiles();
        expect(removeDesignFiles(projectRootAbs).sort()).toEqual([...DESIGN_FILES].sort());
    });

    it('reports nothing when there was nothing there', (): void => {
        expect(removeDesignFiles(projectRootAbs)).toEqual([]);
    });

    it('deletes only the design artifacts, never a neighbouring file', (): void => {
        writeStaleDesignFiles();
        fs.writeFileSync(path.join(projectRootAbs, 'project.json'), '{}');
        fs.writeFileSync(path.join(projectRootAbs, 'responsibilities.md'), '# not ours to delete');

        removeDesignFiles(projectRootAbs);
        expect(fs.existsSync(path.join(projectRootAbs, 'project.json'))).toBe(true);
        expect(fs.existsSync(path.join(projectRootAbs, 'responsibilities.md'))).toBe(true);
    });
});
