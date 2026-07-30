import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { BriefedFile, ContextEntry, ReviewerBriefing, ReviewerInstructionsService } from './reviewer-instructions';
import { ReviewJsonService } from './review-json';

const svc = new ReviewerInstructionsService(new ReviewJsonService());

function briefing(): ReviewerBriefing {
    const b = new ReviewerBriefing('db-reviewer', 'db-reviewer', '/repo');
    b.docPath = '/repo/.claude/review/db.md';
    b.diffDir = '/repo/.webpieces/pr-review/feat/diff';
    b.allDiffPath = '/repo/.webpieces/pr-review/feat/diff/ALL.diff';
    b.manifestPath = '/repo/.webpieces/pr-review/feat/diff/manifest.json';
    b.myFiles = [new BriefedFile('db/001.sql', '/repo/.webpieces/pr-review/feat/diff/files/db__001.sql.diff')];
    b.matchedPatterns = ['db/**/*.sql'];
    b.sourceDirs = ['/repo/db'];
    b.verdictPath = '/repo/.webpieces/pr-review/feat/review-db-reviewer.json';
    b.fileDiffCommand = 'git diff abc123 def456 -- <file>';
    return b;
}

describe('ReviewerInstructionsService — the file that replaces context archaeology', () => {
    it('names the reviewer, its doc, its diff, its source dirs and its verdict file', () => {
        const md = svc.render(briefing());
        expect(md).toContain('# You are `db-reviewer`');
        expect(md).toContain('/repo/.claude/review/db.md');
        expect(md).toContain('/repo/.webpieces/pr-review/feat/diff/ALL.diff');
        expect(md).toContain('/repo/.webpieces/pr-review/feat/diff/files/db__001.sql.diff');
        expect(md).toContain('/repo/db');
        expect(md).toContain('/repo/.webpieces/pr-review/feat/review-db-reviewer.json');
    });

    /**
     * The verdict schema is GENERATED, with this reviewer's own id already substituted.
     *
     * This is the fix for a real failure: when `success` was replaced by the tri-state `status`,
     * hand-written `.claude/agents/*.md` files kept documenting `success`, and a live PR had to carry
     * "the verdict format in your own agent .md file is OUT OF DATE" in its spawn prompt to work around it.
     * Nothing restated by hand can drift if nothing is restated by hand.
     */
    it('generates the verdict schema with the id filled in, and never mentions the removed `success`', () => {
        const md = svc.render(briefing());
        expect(md).toContain('"id": "db-reviewer"');
        expect(md).toContain('"status"');
        expect(md).toContain('green');
        expect(md).toContain('yellow');
        expect(md).not.toContain('"success"');
    });

    // Every path must be ABSOLUTE: a subagent's working directory is not guaranteed to be the repo root,
    // and a relative path that fails to resolve turns straight back into a search.
    it('emits no repo-relative paths for the things it points at', () => {
        const md = svc.render(briefing());
        expect(md).not.toContain('](.webpieces/');
        expect(md).not.toContain('`.claude/review/db.md`');
        expect(md).toContain('`/repo/.claude/review/db.md`');
    });

});

// Split out to keep each describe under the method-length limit.
describe('ReviewerInstructionsService — pre-resolved context and scope wording', () => {
    /**
     * The section aimed at the measured failure: one reviewer spent three separate greps into
     * `node_modules/@webpieces` locating a scanner. An unresolvable entry is REPORTED, never dropped — a
     * silently shorter list is indistinguishable from a complete one.
     */
    it('lists pre-resolved context, and says so when an entry could not be resolved', () => {
        const b = briefing();
        b.contextEntries = [
            new ContextEntry('@webpieces/rules-config — shared config', '/repo/node_modules/@webpieces/rules-config'),
            new ContextEntry('queue names', '', '(configured as "terraform/" but missing)'),
        ];
        const md = svc.render(b);
        expect(md).toContain('/repo/node_modules/@webpieces/rules-config');
        expect(md).toContain('configured as "terraform/" but missing');
    });

    it('tells the reviewer NOT to go hunting, which is the point of the section above it', () => {
        const md = svc.render(briefing());
        expect(md).toContain('Do NOT search `node_modules`');
        expect(md).toContain('name it in `output`');
    });

    // A dirty diff must SAY it is dirty. A reviewer judging uncommitted work should know that is what it is.
    it('warns when the diff includes uncommitted work, and stays quiet when it does not', () => {
        const clean = svc.render(briefing());
        expect(clean).not.toContain('INCLUDES uncommitted');
        const b = briefing();
        b.dirty = true;
        expect(svc.render(b)).toContain('INCLUDES uncommitted');
    });

    /**
     * A patternless checklist is NOT "matched" — it always runs, over the whole diff. Calling that a match
     * would tell the reviewer its scope had been narrowed for it when nothing had been.
     */
    it('distinguishes ALL-in-scope from a pattern match', () => {
        const b = briefing();
        b.matchedPatterns = [];
        expect(svc.render(b)).toContain('ALL 1 changed file(s)');
        expect(svc.render(briefing())).toContain('`db/**/*.sql`');
    });

    it('places the instructions file beside review.json, under instructions/', () => {
        expect(svc.pathFor('/repo', 'feat', 'db-reviewer'))
            .toBe(path.join('/repo', '.webpieces', 'pr-review', 'feat', 'instructions', 'db-reviewer.instructions.md'));
    });

    // A checklist with no guidance doc still gets a coherent file, rather than a dangling "read: ".
    it('handles a checklist with no doc without emitting an empty path', () => {
        const b = briefing();
        b.docPath = '';
        const md = svc.render(b);
        expect(md).toContain('no guidance doc');
        expect(md).not.toContain('Read this FIRST: ``');
    });
});
