import { describe, it, expect } from 'vitest';
import { ChecklistDefinition, DiffScope, ReviewerAgentPolicy } from '@webpieces/rules-config';
import { PrGateFeature } from '../../__tests__/feature-harness';
import { ChecklistDetector, TriggeredChecklist } from './checklist-detector';

const detector = new ChecklistDetector(new DiffScope());

// id + doc + patterns + required configurable, all reviewed by one shared agent type (issue #938).
// `required` defaults to true because that is the blocking behavior every test here predates the flag
// with; the optional path says false explicitly.
const REVIEWER = new ReviewerAgentPolicy('webpieces-reviewer', 2);

function def(id = 'migrations-reviewer', patterns: string[] = ['**/*.sql'], required = true): ChecklistDefinition {
    return new ChecklistDefinition(id, REVIEWER, `.claude/review/${id}.md`, patterns, required);
}

describe('ChecklistDetector.detect', () => {
    it('matches a checklist on a changed file hitting its patterns', () => {
        const triggered = detector.detect([def()], ['db/001.sql', 'src/a.ts']);
        expect(triggered).toHaveLength(1);
        expect(triggered[0].matchedFiles).toEqual(['db/001.sql']);
    });

    it('does not match when no changed file hits the patterns', () => {
        expect(detector.detect([def()], ['src/a.ts', 'README.md'])).toEqual([]);
    });

    it('empty patterns match EVERY changed file (always runs)', () => {
        const d = def('always-reviewer', []);
        const triggered = detector.detect([d], ['src/a.ts', 'README.md']);
        expect(triggered).toHaveLength(1);
        expect(triggered[0].matchedFiles).toEqual(['src/a.ts', 'README.md']);
    });

    it('is extension-agnostic — non-.ts files match (the tsOnly trap is in detectForRange)', () => {
        const d = def('deploy-reviewer', ['**/Dockerfile', '**/*.sql', '.env*']);
        const triggered = detector.detect([d], ['ops/Dockerfile', '.env.prod']);
        expect(triggered).toHaveLength(1);
        expect(triggered[0].matchedFiles).toEqual(['ops/Dockerfile', '.env.prod']);
    });

    // The printed instruction says WHAT matched, so a reviewer can weigh a precise glob against a blanket
    // one. Only the globs that actually fired are reported — not the checklist's whole pattern list.
    it('records only the patterns that actually hit a changed file', () => {
        const d = def('deploy-reviewer', ['**/*.sql', 'terraform/**', '**/Dockerfile']);
        const triggered = detector.detect([d], ['db/1.sql', 'terraform/main.tf']);
        expect(triggered[0].matchedPatterns).toEqual(['**/*.sql', 'terraform/**']);
    });

    it('reports NO matched patterns for a patternless checklist (it runs on every PR)', () => {
        const triggered = detector.detect([def('always-reviewer', [])], ['a.ts']);
        expect(triggered[0].matchedPatterns).toEqual([]);
    });

    it('toRequired maps every matched checklist to the RequiredChecklist shape', () => {
        const required = detector.toRequired(detector.detect([def()], ['db/001.sql']));
        expect(required).toHaveLength(1);
        expect(required[0].id).toBe('migrations-reviewer');
        expect(required[0].reviewer).toBe(REVIEWER);
        expect(required[0].doc).toBe('.claude/review/migrations-reviewer.md');
        expect(required[0].matchedFiles).toEqual(['db/001.sql']);
        expect(required[0].matchedPatterns).toEqual(['**/*.sql']);
    });
});

