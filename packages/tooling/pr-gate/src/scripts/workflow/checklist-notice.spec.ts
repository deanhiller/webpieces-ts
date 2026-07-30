import { describe, it, expect } from 'vitest';
import { ChecklistDefinition, ChecklistSource } from '@webpieces/rules-config';
import { ChecklistNotice } from './checklist-notice';

const notice = new ChecklistNotice();
const FINISH = 'wp-finish-upsert-pr';

// The legacy manifest-doc source and the primary array-in-config source, so every variant is exercised
// against both — the notice must name whichever one the repo actually used.
const DOC_SOURCE = new ChecklistSource([], '.claude/review/index.md');
const ARRAY_SOURCE = new ChecklistSource([new ChecklistDefinition('r', 'r', '', ['**/*.sql'])], '');

const noneConfigured = (): string => notice.build(new ChecklistSource(), [], 0, FINISH);
const misconfigured = (errors: string[], source = DOC_SOURCE): string => notice.build(source, errors, 0, FINISH);
const emptyManifest = (): string => notice.build(DOC_SOURCE, [], 0, FINISH);
const noneMatched = (count: number, source = DOC_SOURCE): string => notice.build(source, [], count, FINISH);

// The whole point of this class: 0 checklists is a SUPPORTED state, not a failure to be argued with.
describe('zero checklists is never presented as a blocker', () => {
    const all = (): string[] => [
        noneConfigured(),
        misconfigured(['[pr-gate] checklists.doc "x.md" does not exist']),
        emptyManifest(),
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
        expect(text).not.toContain('MISCONFIGURED');
        expect(text).not.toContain('⚠️');
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

describe('configured but broken — the case that used to enforce nothing, silently', () => {
    it('is the only loud variant, and reproduces each validator error verbatim', () => {
        const errors = [
            '[pr-gate] checklists.doc "nope.md" does not exist — it must be a markdown doc carrying a manifest.',
            '[pr-gate] duplicate subagent "db-reviewer"',
        ];
        const text = misconfigured(errors);
        expect(text).toContain('⚠️');
        expect(text).toContain('MISCONFIGURED');
        expect(text).toContain('NO');
        for (const e of errors) expect(text).toContain(e);
    });

    it('still does not block — a broken doc is reported, not enforced', () => {
        expect(misconfigured(['[pr-gate] boom'])).toContain('pnpm wp-finish-upsert-pr');
    });

    it('takes precedence over the none-configured wording when a doc is set', () => {
        expect(misconfigured(['[pr-gate] boom'])).not.toContain('NONE CONFIGURED');
    });

    // A reader has to know WHICH file to open, and that differs by shape.
    it('names the source that is broken — the doc path, or the config key for the array shape', () => {
        expect(misconfigured(['[pr-gate] boom'])).toContain('.claude/review/index.md');
        expect(misconfigured(['[pr-gate] boom'], ARRAY_SOURCE)).toContain('pr-gate.checklists in webpieces.config.json');
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

    it('a readable doc that defines nothing usable is distinguished from one that matched nothing', () => {
        expect(emptyManifest()).toContain('0 defined');
        expect(emptyManifest()).not.toContain('0 matched');
    });

    it('names the array-in-config source when that is where the checklists came from', () => {
        expect(noneMatched(2, ARRAY_SOURCE)).toContain('pr-gate.checklists in webpieces.config.json');
    });
});
