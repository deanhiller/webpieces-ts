import { specTempDirs } from '@webpieces/tooling-testkit';
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { ChecklistInstructionsService, ChecklistReviewContext, RequiredChecklist, REVIEWER_AGENTS_PLACEHOLDER, ReviewerAgentPolicy, ReviewJsonService } from '@webpieces/rules-config';
import { toError } from '@webpieces/tooling-common/to-error';
import { ChecklistRoster } from './checklist-detector';
import { ChecklistScan } from './checklist-scanner';
import { ReviewerVerdictGate } from './reviewer-verdict-gate';

const svc = new ReviewJsonService();
const gate = new ReviewerVerdictGate(svc, new ChecklistInstructionsService(svc));

// The imperative that must NOT appear for a checklist that already answered — the literal line an agent
// obeys, which is what re-spawned an already-refused reviewer and cost a full subagent run per loop.
const SPAWN_IMPERATIVE = 'You MUST run these';

const REVIEWER = new ReviewerAgentPolicy('webpieces-reviewer', REVIEWER_AGENTS_PLACEHOLDER);
const DB = new RequiredChecklist('db-reviewer', REVIEWER, '', ['db/001.sql'], ['**/*.sql']);
const OPS = new RequiredChecklist('ops-reviewer', REVIEWER, '', ['Dockerfile'], ['**/Dockerfile']);

function reviewDir(): string {
    return specTempDirs.make('wp-verdict-');
}

function reviewPathIn(dir: string): string {
    return path.join(dir, 'summary.json');
}

function writeVerdict(dir: string, id: string, status: string, output: string, round = 1): void {
    fs.writeFileSync(svc.checklistResultPath(reviewPathIn(dir), id, round),
        JSON.stringify({ agent: 'claude', model: 'opus', id, status, output }));
}

/**
 * A scan over REAL verdict files on disk, assembled the way ChecklistScanner assembles one — results loaded
 * through ReviewJsonService and `outstanding` derived from them — so the fixture cannot drift from what the
 * scanner actually hands the gate. Git is not involved: nothing the gate does depends on the diff.
 */
function scanOver(dir: string, applicable: RequiredChecklist[]): ChecklistScan {
    const summaryPath = reviewPathIn(dir);
    const results = svc.loadChecklistResults(summaryPath, applicable);
    // The optional-without-a-verdict subtraction is part of how `outstanding` is BUILT (ChecklistScanner
    // owns it, so the gate needs no optional-awareness of its own). Reproduced here for the same reason the
    // rest of this fixture is: a scan assembled differently from the real one tests a gate nobody runs.
    const optionalNotRun = svc.optionalWithoutVerdict(applicable, results);
    const skipped = new Set(optionalNotRun.map((r: RequiredChecklist): string => r.id));
    const outstanding = svc.pendingChecklists(applicable, results)
        .filter((r: RequiredChecklist): boolean => !skipped.has(r.id));
    return new ChecklistScan(
        [], applicable, [], outstanding,
        new ChecklistReviewContext(), summaryPath, 'abc1234',
        new ChecklistRoster([], 1, true), svc.checklistFormatErrors(applicable, results),
        false, [],
        undefined, [], results, optionalNotRun,
    );
}

// The refusal message, or '' if the gate let the PR through.
function refusalOf(dir: string, applicable: RequiredChecklist[]): string {
    // webpieces-disable no-unmanaged-exceptions -- the thrown message IS the assertion subject here
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        gate.assertEveryReviewerRan(scanOver(dir, applicable));
        return '';
    } catch (err: unknown) {
        const error = toError(err);
        return error.message;
    }
}

/**
 * THE regression (see backlog/bug-a-refused-reviewer-reads-as-one-that-never-ran…). Both halves are
 * asserted: quoting the finding is not enough on its own, because the loop-inducing spawn imperative could
 * still appear alongside it and an agent acts on the imperative.
 */
