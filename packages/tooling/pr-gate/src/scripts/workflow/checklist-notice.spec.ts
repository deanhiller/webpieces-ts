import { describe, it, expect } from 'vitest';
import { ChecklistNotice } from './checklist-notice';

const notice = new ChecklistNotice();
const FINISH = 'wp-finish-upsert-pr';

// There is exactly ONE place checklists are configured (the pr-gate.checklists array), so the notice takes a
// count + the validator's errors — no "which source" to disambiguate any more.
const noneConfigured = (): string => notice.build(0, FINISH);
const noneMatched = (count: number): string => notice.build(count, FINISH);

// The whole point of this class: 0 checklists is a SUPPORTED state, not a failure to be argued with.
describe('zero checklists is never presented as a blocker', () => {
    const all = (): string[] => [
        noneConfigured(),
        noneMatched(3),
    ];

    it('every variant says to continue, and names the finish command', () => {
        for (const text of all()) {
            expect(text).toContain('pnpm wp-finish-upsert-pr');
            expect(text).toContain('valid state');
            expect(text).toContain('not a blocker');
        }
    });

    it('no variant tells the reader to stop, fix first, or that the flow is blocked', () => {
        for (const text of all()) {
            expect(text).not.toMatch(/\byou must (add|configure|fix)\b/i);
            expect(text).not.toMatch(/\b(cannot|can not|will not|won't) (finish|continue|proceed)\b/i);
            expect(text).not.toMatch(/\bmust be (fixed|added|configured)\b/i);
            expect(text).not.toMatch(/\baborting\b|\brefus|\bblocked\b/i);
        }
    });
});

describe('no checklists configured at all', () => {
    it('says zero ran and that this is fine, without implying anything is broken', () => {
        const text = noneConfigured();
        expect(text).toContain('NONE CONFIGURED');
        expect(text).toContain('that is fine');
    });

    it('tells the human HOW to add checklists if they want them — the config array, patterns, and *.md docs', () => {
        const text = noneConfigured();
        expect(text).toContain('checklists');
        expect(text).toContain('.md');
        expect(text).toContain('webpieces.config.json');
        expect(text).toContain('patterns');
        expect(text).toContain('subagent');
    });

    // The how-to must teach the PRIMARY shape (the array in config), not the HTML-comment manifest a reader
    // can no longer schema, grep, or edit with tooling.
    it('teaches the array-in-config shape, not the HTML-comment manifest', () => {
        expect(noneConfigured()).not.toContain('webpieces:checklists');
    });
});

// There is deliberately no "misconfigured" variant left: checklists live only in pr-gate.checklists, and
// loadAndValidate validates that set (docs + reviewer agent files included), so a broken one throws before
// any command reaches ChecklistNotice. The tolerant manifest loader that made silent misconfiguration
// possible is gone.
describe('the silently-misconfigured state is now impossible, not merely reported', () => {
    it('has no misconfigured wording, because a broken set never reaches this class', () => {
        for (const text of [noneConfigured(), noneMatched(3)]) {
            expect(text).not.toContain('MISCONFIGURED');
            expect(text).not.toContain('⚠️');
        }
    });
});

describe('configured and valid, but nothing matched this diff', () => {
    it('reports how many exist so the human can judge whether zero matches is expected', () => {
        const text = noneMatched(3);
        expect(text).toContain('3 defined');
        expect(text).toContain('0 matched');
        expect(text).toContain('patterns');
        expect(text).not.toContain('⚠️');
    });

    it('names the config key so a human can check the patterns that did not fire', () => {
        expect(noneMatched(2)).toContain('pr-gate.checklists');
    });
});