// The roster is what the PR comment publishes: EVERY defined checklist, matched or not. `detect` is defined
// as the roster minus its empty entries, so the set that GATES and the set that gets REPORTED cannot be
// computed two different ways and drift.
describe('ChecklistDetector.roster', () => {
    it('returns one entry per DEFINED checklist, in config order, including the ones nothing hit', () => {
        const defs = [def('migrations-reviewer'), def('a11y-reviewer', ['apps/web/**']), def('always-reviewer', [])];
        const entries = detector.roster(defs, ['db/001.sql', 'src/a.ts']);
        expect(entries.map((t): string => t.def.id))
            .toEqual(['migrations-reviewer', 'a11y-reviewer', 'always-reviewer']);
        expect(entries[0].matchedFiles).toEqual(['db/001.sql']);
        expect(entries[1].matchedFiles).toEqual([]);                       // evaluated, did not apply
        expect(entries[2].matchedFiles).toEqual(['db/001.sql', 'src/a.ts']); // patternless ⇒ whole diff
    });

    // The trap a renderer must not fall into: a SKIPPED checklist and a PATTERNLESS one both fired zero
    // globs, and they mean opposite things ("nothing in scope" vs "everything in scope"). Only the
    // CONFIGURED list tells them apart.
    it('leaves a skipped checklist with no fired patterns even though it HAS configured ones', () => {
        const entries = detector.roster([def('a11y-reviewer', ['apps/web/**', '**/*.tsx'])], ['db/1.sql']);
        expect(entries[0].matchedPatterns).toEqual([]);
        expect(entries[0].matchedFiles).toEqual([]);
        expect(entries[0].def.patterns).toEqual(['apps/web/**', '**/*.tsx']); // the distinguishing signal
    });

    it('agrees with detect exactly — detect IS the roster minus its empty entries', () => {
        const defs = [def('migrations-reviewer'), def('a11y-reviewer', ['apps/web/**']), def('always-reviewer', [])];
        const files = ['db/001.sql', 'src/a.ts'];
        const nonEmpty = detector.roster(defs, files).filter((t): boolean => t.matchedFiles.length > 0);
        expect(detector.detect(defs, files)).toEqual(nonEmpty);
    });

    // With no fork point the changed-file set is EMPTY, so nothing matches — not even a patternless
    // ALWAYS-RUNS checklist. The roster still lists it; ChecklistRoster.baseResolved is what stops that
    // being published as an all-clear.
    it('lists a patternless checklist as matching nothing when there is no diff at all', () => {
        const entries = detector.roster([def('always-reviewer', [])], []);
        expect(entries).toHaveLength(1);
        expect(entries[0].matchedFiles).toEqual([]);
        expect(detector.detect([def('always-reviewer', [])], [])).toEqual([]);
    });
});

// One end-to-end pass through the shipped DAG against SCRIPTED git (#1381) — proves detectForRepo passes
// tsOnly:false, so a *.sql file is seen at all (the default would silently drop it and report "no
// checklists matched"). The proof is the argv: no `*.ts` pathspec reaches git.
describe('ChecklistDetector.detectForRepo (git integration)', () => {
    it('sees non-.ts changes (tsOnly:false) and matches by path', async () => {
        delete process.env['NX_BASE'];
        delete process.env['NX_HEAD'];
        const repo = '/repo';
        const feature = await PrGateFeature.create();
        // No origin/main in this repo; local main is the base the feature branch forked from.
        feature.git.respond(['merge-base', 'HEAD', 'origin/main'], feature.git.fail(128, 'fatal: Not a valid object name origin/main'));
        feature.git.respond(['merge-base', 'HEAD', 'main'], feature.git.ok('base-sha\n'));
        feature.git.respond(['diff', '--name-only', '--diff-filter=d', 'base-sha'], feature.git.ok('db/001.sql\n'));
        feature.git.respond(['ls-files', '--others', '--exclude-standard'], feature.git.ok(''));

        const triggered = await feature.container.get(ChecklistDetector).detectForRepo(repo, [def()]);
        expect(triggered.map((t: TriggeredChecklist): string => t.def.id)).toEqual(['migrations-reviewer']);
        expect(triggered[0].matchedFiles).toEqual(['db/001.sql']);
        expect(feature.git.commandLines().some((line: string): boolean => line.includes('*.ts'))).toBe(false);
    });
});
