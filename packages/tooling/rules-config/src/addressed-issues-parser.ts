import { AddressedIssue } from './review-json-data';

/**
 * Validates summary.json's REQUIRED `addressesIssues` array (issue #1310) and narrows it to
 * {@link AddressedIssue}s. Every problem is APPENDED to the caller's error list rather than thrown, so the
 * author gets every summary.json error in one message, the way loadSummaryJson reports all its fields.
 *
 * Required, not optional-but-validated: an omitted array is a refusal, and `[]` is how an author states
 * "this PR addresses no tracked issue". The same no-default reasoning as each entry's `closesIssue` — an
 * absent field would otherwise mean "no ticket", a decision nobody was asked to make
 * (.claude/rules/no-rule-defaults.md).
 */
export class AddressedIssuesParser {
    // webpieces-disable no-any-unknown -- the opaque parsed summary.json value, narrowed field by field here
    parse(value: unknown, errors: string[]): AddressedIssue[] {
        if (value === undefined) {
            errors.push(
                '"addressesIssues" is REQUIRED: an array of {"url": "https://…", "closesIssue": true|false}, one per ticket ' +
                    'this PR addresses. Write [] when it addresses no tracked issue.',
            );
            return [];
        }
        if (!Array.isArray(value)) {
            errors.push(`"addressesIssues" must be an array of {"url", "closesIssue"} entries, got ${JSON.stringify(value)}.`);
            return [];
        }
        const issues: AddressedIssue[] = [];
        // webpieces-disable no-any-unknown -- element of an opaque JSON array, narrowed by parseEntry
        value.forEach((entry: unknown, index: number): void => {
            const issue = this.parseEntry(entry, index, errors);
            if (issue !== null) issues.push(issue);
        });
        this.reportDuplicates(issues, errors);
        return issues;
    }

    // webpieces-disable no-any-unknown -- one opaque JSON array element
    private parseEntry(entry: unknown, index: number, errors: string[]): AddressedIssue | null {
        const label = `addressesIssues[${index}] ${JSON.stringify(entry)}`;
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
            errors.push(`${label} must be an object {"url": "https://…", "closesIssue": true|false}.`);
            return null;
        }
        // webpieces-disable no-any-unknown -- opaque JSON object; each key is narrowed below
        const record = entry as Record<string, unknown>;
        const url = record['url'];
        const closes = record['closesIssue'];
        const urlError = this.urlError(url);
        if (urlError !== '') errors.push(`${label}: ${urlError}`);
        if (typeof closes !== 'boolean') {
            errors.push(
                `${label}: "closesIssue" must be true or false, and there is no default. true renders "Fixes <url>" and ` +
                    'CLOSES the issue when this PR merges; false renders "Part of <url>" and leaves it open (use false when ' +
                    'more PRs are still owed on that ticket).',
            );
        }
        if (urlError !== '' || typeof closes !== 'boolean') return null;
        return new AddressedIssue((url as string).trim(), closes);
    }

    // webpieces-disable no-any-unknown -- the opaque `url` JSON value
    private urlError(url: unknown): string {
        if (typeof url !== 'string' || url.trim() === '') {
            return '"url" must be the issue\'s absolute https:// URL (GitHub, Linear, Jira — any tracker), e.g. "https://github.com/<owner>/<repo>/issues/<n>".';
        }
        const trimmed = url.trim();
        if (!URL.canParse(trimmed) || new URL(trimmed).protocol !== 'https:' || new URL(trimmed).host === '') {
            return `"url" must be an absolute https:// URL, got ${JSON.stringify(url)}. A bare "#123" is not accepted — write the issue's full URL.`;
        }
        return '';
    }

    private reportDuplicates(issues: readonly AddressedIssue[], errors: string[]): void {
        const seen = new Set<string>();
        for (const issue of issues) {
            if (seen.has(issue.url)) errors.push(`addressesIssues lists ${issue.url} more than once — keep exactly one entry per issue.`);
            seen.add(issue.url);
        }
    }
}
