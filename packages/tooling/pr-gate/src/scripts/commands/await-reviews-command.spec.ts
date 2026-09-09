import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach } from 'vitest';
import { RequiredChecklist, ReviewJsonService } from '@webpieces/rules-config';

import { ReviewerWaitProbe } from './await-reviews-command';
import { WaitOutcome } from '../workflow/await-loop';

let dir = '';
let reviewPath = '';

beforeEach((): void => {
    dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'await-reviews-'));
    reviewPath = path.join(dir, 'review.json');
});

function checklist(id: string, required = true): RequiredChecklist {
    return new RequiredChecklist(id, `${id}-agent`, `.claude/review/${id}.md`, [], [], required);
}

function writeVerdict(id: string, status: string, output: string): void {
    fs.writeFileSync(path.join(dir, `review-${id}.json`), JSON.stringify({ agent: 'claude', model: 'opus', id, status, output }));
}

function probe(waitedOn: RequiredChecklist[], applicable: RequiredChecklist[] = waitedOn): ReviewerWaitProbe {
    return new ReviewerWaitProbe(new ReviewJsonService(), reviewPath, waitedOn, applicable);
}

/**
 * ══ WHY THIS COMMAND EXISTS ════════════════════════════════════════════════════════════════════════
 *
 * `Monitor` does not block and the harness refuses one carrying a polling loop, so the measured fallback
 * is `echo .` every three seconds at ~557k tokens a turn (issue #874). A blocking Bash call is the only
 * wait an isolated subagent can express when NOTHING pending would wake it.
 *
 * When something IS pending, ending the turn is cheaper and this command is the second choice: a
 * subagent that has spawned reviewers is re-invoked when they finish — 449 measured resumptions, 288 of
 * them on exactly this wait (issue #878).
 */
describe('ReviewerWaitProbe waits on exactly what finish blocks on', () => {
    it('is not done while a verdict is missing', () => {
        const p = probe([checklist('a'), checklist('b')]);
        writeVerdict('a', 'green', 'looks fine');
        expect(p.done()).toBe(false);
        expect(p.describe()).toBe('1 of 2 verdicts in');
    });

    it('is done once every awaited verdict has landed', () => {
        const p = probe([checklist('a'), checklist('b')]);
        writeVerdict('a', 'green', 'looks fine');
        writeVerdict('b', 'red', 'shim in Foo.ts line 12');
        expect(p.done()).toBe(true);
    });

    /**
     * A RED verdict is a completed review, so the wait ENDS on it. Judging it is
     * `wp-finish-upsert-pr`'s job and stays there — a waiter that kept waiting for a reviewer to change
     * its mind would never return.
     */
    it('ends on a red verdict rather than waiting for it to turn green', () => {
        const p = probe([checklist('a')]);
        writeVerdict('a', 'red', 'shim in Foo.ts line 12');
        expect(p.done()).toBe(true);
        const report = p.verdictReport(new WaitOutcome(true, 12_000));
        expect(report).toContain('🔴');
        expect(report).toContain('shim in Foo.ts line 12');
        expect(report).toContain('REFUSED');
    });

    it('prints a green verdict without repeating its output, which is already on the PR', () => {
        const p = probe([checklist('a')]);
        writeVerdict('a', 'green', 'a very long reviewer essay nobody needs twice');
        p.done();
        const report = p.verdictReport(new WaitOutcome(true, 4_000));
        expect(report).toContain('🟢');
        expect(report).not.toContain('very long reviewer essay');
        expect(report).toContain('Nothing is owed');
    });

    /**
     * An OPTIONAL checklist nobody ran is never going to get a verdict, so waiting for one would never
     * end. It is excluded from the WAIT and still listed in the REPORT — a shorter list would let it
     * read as though everything passed.
     */
    it('does not wait for an optional checklist nobody ran, but still reports it', () => {
        const waited = [checklist('a')];
        const p = probe(waited, [checklist('a'), checklist('opt', false)]);
        writeVerdict('a', 'green', 'fine');
        expect(p.done()).toBe(true);
        const report = p.verdictReport(new WaitOutcome(true, 1_000));
        expect(report).toContain('opt');
        expect(report).toContain('❓');
    });
});

describe('ReviewerWaitProbe timeout report', () => {
    it('names the command to run again and says it is not a failure', () => {
        const p = probe([checklist('a'), checklist('b')]);
        writeVerdict('a', 'green', 'fine');
        p.done();
        const text = p.stillWaitingReport(new WaitOutcome(false, 540_000));
        expect(text).toContain('pnpm wp-await-reviews');
        expect(text).toContain('not a failure');
        expect(text).toContain('1 of 2 still owe a verdict: b');
    });
});
