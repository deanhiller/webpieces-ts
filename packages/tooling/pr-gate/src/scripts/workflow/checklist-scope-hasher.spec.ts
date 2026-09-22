import { describe, it, expect } from 'vitest';
import { ReviewJsonService } from '@webpieces/rules-config';
import { ChecklistScopeHasher } from './checklist-scope-hasher';
import { DiffMaterializer } from './diff-materializer';

const hasher = new ChecklistScopeHasher(new DiffMaterializer(new ReviewJsonService()));

function patch(index: string, hunk: string, body: string): string {
    return `diff --git a/a.sql b/a.sql\nindex ${index} 100644\n--- a/a.sql\n+++ b/a.sql\n${hunk}\n${body}\n`;
}

/**
 * The hash decides whether a green verdict CARRIES (issue #863), so it must move exactly when what a
 * reviewer judged moved — not when git's bookkeeping around the same change does.
 */
describe('ChecklistScopeHasher — what counts as the in-scope diff changing', () => {
    it('ignores blob ids and hunk line numbers, which a merge from main shifts without changing the change', () => {
        const before = new Map([['a.sql', patch('1111111..2222222', '@@ -1,2 +1,3 @@', '+GRANT ALL;')]]);
        const after = new Map([['a.sql', patch('3333333..4444444', '@@ -40,2 +40,3 @@', '+GRANT ALL;')]]);
        expect(hasher.hashOf(['a.sql'], before)).toBe(hasher.hashOf(['a.sql'], after));
    });

    it('moves when an added line changes', () => {
        const before = new Map([['a.sql', patch('1..2', '@@ -1 +1 @@', '+GRANT ALL;')]]);
        const after = new Map([['a.sql', patch('1..2', '@@ -1 +1 @@', '+GRANT SELECT;')]]);
        expect(hasher.hashOf(['a.sql'], before)).not.toBe(hasher.hashOf(['a.sql'], after));
    });

    it('moves when a NEW file comes into scope', () => {
        const byFile = new Map([['a.sql', patch('1..2', '@@ -1 +1 @@', '+x')], ['b.sql', patch('1..2', '@@ -1 +1 @@', '+y')]]);
        expect(hasher.hashOf(['a.sql'], byFile)).not.toBe(hasher.hashOf(['a.sql', 'b.sql'], byFile));
    });
});