describe('a REFUSED checklist reads as a refusal, not as a reviewer that never ran', () => {
    it("quotes the reviewer's own output", () => {
        const dir = reviewDir();
        writeVerdict(dir, 'db-reviewer', 'red', 'gate 1: migration drops a column with no backfill');
        expect(refusalOf(dir, [DB])).toContain('gate 1: migration drops a column with no backfill');
    });

    it('never prints the "You MUST run these N reviewer subagent(s)" imperative for it', () => {
        const dir = reviewDir();
        writeVerdict(dir, 'db-reviewer', 'red', 'gate 1 failed');
        expect(refusalOf(dir, [DB])).not.toContain(SPAWN_IMPERATIVE);
    });

    it('counts refusals as refusals rather than as "no passing verdict yet"', () => {
        const dir = reviewDir();
        writeVerdict(dir, 'db-reviewer', 'red', 'gate 1 failed');
        const msg = refusalOf(dir, [DB]);
        expect(msg).toContain('1 REFUSED');
        expect(msg).not.toContain('have no passing verdict yet');
    });

    it('tells the reader to fix the finding and record the fix, with a human-override escape hatch', () => {
        const dir = reviewDir();
        writeVerdict(dir, 'db-reviewer', 'red', 'gate 1 failed');
        const msg = refusalOf(dir, [DB]);
        expect(msg).toContain('record it with pnpm wp-write-review-fixes');
        // The escape hatch is a SEPARATE file with a named writer, and the command that writes it is printed
        // ready to run — the whole point of the split. It must survive the trip through the gate, which is
        // the surface an agent actually reads.
        expect(msg).toContain('override-db-reviewer.json');
        expect(msg).toContain('COORDINATING agent');
        expect(msg).toContain("cat > ");
        expect(msg).not.toContain('human-authored "override"');
    });
});

/**
 * The DURABLE half (issue #1053). A refusal is never moved or deleted: every round's verdict is its own
 * `review-round<N>-<id>.json`, so the refusal survives the fix that the next round passes.
 */
describe('a refused verdict stays on disk as its round\'s record', () => {
    it('refuses without moving, renaming or deleting the red verdict', () => {
        const dir = reviewDir();
        writeVerdict(dir, 'db-reviewer', 'red', 'first refusal');
        const before = fs.readdirSync(dir).sort();
        expect(refusalOf(dir, [DB])).toContain('first refusal');
        expect(fs.readdirSync(dir).sort()).toEqual(before);
        expect(fs.readdirSync(dir).some((f: string): boolean => f.endsWith('.old'))).toBe(false);
    });

    it('the next round\'s green clears it, and the round-1 refusal is still there', () => {
        const dir = reviewDir();
        writeVerdict(dir, 'db-reviewer', 'red', 'first refusal', 1);
        writeVerdict(dir, 'db-reviewer', 'green', 'fixed', 2);
        expect(refusalOf(dir, [DB])).toBe('');
        expect(fs.readFileSync(svc.checklistResultPath(reviewPathIn(dir), 'db-reviewer', 1), 'utf8')).toContain('first refusal');
    });
});

/** ORANGE (issue #1053) — the final round's must-fix. Its only cure is a fix and a record of it, never a reviewer. */
describe('an ORANGE checklist reads as a final-round must-fix', () => {
    it('refuses with the finding, names wp-write-review-fixes, and never asks for a reviewer', () => {
        const dir = reviewDir();
        writeVerdict(dir, 'db-reviewer', 'orange', 'add the backfill before the NOT NULL');
        const msg = refusalOf(dir, [DB]);
        expect(msg).toContain('1 ORANGE');
        expect(msg).toContain('add the backfill before the NOT NULL');
        expect(msg).toContain('pnpm wp-write-review-fixes');
        expect(msg).toContain('Do NOT spawn a');
        expect(msg).not.toContain(SPAWN_IMPERATIVE);
        expect(msg).not.toContain('REFUSED');
    });

    it('lets the PR through once the fix is recorded (the scan folds it into the result)', () => {
        const dir = reviewDir();
        writeVerdict(dir, 'db-reviewer', 'orange', 'add the backfill');
        const scan = scanOver(dir, [DB]);
        scan.results[0].remediation = 'orange at aaaaaaaa, author-fixed in bbbbbbbb, not re-reviewed: backfilled';
        scan.outstanding = svc.pendingChecklists(scan.applicable, scan.results);
        expect((): void => gate.assertEveryReviewerRan(scan)).not.toThrow();
    });
});

