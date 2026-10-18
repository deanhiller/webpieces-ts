import { specTempDirs } from '@webpieces/tooling-testkit';
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { ReviewJsonService } from './review-json';
import { AddressedIssue } from './review-json-data';

const GITHUB = 'https://github.com/ctoteachings/monorepo/issues/955';
const LINEAR = 'https://linear.app/onetablet/issue/ONE-1234';

// webpieces-disable-next-line no-any-unknown -- spec fixture: opaque JSON value under test
function summaryWith(addressesIssues: unknown, omit = false): string {
    const dir = specTempDirs.make('wp-addresses-issues-');
    const file = path.join(dir, 'summary.json');
    // webpieces-disable-next-line no-any-unknown -- spec fixture: an AI-authored JSON object
    const raw: Record<string, unknown> = { title: 'T', agent: 'codex', model: 'unknown', riskScore: 1, riskLevel: 'green', summary: 's' };
    if (!omit) raw['addressesIssues'] = addressesIssues;
    fs.writeFileSync(file, JSON.stringify(raw));
    return file;
}

function load(file: string): AddressedIssue[] {
    return new ReviewJsonService().loadSummaryJson(file).addressesIssues;
}

describe('summary.json addressesIssues (issue #1310)', () => {
    it('accepts a GitHub issue URL', () => {
        expect(load(summaryWith([{ url: GITHUB, closesIssue: true }]))).toEqual([new AddressedIssue(GITHUB, true)]);
    });

    it('accepts a Linear issue URL — the field is tracker-agnostic', () => {
        expect(load(summaryWith([{ url: LINEAR, closesIssue: false }]))).toEqual([new AddressedIssue(LINEAR, false)]);
    });

    it('keeps a mixed true/false array in order', () => {
        const issues = load(summaryWith([{ url: GITHUB, closesIssue: false }, { url: LINEAR, closesIssue: true }]));
        expect(issues).toEqual([new AddressedIssue(GITHUB, false), new AddressedIssue(LINEAR, true)]);
    });

    it('accepts [] — the explicit statement that no tracked issue is addressed', () => {
        expect(load(summaryWith([]))).toEqual([]);
    });

    it('REQUIRES the array: an omitted addressesIssues is a refusal, never a default', () => {
        expect(() => load(summaryWith(undefined, true))).toThrowError(/"addressesIssues" is REQUIRED[\s\S]*Write \[\]/);
    });

    it('refuses an entry missing closesIssue, naming the entry and both meanings', () => {
        const file = summaryWith([{ url: GITHUB, closesIssue: true }, { url: LINEAR }]);
        expect(() => load(file)).toThrowError(new RegExp(`addressesIssues\\[1\\] \\{"url":"${LINEAR}"\\}: "closesIssue" must be true or false, and there is no default`));
        expect(() => load(file)).toThrowError(/"Fixes <url>"[\s\S]*"Part of <url>"/);
    });

    it('refuses a non-https URL, naming the entry', () => {
        const file = summaryWith([{ url: 'http://github.com/o/r/issues/1', closesIssue: true }]);
        expect(() => load(file)).toThrowError(/addressesIssues\[0\][\s\S]*must be an absolute https:\/\/ URL, got "http:\/\/github.com\/o\/r\/issues\/1"/);
    });

    it('refuses a bare "#123" and a missing url', () => {
        expect(() => load(summaryWith([{ url: '#123', closesIssue: true }]))).toThrowError(/A bare "#123" is not accepted/);
        expect(() => load(summaryWith([{ closesIssue: true }]))).toThrowError(/addressesIssues\[0\][\s\S]*"url" must be the issue's absolute https:\/\/ URL/);
    });

    it('refuses a non-array and a non-object entry', () => {
        expect(() => load(summaryWith('https://x.test/1'))).toThrowError(/"addressesIssues" must be an array/);
        expect(() => load(summaryWith([GITHUB]))).toThrowError(/addressesIssues\[0\] "https:[^"]*" must be an object/);
    });

    it('refuses the same URL twice', () => {
        const file = summaryWith([{ url: GITHUB, closesIssue: true }, { url: GITHUB, closesIssue: false }]);
        expect(() => load(file)).toThrowError(/lists https:\/\/github.com\/ctoteachings\/monorepo\/issues\/955 more than once/);
    });

    it('teaches addressesIssues in the printed schema hint', () => {
        const hint = new ReviewJsonService().summaryJsonSchemaHint('/x/summary.json');
        expect(hint).toContain('"addressesIssues"');
        expect(hint).toContain('"closesIssue": true');
        expect(hint).toContain('"Part of <url>"');
    });
});
