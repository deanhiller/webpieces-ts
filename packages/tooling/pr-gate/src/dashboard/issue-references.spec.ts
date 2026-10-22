import { describe, it, expect } from 'vitest';
import { AddressedIssue, PrSummary, CK_ORANGE_FIXED, CK_OVERRIDDEN } from '@webpieces/rules-config';
import { InformAiError } from '@webpieces/tooling-common';
import { Dashboard, DashboardInput, ChecklistRow } from './dashboard';
import { ChecklistCommentRenderer } from './checklist-comment-renderer';
import { ChecklistCommentRow } from './checklist-comment-row';
import { AuthorIdentity } from './author-identity';
import { IssueReferences } from './issue-references';

const dash = new Dashboard();
const PR_URL = 'https://github.com/o/r/pull/42';
const GITHUB = 'https://github.com/o/r/issues/955';
const LINEAR = 'https://linear.app/onetablet/issue/ONE-1234';

function input(summary: string, issues: AddressedIssue[], hotfix = false): DashboardInput {
    const review = new PrSummary('codex', 'unknown', 'A title', 20, 'green', '🟢', summary, [], [], [], issues);
    return new DashboardInput('A title', [], dash.countAddedDisables(''), true, 'a'.repeat(12), 'b'.repeat(12), 'c'.repeat(12), review, [], 'pnpm wp-build', 0, new AuthorIdentity('codex', 'gpt'), hotfix);
}

function body(summary: string, issues: AddressedIssue[]): string {
    return dash.renderPrBody(input(summary, issues), PR_URL);
}

describe('addressesIssues in the PR body = the squash-commit body (issue #1310)', () => {
    it.each([CK_ORANGE_FIXED, CK_OVERRIDDEN])('keeps %s commentary from closing the delivery issue (#1368)', (status: string) => {
        const prose = 'Deploy after merge, then close #955 only when verification succeeds.';
        const value = input('Add startup diagnostics.', [new AddressedIssue(GITHUB, false)]);
        value.checklists = [new ChecklistRow('issue-reviewer', status, prose)];
        const rendered = dash.renderPrBody(value, PR_URL);
        expect(rendered).toContain('close issue #955 only when verification succeeds');
        expect(rendered).toContain(`Part of ${GITHUB}`);
        expect(rendered).not.toContain('close #955');
        const comment = new ChecklistCommentRenderer().render([
            new ChecklistCommentRow('codex', 'unknown', 'issue-reviewer', status, prose, true, [], [], ['src/a.ts'], 1),
        ], true, true, 0, false);
        expect(comment).toContain(prose);
        value.review.summary = 'Close #955 after deploying.';
        expect((): string => dash.renderPrBody(value, PR_URL)).toThrowError(InformAiError);
    });

    it('neutralizes every closing keyword and reference shape only in generated commentary (#1368)', () => {
        const issues = new IssueReferences();
        for (const prose of ['closes #1', 'CLOSED #1', 'fix #1', 'Fixed: #1', 'resolve #1', 'Resolves #1', 'resolved #1', `fixes ${LINEAR}`, 'Closes other/repo#3']) {
            const safe = issues.asCommentary(prose);
            expect((): void => issues.assertNoStrayClosingReferences(safe, [], 'retry')).not.toThrow();
            expect(issues.asCommentary(safe)).toBe(safe);
            expect((): void => issues.assertNoStrayClosingReferences(prose, [], 'retry')).toThrowError(InformAiError);
        }
    });

    it('renders a GitHub issue with closesIssue:true as "Fixes <url>"', () => {
        expect(body('Does the thing.', [new AddressedIssue(GITHUB, true)])).toContain(`\nFixes ${GITHUB}\n`);
    });

    it('renders a Linear issue with closesIssue:false as "Part of <url>", with no closing keyword at all', () => {
        const rendered = body('Does the thing.', [new AddressedIssue(LINEAR, false)]);
        expect(rendered).toContain(`\nPart of ${LINEAR}\n`);
        expect(rendered).not.toMatch(/\b(fix|fixes|fixed|close|closes|closed|resolve|resolves|resolved)\b/i);
    });

    it('renders a mixed true/false array, one line per entry, in order', () => {
        const rendered = body('Does the thing.', [new AddressedIssue(GITHUB, false), new AddressedIssue(LINEAR, true)]);
        expect(rendered).toContain(`\nPart of ${GITHUB}\nFixes ${LINEAR}\n`);
    });

    it('renders no ticket block for [] and still publishes', () => {
        const rendered = body('Does the thing.', []);
        expect(rendered).not.toContain('Fixes ');
        expect(rendered).not.toContain('Part of ');
    });

    it('REFUSES a stray "Fixes #N" in the summary that no closesIssue:true entry backs', () => {
        const render = (): string => body('Fixes #77\n\nDoes the thing.', [new AddressedIssue(GITHUB, true)]);
        expect(render).toThrowError(InformAiError);
        expect(render).toThrowError(/"Fixes #77"[\s\S]*addressesIssues[\s\S]*Then re-run: pnpm wp-finish-upsert-pr/);
    });

    it('REFUSES "Partially fixes #955" when the entry says closesIssue:false — the hole that closed #955 early', () => {
        const render = (): string => body('Partially fixes #955.', [new AddressedIssue(GITHUB, false)]);
        expect(render).toThrowError(/"fixes #955"/);
    });

    it('refuses every keyword spelling, a URL reference, and owner/repo#N, case-insensitively', () => {
        for (const text of ['closes #1', 'CLOSED #1', 'fix #1', 'Fixed: #1', 'resolve #1', 'Resolves #1', 'resolved #1', `fixes ${LINEAR}`, 'Closes other/repo#3']) {
            expect((): string => body(text, [new AddressedIssue(GITHUB, true)]), text).toThrowError(InformAiError);
        }
    });

    it('accepts a hand-written reference that a closesIssue:true entry backs (#N or the same URL)', () => {
        expect(body('Fixes #955. Does it.', [new AddressedIssue(GITHUB, true)])).toContain(`Fixes ${GITHUB}`);
        expect(body('Closes o/r#955 too.', [new AddressedIssue(GITHUB, true)])).toContain(`Fixes ${GITHUB}`);
        expect(body(`Resolves ${LINEAR}.`, [new AddressedIssue(LINEAR, true)])).toContain(`Fixes ${LINEAR}`);
    });

    it('names the hotfix command in the hotfix refusal', () => {
        expect((): string => dash.renderPrBody(input('Fixes #1', [], true), PR_URL)).toThrowError(/Then re-run: pnpm wp-upsert-hotfix-pr/);
    });

    it('is idempotent: a re-render, or a summary carrying a pasted block, yields exactly ONE block', () => {
        const issues = [new AddressedIssue(GITHUB, true), new AddressedIssue(LINEAR, false)];
        const first = body('Does the thing.', issues);
        expect(body('Does the thing.', issues)).toBe(first);
        const pasted = body(`Does the thing.\n\nFixes ${GITHUB}\nPart of ${LINEAR}`, issues);
        expect(pasted.split(`Fixes ${GITHUB}`).length - 1).toBe(1);
        expect(pasted.split(`Part of ${LINEAR}`).length - 1).toBe(1);
        expect(pasted).toBe(first);
    });

    it('warns once per closesIssue:true entry, and never for closesIssue:false', () => {
        expect(new IssueReferences().closeWarnings([new AddressedIssue(GITHUB, false), new AddressedIssue(LINEAR, true)])).toEqual([
            `⚠ Merging this PR will CLOSE ${LINEAR} (closesIssue: true)`,
        ]);
    });
});