describe('a checklist that genuinely never ran still gets the spawn instruction', () => {
    it('prints "You MUST run these …" when no verdict file exists', () => {
        const msg = refusalOf(reviewDir(), [DB]);
        expect(msg).toContain(SPAWN_IMPERATIVE);
        expect(msg).toContain('1 never ran');
    });
});

/**
 * Mixed is the case that proves the split rather than a swap: BOTH sections appear, and each lists only its
 * own checklist. A message that moved every checklist into the refusal section would pass every test above.
 */
describe('one refused + one never-ran ⇒ two sections, each listing only its own', () => {
    function mixedMessage(): string {
        const dir = reviewDir();
        writeVerdict(dir, 'db-reviewer', 'red', 'gate 1: no backfill');
        return refusalOf(dir, [DB, OPS]);
    }

    it('reports both, separately counted', () => {
        const msg = mixedMessage();
        expect(msg).toContain('1 REFUSED');
        expect(msg).toContain('1 never ran');
    });

    it('puts the refusal ABOVE the spawn instruction — the spawn line is the one an agent acts on first', () => {
        const msg = mixedMessage();
        expect(msg.indexOf('⛔ REFUSED')).toBeLessThan(msg.indexOf(SPAWN_IMPERATIVE));
    });

    it('lists ONLY the never-ran checklist under the spawn instruction', () => {
        const msg = mixedMessage();
        const spawnSection = msg.slice(msg.indexOf('❓ NO VERDICT YET'));
        expect(spawnSection).toContain('ops-reviewer');
        expect(spawnSection).not.toContain('db-reviewer');
        expect(spawnSection).toContain('You MUST run these 1 checklist review(s)');
        expect(spawnSection).toContain('using AT MOST 1 `webpieces-reviewer` subagent(s)');
    });

    it('lists ONLY the refused checklist under the refusal section', () => {
        const msg = mixedMessage();
        const refusedSection = msg.slice(msg.indexOf('⛔ REFUSED'), msg.indexOf('❓ NO VERDICT YET'));
        expect(refusedSection).toContain('db-reviewer');
        expect(refusedSection).not.toContain('ops-reviewer');
    });
});

/**
 * `commands.pr-gate.reviewerAgents` (issue #938): a grouped run is valid, so the never-ran section asks for
 * AT MOST N subagents over ONLY the checklists still owed — never one separate subagent each.
 */
describe('reviewerAgents — the never-ran section respects the cap', () => {
    const GROUPED = new ReviewerAgentPolicy('webpieces-reviewer', 1);
    const A = new RequiredChecklist('a', GROUPED, '', ['x'], ['**']);
    const B = new RequiredChecklist('b', GROUPED, '', ['x'], ['**']);
    const C = new RequiredChecklist('c', GROUPED, '', ['x'], ['**']);

    it('asks for at most one subagent over the owed checklists, not a separate one each', () => {
        const msg = refusalOf(reviewDir(), [A, B, C]);
        expect(msg).toContain('You MUST run these 3 checklist review(s) using AT MOST 1 `webpieces-reviewer` subagent(s)');
        expect(msg).not.toContain('SEPARATE');
    });

    it('a re-run lists ONLY the checklists still owed, under the same cap', () => {
        const dir = reviewDir();
        writeVerdict(dir, 'a', 'green', 'ok');
        writeVerdict(dir, 'b', 'green', 'ok');
        const msg = refusalOf(dir, [A, B, C]);
        const spawnSection = msg.slice(msg.indexOf('❓ NO VERDICT YET'));
        expect(spawnSection).toContain('these 1 checklist review(s) using AT MOST 1');
        expect(spawnSection).toContain('checklist c');
        expect(spawnSection).not.toContain('checklist a');
    });
});

