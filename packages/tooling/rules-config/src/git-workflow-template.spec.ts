import { describe, expect, it } from 'vitest';
import { loadTemplate } from './load-template';

const DOC = 'webpieces.git-workflow.md';

/**
 * The git-workflow doc is the AI's primary account of how a PR reaches main, regenerated into
 * `.webpieces/instruct-ai/` on every `wp-*` command. It therefore has to agree with `pr-merge-guard`,
 * which BLOCKS a hand-rolled `gh pr merge` outright — a doc prescribing a command the guard rejects
 * teaches a route that cannot be taken, and the version of it that omitted `wp-land-pr` entirely is why
 * two consumer repos landed every squash commit carrying the full dashboard.
 *
 * Asserted on the TEMPLATE, which is the source of truth; the copy in a consumer's `.webpieces/` is
 * rewritten from it and lags by one release (see CLAUDE.md, "Published vs local source").
 */
describe('webpieces.git-workflow.md — the landing route it teaches', () => {
    it('names wp-land-pr as a first-class step, not just in passing', () => {
        const doc = loadTemplate(DOC);
        expect(doc).toContain('`pnpm wp-land-pr`');
    });

    /**
     * The MECHANISM has to travel with the command, because it is what a reader can check. Both repo
     * settings must be named: with `PR_TITLE` + `PR_BODY` set, every landing route writes identical
     * history, and with either one wrong the commit silently gets the wrong subject or the wrong body.
     *
     * This replaced an assertion that the doc explains why a UI merge CANNOT produce the gated body.
     * That was true only while the PR description held the long dashboard; the description is now the
     * compact git-log body, so `PR_BODY` copies exactly the right text and the UI button is correct.
     */
    it('names both squash_merge_commit_* settings the good history depends on', () => {
        const doc = loadTemplate(DOC);
        expect(doc).toContain('squash_merge_commit_title: PR_TITLE');
        expect(doc).toContain('squash_merge_commit_message: PR_BODY');
    });

    /**
     * The doc must state the invariant, not just the command — that the PR DESCRIPTION is the commit body.
     * An agent that has memorised only the land command will put long-form content in the description
     * and pollute history without ever touching a merge command.
     */
    it('states that the PR description is what lands in git log', () => {
        const doc = loadTemplate(DOC);
        expect(doc).toContain('PR DESCRIPTION');
        expect(doc).toContain('git log');
    });

    /**
     * The doc must not teach that a UI merge or a bare `gh pr merge` corrupts the commit message — that
     * was the pre-swap truth, and leaving it in place would be a doc that contradicts the code (the shim
     * shape the compatibility policy calls out: an instruction that teaches a removed behaviour).
     */
    it('no longer claims a UI merge pastes the dashboard into history', () => {
        const doc = loadTemplate(DOC);
        expect(doc).not.toContain('ENTIRE dashboard');
        expect(doc).not.toContain('pastes');
    });
});
