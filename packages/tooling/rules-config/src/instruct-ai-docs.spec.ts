import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect } from 'vitest';

import { InstructAiDocSet } from './instruct-ai-docs';
import { loadTemplate, writeTemplate, writeTemplateIfMissing } from './load-template';
import { MERGE_PROCESS_DOC } from './merge-process-doc';
import { BUILD_LOG_DOC } from './build-log-doc';

const GIT_WORKFLOW_DOC = 'webpieces.git-workflow.md';
const LOCATION_MATRIX_DOC = 'webpieces.location-matrix.md';

function tempRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'wp-instruct-ai-'));
}

function deliveredDir(root: string): string {
    return path.join(root, '.webpieces', 'instruct-ai');
}

/**
 * THE TEST THAT STOPS THE CLASS, NOT THE INSTANCE.
 *
 * `webpieces.git-workflow.md` linked to `webpieces.mergeprocess.md`, and six of nine governed repos had
 * the first and not the second. Delivering that one extra doc fixes one link; this test is what stops
 * the NEXT doc from going missing the same way, because it fails the build the moment any generated
 * instruct-ai doc names a sibling the writer does not also write.
 */
describe('instruct-ai docs — link integrity', () => {
    it('has no doc that links to a sibling outside the set', () => {
        const docs = new InstructAiDocSet();
        const dangling: string[] = [];
        for (const doc of docs.all()) {
            for (const missing of docs.danglingIn(loadTemplate(doc.name))) {
                dangling.push(`${doc.name} -> ${missing}`);
            }
        }
        expect(dangling, 'a delivered doc must never link to a doc the writer does not deliver').toEqual([]);
    });

    it('counts the merge-process doc, the build-log doc and the L1 matrix as members', () => {
        const names = new InstructAiDocSet().all().map((doc): string => doc.name);
        expect(names).toContain(MERGE_PROCESS_DOC);
        expect(names).toContain(BUILD_LOG_DOC);
        expect(names).toContain(LOCATION_MATRIX_DOC);
    });

    it('reaches all three from the git-workflow doc by links alone', () => {
        const docs = new InstructAiDocSet();
        const reached = docs.closure(GIT_WORKFLOW_DOC, loadTemplate).map((doc): string => doc.name);
        expect(reached[0]).toBe(GIT_WORKFLOW_DOC);
        expect(reached).toContain(MERGE_PROCESS_DOC);
        expect(reached).toContain(BUILD_LOG_DOC);
        expect(reached).toContain(LOCATION_MATRIX_DOC);
    });

    it('returns a non-member alone rather than guessing — the CI workflow yml is not an instruct-ai doc', () => {
        const docs = new InstructAiDocSet();
        const reached = docs.closure('webpieces-pr-gate.yml', loadTemplate).map((doc): string => doc.name);
        expect(reached).toEqual(['webpieces-pr-gate.yml']);
    });
});

describe('instruct-ai docs — written as a SET', () => {
    it('writes every linked doc when a caller names only the git-workflow doc', () => {
        const root = tempRoot();
        const written = writeTemplate(root, GIT_WORKFLOW_DOC);

        expect(written).toBe(path.join(deliveredDir(root), GIT_WORKFLOW_DOC));
        for (const name of [GIT_WORKFLOW_DOC, MERGE_PROCESS_DOC, BUILD_LOG_DOC, LOCATION_MATRIX_DOC]) {
            expect(fs.existsSync(path.join(deliveredDir(root), name)), name).toBe(true);
        }
    });

    it('delivers the merge-process doc with every placeholder resolved', () => {
        const root = tempRoot();
        writeTemplate(root, GIT_WORKFLOW_DOC);
        const delivered = fs.readFileSync(path.join(deliveredDir(root), MERGE_PROCESS_DOC), 'utf8');

        expect(delivered).not.toContain('{{');
        expect(delivered).toContain('Reference copy — no conflicted 3-point merge is in progress');
        // The reference rendering is still the PROCESS: the gate command a reader needs is present.
        expect(delivered).toContain('pnpm wp-finish-upsert-pr');
    });

    it('seeds the closure too — a rule dropping one doc still delivers what that doc links to', () => {
        const root = tempRoot();

        // The guards seed a doc beside a violation rather than refreshing it. That path considers the
        // same closure; only WHETHER an existing file is rewritten differs.
        writeTemplateIfMissing(root, GIT_WORKFLOW_DOC);

        for (const name of [GIT_WORKFLOW_DOC, MERGE_PROCESS_DOC, BUILD_LOG_DOC, LOCATION_MATRIX_DOC]) {
            expect(fs.existsSync(path.join(deliveredDir(root), name)), name).toBe(true);
        }
    });

    it('leaves an already-seeded doc alone', () => {
        const root = tempRoot();
        const target = path.join(deliveredDir(root), BUILD_LOG_DOC);
        fs.mkdirSync(deliveredDir(root), { recursive: true });
        fs.writeFileSync(target, 'ALREADY HERE');

        writeTemplateIfMissing(root, GIT_WORKFLOW_DOC);

        expect(fs.readFileSync(target, 'utf8')).toBe('ALREADY HERE');
        expect(fs.existsSync(path.join(deliveredDir(root), LOCATION_MATRIX_DOC))).toBe(true);
    });

    it('never overwrites a LIVE merge handback with the reference copy', () => {
        const root = tempRoot();
        const target = path.join(deliveredDir(root), MERGE_PROCESS_DOC);
        fs.mkdirSync(deliveredDir(root), { recursive: true });
        fs.writeFileSync(target, 'LIVE HANDBACK for branch fooSquash');

        writeTemplate(root, GIT_WORKFLOW_DOC);

        // `wp-finish-upsert-pr` runs while a conflicted merge is still open; clobbering the handback
        // would delete the conflicted-file list the agent is resolving from.
        expect(fs.readFileSync(target, 'utf8')).toBe('LIVE HANDBACK for branch fooSquash');
    });
});