/**
 * OPTIONAL checklists at the gate. The asymmetry these pin is the whole feature: not running one is fine,
 * ignoring one you ran is not.
 */
describe('optional checklists — declined is fine, refused is not', () => {
    const OPT = new RequiredChecklist(
        'ops-reviewer', REVIEWER, '', ['Dockerfile'], ['**/Dockerfile'], false);

    it('opens the PR when the only unreviewed checklist is an optional one nobody ran', () => {
        const dir = reviewDir();
        writeVerdict(dir, 'db-reviewer', 'green', 'ok');
        expect(refusalOf(dir, [DB, OPT])).toBe('');
    });

    it('opens the PR when EVERY checklist is optional and none of them ran', () => {
        expect(refusalOf(reviewDir(), [OPT])).toBe('');
    });

    it('REFUSES when that optional reviewer ran and said no — running one is not ignoring one', () => {
        const dir = reviewDir();
        writeVerdict(dir, 'db-reviewer', 'green', 'ok');
        writeVerdict(dir, 'ops-reviewer', 'red', 'container runs as root');
        const message = refusalOf(dir, [DB, OPT]);
        expect(message).toContain('container runs as root');
        expect(message).toContain('REFUSED');
        // Through the ONE refusal renderer — an optional refusal is not a second, softer wording.
        expect(message).not.toContain(SPAWN_IMPERATIVE);
    });

    // The gate's message is the one moment a human is looking at review state. A refusal that lists only
    // what blocked reads as "everything else was reviewed", which here would be false.
    it('names the optional reviews that did NOT run, while saying they are not what blocked', () => {
        const dir = reviewDir();
        const message = refusalOf(dir, [DB, OPT]);
        expect(message).toContain('Not blocking');
        expect(message).toContain('OPTIONAL checklist(s) were not run');
        expect(message).toContain('ops-reviewer');
        // ...and the thing that DID block is still the required one.
        expect(message).toContain('db-reviewer');
    });

    it('says nothing about skipped optional reviews when there are none', () => {
        expect(refusalOf(reviewDir(), [DB])).not.toContain('Not blocking');
    });
});

/**
 * ══ turnOffAllReviewers reaches THIS gate through the scan, and nowhere else ════════════════════════
 *
 * `wp-finish-upsert-pr` blocks on `scan.outstanding`, and ChecklistScanner is the ONE place the kill
 * switch is read — so a suppressed scan arrives here already owing nothing and this gate has no
 * flag-awareness of its own. That is the design being pinned: a second check in here would be a second
 * answer to "does this branch owe review?", free to disagree with the one stage ② printed.
 *
 * The fixture therefore builds the scan the SCANNER would build under suppression — every verdict-bearing
 * list empty, `reviewersDisabled` true — rather than mocking the home config, because what finish
 * actually sees is a ChecklistScan and nothing else.
 */
describe('a SUPPRESSED scan owes nothing, so finish does not block', () => {
    function suppressedScan(dir: string, suppressed: RequiredChecklist[]): ChecklistScan {
        return new ChecklistScan(
            [], [], [], [],
            new ChecklistReviewContext(), reviewPathIn(dir), 'abc1234',
            new ChecklistRoster([], 1, true), [],
            true, suppressed,
            undefined, [], [], [],
        );
    }

    it('lets the PR through even though a REQUIRED checklist matched and has no verdict', () => {
        const dir = reviewDir();
        expect((): void => gate.assertEveryReviewerRan(suppressedScan(dir, [DB]))).not.toThrow();
    });

    it('does not print the spawn imperative for reviewers that were switched off', () => {
        const dir = reviewDir();
        expect((): void => gate.assertEveryReviewerRan(suppressedScan(dir, [DB, OPS]))).not.toThrow();
    });

    // The control: the SAME checklist, not suppressed, still blocks. Suppression is the only difference,
    // so a green above can never be mistaken for the gate having stopped working.
    it('still blocks the identical checklist when it was NOT suppressed', () => {
        expect(refusalOf(reviewDir(), [DB])).toContain('db-reviewer');
    });
});
