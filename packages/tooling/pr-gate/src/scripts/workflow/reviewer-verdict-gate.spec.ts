import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    AuthorizedOverrides, ChecklistInstructionsService, ChecklistReviewContext, RequiredChecklist,
    ReviewJsonService, toError,
} from '@webpieces/rules-config';
import { ChecklistRoster } from './checklist-detector';
import { ChecklistScan } from './checklist-scanner';
import { ReviewerVerdictGate } from './reviewer-verdict-gate';

const svc = new ReviewJsonService();
const gate = new ReviewerVerdictGate(svc, new ChecklistInstructionsService(svc));

// The imperative that must NOT appear for a checklist that already answered — the literal line an agent
// obeys, which is what re-spawned an already-refused reviewer and cost a full subagent run per loop.
const SPAWN_IMPERATIVE = 'You MUST run these';

const DB = new RequiredChecklist('db-reviewer', 'db-reviewer', '', ['db/001.sql'], ['**/*.sql']);
const OPS = new RequiredChecklist('ops-reviewer', 'ops-reviewer', '', ['Dockerfile'], ['**/Dockerfile']);

function reviewDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'wp-verdict-'));
}

function reviewPathIn(dir: string): string {
    return path.join(dir, 'review.json');
}

function writeVerdict(dir: string, id: string, status: string, output: string, override = ''): void {
    fs.writeFileSync(svc.checklistResultPath(reviewPathIn(dir), id),
        JSON.stringify({ id, status, output, override }));
}

/**
 * A scan over REAL verdict files on disk, assembled the way ChecklistScanner assembles one — results loaded
 * through ReviewJsonService and `outstanding` derived from them — so the fixture cannot drift from what the
 * scanner actually hands the gate. Git is not involved: nothing the gate does depends on the diff.
 */
function scanOver(dir: string, applicable: RequiredChecklist[]): ChecklistScan {
    const reviewPath = reviewPathIn(dir);
    const results = svc.loadChecklistResults(reviewPath, applicable);
    // The optional-without-a-verdict subtraction is part of how `outstanding` is BUILT (ChecklistScanner
    // owns it, so the gate needs no optional-awareness of its own). Reproduced here for the same reason the
    // rest of this fixture is: a scan assembled differently from the real one tests a gate nobody runs.
    // No human has authorized anything in this fixture — these tests are about how a REFUSAL reads.
    const authorized = new AuthorizedOverrides();
    const optionalNotRun = svc.optionalWithoutVerdict(applicable, results, authorized);
    const skipped = new Set(optionalNotRun.map((r: RequiredChecklist): string => r.id));
    const outstanding = svc.pendingChecklists(applicable, results, authorized)
        .filter((r: RequiredChecklist): boolean => !skipped.has(r.id));
    return new ChecklistScan(
        [], applicable, [], outstanding,
        new ChecklistReviewContext(), reviewPath, 'abc1234',
        new ChecklistRoster([], 1, true), svc.checklistFormatErrors(applicable, results, authorized),
        undefined, [], results, optionalNotRun, authorized,
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

    it('tells the reader to fix the finding and get a fresh verdict, with a human-override escape hatch', () => {
        const dir = reviewDir();
        writeVerdict(dir, 'db-reviewer', 'red', 'gate 1 failed');
        const msg = refusalOf(dir, [DB]);
        expect(msg).toContain('review again');
        expect(msg).toContain('A FRESH review-db-reviewer.json is now required');
        // The escape hatch is the HUMAN-ONLY mint, named as such: an agent that reads this must go ASK,
        // not write the override field itself. Pinning the exact commands is the point — the old wording
        // ("set a human-authored override") pointed at a file the agent could write.
        expect(msg).toContain('pnpm wp-authorize --checklist db-reviewer');
        expect(msg).toContain('pnpm wp-check-auth --checklist db-reviewer');
        expect(msg).not.toContain('human-authored "override"');
    });
});

/**
 * The DURABLE half (see backlog/bug-per-checklist-verdict-files-are-overwritten-with-no-archive…). The point
 * is the MOVE: a red left on the live path is re-read as the current state, and the eventual fix overwrites
 * the only record that the gate ever refused anything.
 */
describe('the refused verdict is RETIRED, one slot back', () => {
    it('moves the red verdict to review-<id>.json.old and leaves no live verdict', () => {
        const dir = reviewDir();
        writeVerdict(dir, 'db-reviewer', 'red', 'first refusal');
        const msg = refusalOf(dir, [DB]);
        const live = svc.checklistResultPath(reviewPathIn(dir), 'db-reviewer');
        const archived = svc.oldChecklistResultPath(reviewPathIn(dir), 'db-reviewer');
        expect(fs.existsSync(live)).toBe(false);
        expect(fs.readFileSync(archived, 'utf8')).toContain('first refusal');
        // Naming the archive is what keeps the move from reading as data loss.
        expect(msg).toContain(archived);
    });

    it('OVERWRITES the archive on a second red-then-refuse cycle — one slot, never a .old.old series', () => {
        const dir = reviewDir();
        writeVerdict(dir, 'db-reviewer', 'red', 'first refusal');
        refusalOf(dir, [DB]);
        writeVerdict(dir, 'db-reviewer', 'red', 'second refusal');
        refusalOf(dir, [DB]);
        const archived = svc.oldChecklistResultPath(reviewPathIn(dir), 'db-reviewer');
        expect(fs.readFileSync(archived, 'utf8')).toContain('second refusal');
        expect(fs.readFileSync(archived, 'utf8')).not.toContain('first refusal');
        expect(fs.existsSync(`${archived}.old`)).toBe(false);
        expect(fs.readdirSync(dir).filter((f: string): boolean => f.endsWith('.old'))).toHaveLength(1);
    });

    // The case reuse depends on: stage ② prints "already reviewed on this branch (reusing its
    // review-<id>.json)", and retiring a passing verdict would force a needless subagent re-run.
    it('leaves a GREEN verdict completely untouched', () => {
        const dir = reviewDir();
        writeVerdict(dir, 'db-reviewer', 'green', 'looks fine');
        const live = svc.checklistResultPath(reviewPathIn(dir), 'db-reviewer');
        const before = fs.readFileSync(live, 'utf8');
        expect(refusalOf(dir, [DB])).toBe('');                       // nothing outstanding ⇒ no throw at all
        expect(fs.readFileSync(live, 'utf8')).toBe(before);
        expect(fs.existsSync(svc.oldChecklistResultPath(reviewPathIn(dir), 'db-reviewer'))).toBe(false);
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
        expect(spawnSection).toContain('You MUST run these 1 reviewer subagent(s)');
    });

    it('lists ONLY the refused checklist under the refusal section', () => {
        const msg = mixedMessage();
        const refusedSection = msg.slice(msg.indexOf('⛔ REFUSED'), msg.indexOf('❓ NO VERDICT YET'));
        expect(refusedSection).toContain('db-reviewer');
        expect(refusedSection).not.toContain('ops-reviewer');
    });
});

/**
 * OPTIONAL checklists at the gate. The asymmetry these pin is the whole feature: not running one is fine,
 * ignoring one you ran is not.
 */
describe('optional checklists — declined is fine, refused is not', () => {
    const OPT = new RequiredChecklist(
        'ops-reviewer', 'ops-reviewer', '', ['Dockerfile'], ['**/Dockerfile'], false);

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
