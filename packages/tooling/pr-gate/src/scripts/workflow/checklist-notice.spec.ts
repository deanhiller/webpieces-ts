import { describe, it, expect } from 'vitest';
import { ChecklistNotice } from './checklist-notice';

const notice = new ChecklistNotice();

// There is exactly ONE place checklists are configured (the pr-gate.checklists array), so the notice takes a
// count — no "which source" to disambiguate any more, and no command to name (see below).
const noneConfigured = (): string => notice.build(0);
const noneMatched = (count: number): string => notice.build(count);

// The whole point of this class: 0 checklists is a SUPPORTED state, not a failure to be argued with.
describe('zero checklists is never presented as a blocker', () => {
    const all = (): string[] => [
        noneConfigured(),
        noneMatched(3),
    ];

    it('every variant gives the all-clear', () => {
        for (const text of all()) {
            expect(text).toContain('valid state');
            expect(text).toContain('not a blocker');
        }
    });

    // The bug this replaced: the notice signed off with "Carry on and run: pnpm wp-finish-upsert-pr" while
    // the block printed under it asked for review.json FIRST. Naming a command here is what made the output
    // self-contradicting, so no variant may name one at all — ReviewReport owns the single next step.
    it('names NO command to run — the one next step is printed once, by ReviewReport', () => {
        for (const text of all()) {
            expect(text).not.toContain('wp-finish-upsert-pr');
            expect(text).not.toContain('pnpm ');
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

    // ORDER IS THE FEATURE. The how-to used to open the block, so a repo with no checklists read as a repo
    // with a problem until you scrolled ~10 lines to the all-clear. Verdict first, tutorial after.
    it('leads with the all-clear and puts the configuration how-to BELOW it', () => {
        const text = noneConfigured();
        expect(text.indexOf('✅')).toBeGreaterThanOrEqual(0);
        expect(text.indexOf('✅')).toBeLessThan(text.indexOf('webpieces.config.json'));
    });

    it('reaches the all-clear within the first few lines, not after a config tutorial', () => {
        const lines = noneConfigured().split('\n');
        const allClearLine = lines.findIndex((l: string): boolean => l.includes('✅'));
        expect(allClearLine).toBeGreaterThanOrEqual(0);
        expect(allClearLine).toBeLessThanOrEqual(2);
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

    it('gives the all-clear before explaining why nothing matched', () => {
        const text = noneMatched(3);
        expect(text.indexOf('✅')).toBeLessThan(text.indexOf('None of their path patterns'));
    });
});
