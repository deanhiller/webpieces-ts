import { specTempDirs } from '@webpieces/tooling-testkit';
/**
 * `webpieces.git-workflow.md` names the branch-mutation log by PATH, and that path is per-worktree.
 *
 * The bug: the template restated `.webpieces/logs/branch-mutations.log`. In a linked worktree the log
 * actually lives at `<primary>/.webpieces/worktrees/<name>/logs/branch-mutations.log`, so the doc — the
 * one an agent is handed by absolute path as instruction — named a file that does not exist there. The
 * reader greps nothing, and the silence reads as "no deletions were logged", which is the opposite of
 * the truth from the one file whose job is to prove every deletion is recoverable.
 *
 * The checkout is laid out on disk EXACTLY as git lays out a primary clone with a linked worktree
 * (checkoutLayout, #1381): the question "am I in a linked worktree, and where is the primary clone?" is
 * answered from those files (GitCheckout reads them; no process), so the layout is the real input.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { checkoutLayout } from '@webpieces/tooling-testkit';

import { BranchMutationLog } from '@webpieces/repo-workflow-core';
import { GIT_WORKFLOW_DOC } from './instruct-ai-docs';
import { TemplateWriter, loadTemplate } from './load-template';

let tmp = '';
let primary = '';
let worktree = '';

describe('webpieces.git-workflow.md — the branch-mutation log path it delivers', () => {
    beforeEach(() => {
        // realpathSync: macOS os.tmpdir() is a symlink and the git-dir resolver answers with the real path.
        tmp = specTempDirs.makeReal('gitworkflow-doc-');
        primary = path.join(tmp, 'primary');
        worktree = path.join(tmp, 'wt-a');
        fs.mkdirSync(primary, { recursive: true });
        checkoutLayout.primaryWithWorktree(primary, worktree, 'feature');
        fs.writeFileSync(path.join(primary, '.gitignore'), '.webpieces/\n');
    });

    afterEach(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    /**
     * The template is the source of truth, and it must carry the PLACEHOLDER rather than a path. A
     * literal here ships into every governed repo on the next release, which is what made this worth a
     * rule rather than a one-line fix.
     */
    it('the TEMPLATE carries the placeholder and no literal log path', () => {
        const template = loadTemplate(GIT_WORKFLOW_DOC);

        expect(template).toContain('{{BRANCH_MUTATION_LOG}}');
        expect(template).not.toContain('.webpieces/logs/branch-mutations.log');
    });

    it('the PRIMARY clone gets its own resolved path, and no placeholder survives', () => {
        const written = new TemplateWriter().writeTemplate(primary, GIT_WORKFLOW_DOC);
        const delivered = fs.readFileSync(written, 'utf-8');

        expect(delivered).toContain(new BranchMutationLog().branchMutationLogPath(primary));
        expect(delivered).not.toContain('{{BRANCH_MUTATION_LOG}}');
    });

    /**
     * The whole point. Same template, different tree, DIFFERENT path — and it is the namespaced one
     * under the primary clone, which is where the log a worktree writes actually lands.
     */
    it('a LINKED WORKTREE gets the namespaced path, not the primary clone\'s', () => {
        const written = new TemplateWriter().writeTemplate(worktree, GIT_WORKFLOW_DOC);
        const delivered = fs.readFileSync(written, 'utf-8');

        const forWorktree = new BranchMutationLog().branchMutationLogPath(worktree);
        expect(delivered).toContain(forWorktree);
        expect(forWorktree).not.toBe(new BranchMutationLog().branchMutationLogPath(primary));
        expect(forWorktree).toContain(path.join('.webpieces', 'worktrees'));
        expect(delivered).not.toContain('{{BRANCH_MUTATION_LOG}}');
    });

    /** Two trees, one template, two answers — asserted together so a regression to a constant is caught. */
    it('delivers DIFFERENT bytes to the two trees', () => {
        const writer = new TemplateWriter();
        const inPrimary = fs.readFileSync(writer.writeTemplate(primary, GIT_WORKFLOW_DOC), 'utf-8');
        const inWorktree = fs.readFileSync(writer.writeTemplate(worktree, GIT_WORKFLOW_DOC), 'utf-8');

        expect(inPrimary).not.toBe(inWorktree);
    });
});
