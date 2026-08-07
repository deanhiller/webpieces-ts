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
     * The REASON has to travel with the command. "Use wp-land-pr" alone is a rule to be forgotten;
     * naming the mechanism — the repo setting a UI merge substitutes the body from — is what makes the
     * consequence checkable by whoever reads it next.
     */
    it('explains WHY a UI merge or bare gh pr merge cannot produce the gated commit body', () => {
        const doc = loadTemplate(DOC);
        expect(doc).toContain('squash_merge_commit_message');
        expect(doc).toContain('--body-file');
    });

    /**
     * No bare `gh pr merge` prescription anywhere. Every mention must carry the flags that make it the
     * real thing (`--subject`/`--body-file`) or be explicitly framed as the route NOT to take — which is
     * exactly what pr-merge-guard enforces at the tool-call layer.
     */
    it('never prescribes a bare gh pr merge that pr-merge-guard would block', () => {
        const doc = loadTemplate(DOC);
        const offenders = doc
            .split('\n')
            .filter((line: string): boolean => line.includes('gh pr merge'))
            .filter((line: string): boolean =>
                !line.includes('--body-file')
                && !line.includes('--subject')
                && !line.includes('INSTEAD of'));
        expect(offenders).toEqual([]);
    });
});
