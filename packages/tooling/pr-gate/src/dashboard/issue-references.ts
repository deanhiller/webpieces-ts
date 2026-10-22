import { AddressedIssue } from '@webpieces/rules-config';
import { InformAiError } from '@webpieces/tooling-common';

/**
 * Turns summary.json's `addressesIssues` (issue #1310) into the PR body's ticket lines, and guards that body
 * against every OTHER closing reference.
 *
 * The lines are `Fixes <url>` (closesIssue: true) and `Part of <url>` (closesIssue: false). `Part of` is
 * deliberately not a closing keyword for GitHub, and is one of Linear's documented non-closing magic words,
 * so a multi-PR ticket is linked by every PR and closed only by the one that says so.
 *
 * The guard is the half that matters. GitHub closes an issue for a closing keyword followed by a reference
 * ANYWHERE in the body — "Partially fixes #955" still contains "fixes #955" and closed
 * ctoteachings/monorepo#955 on the first of its four PRs. So any closing keyword in the rendered body that
 * no `closesIssue: true` entry backs refuses the publish, naming the text and both cures.
 *
 * One class serves `wp-finish-upsert-pr`, `wp-upsert-hotfix-pr` and `wp-human-post-pr`, so a summary.json is
 * rendered and judged the same way wherever it becomes a PR body.
 */
export class IssueReferences {
    // close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved, then `#N`, `owner/repo#N` or a URL.
    private static readonly CLOSING_REFERENCE =
        /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s*((?:[\w.-]+\/[\w.-]+)?#\d+|https?:\/\/[^\s<>()[\]]+)/gi;

    /** `Fixes <url>` / `Part of <url>`, in summary.json order. [] when the PR addresses no tracked issue. */
    blockLines(issues: readonly AddressedIssue[]): string[] {
        return issues.map((issue: AddressedIssue): string => `${issue.closesIssue ? 'Fixes' : 'Part of'} ${issue.url}`);
    }

    /** Generated review commentary must not act as a GitHub issue-closing directive (#1368). */
    asCommentary(text: string): string {
        return text.replace(IssueReferences.CLOSING_REFERENCE, '$1 issue $2');
    }

    /**
     * The summary text with every line that IS one of the block's lines removed, so the rendered body carries
     * exactly one block even when an author pasted a previous body's ticket lines into `summary`.
     */
    withoutBlockLines(text: string, issues: readonly AddressedIssue[]): string {
        const block = new Set(this.blockLines(issues));
        return text
            .split('\n')
            .filter((line: string): boolean => !block.has(line.trim()))
            .join('\n')
            .trim();
    }

    /** One visible warning per `closesIssue: true` entry, printed before the PR is published. */
    closeWarnings(issues: readonly AddressedIssue[]): string[] {
        return issues
            .filter((issue: AddressedIssue): boolean => issue.closesIssue)
            .map((issue: AddressedIssue): string => `⚠ Merging this PR will CLOSE ${issue.url} (closesIssue: true)`);
    }

    /**
     * Refuse when `body` holds a closing reference no `closesIssue: true` entry backs. The rendered
     * `Fixes <url>` lines are backed by construction, so only hand-written references can trip this.
     */
    assertNoStrayClosingReferences(body: string, issues: readonly AddressedIssue[], retryCommand: string): void {
        const closing = issues.filter((issue: AddressedIssue): boolean => issue.closesIssue);
        const stray: string[] = [];
        for (const match of body.matchAll(IssueReferences.CLOSING_REFERENCE)) {
            const reference = this.trimTrailingPunctuation(match[2] ?? '');
            if (!closing.some((issue: AddressedIssue): boolean => this.backs(issue.url, reference))) {
                stray.push(`"${this.trimTrailingPunctuation(match[0])}"`);
            }
        }
        if (stray.length === 0) return;
        throw new InformAiError(
            `The PR body would carry ${stray.length} closing reference(s) that no summary.json addressesIssues entry with ` +
                `"closesIssue": true backs: ${stray.join(', ')}.\n\n` +
                'GitHub closes an issue for a closing keyword (close/closes/closed, fix/fixes/fixed, resolve/resolves/resolved) ' +
                'followed by a reference ANYWHERE in the body — "Partially fixes #N" still closes #N. Nothing was published.\n\n' +
                'Delete the keyword from summary.json\'s "summary" (and any other text you wrote), and state the ticket in ' +
                '"addressesIssues" instead, with its full https:// URL:\n' +
                '  { "url": "https://github.com/<owner>/<repo>/issues/<n>", "closesIssue": true }   → renders "Fixes <url>", closes it on merge\n' +
                '  { "url": "https://github.com/<owner>/<repo>/issues/<n>", "closesIssue": false }  → renders "Part of <url>", leaves it open\n\n' +
                `Then re-run: ${retryCommand}`,
        );
    }

    /** Does the declared `url` back `reference` (a URL, `#N` or `owner/repo#N`)? */
    private backs(url: string, reference: string): boolean {
        const declared = this.normalizeUrl(url);
        if (/^https?:\/\//i.test(reference)) return this.normalizeUrl(reference) === declared;
        const hash = reference.indexOf('#');
        const number = reference.slice(hash + 1);
        const repo = reference.slice(0, hash).toLowerCase();
        const path = repo === '' ? '' : `/${repo}`;
        return new RegExp(`${this.escape(path)}/(issues|pull)/${number}$`).test(declared);
    }

    private normalizeUrl(url: string): string {
        return url.trim().replace(/\/+$/, '').toLowerCase();
    }

    // A reference at the end of a sentence carries its period or comma; neither is part of it.
    private trimTrailingPunctuation(text: string): string {
        return text.replace(/[.,;:!?'"]+$/, '');
    }

    private escape(text: string): string {
        return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
}
