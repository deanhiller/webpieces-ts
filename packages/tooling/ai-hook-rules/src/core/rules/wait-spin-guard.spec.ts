import { describe, it, expect, vi } from 'vitest';

import { BashContext, Violation } from '../types';
import { WaitSpinGuardRule, REPEATS_BEFORE_REFUSAL } from './wait-spin-guard';

// The decision log is a real filesystem append keyed off the tree, and these contexts name trees that do
// not exist. It swallows its own errors, but silencing it keeps the suite from touching disk at all.
type DecisionLogModule = typeof import('../decision-log');
vi.mock('../decision-log', async (importActual: () => Promise<DecisionLogModule>) => {
    const actual = await importActual();
    return { ...actual, logGuardDecision: (): void => undefined };
});

// The session call log is the only other I/O this guard does. Stubbing the COUNT rather than writing a
// log file keeps the poll tests about the guard's decision instead of about a log format.
let priorCalls = 0;
type HistoryModule = typeof import('../session-call-history');
vi.mock('../session-call-history', async (importActual: () => Promise<HistoryModule>) => {
    const actual = await importActual();
    class StubHistory extends actual.SessionCallHistory {
        priorBashCalls(): number {
            return priorCalls;
        }
    }
    return { ...actual, SessionCallHistory: StubHistory };
});

function guard(): WaitSpinGuardRule {
    return new WaitSpinGuardRule();
}

function ctx(command: string): BashContext {
    return new BashContext(command, '/repo');
}

function check(command: string): readonly Violation[] {
    return guard().check(ctx(command));
}

function blocked(command: string): boolean {
    return check(command).length === 1;
}

function message(command: string): string {
    return check(command)[0].message ?? '';
}

/**
 * ══ WHAT THIS GUARD IS FOR ═════════════════════════════════════════════════════════════════════════
 *
 * A subagent that stops making tool calls is finished, `Monitor` says "keep working", and the harness
 * refuses a Monitor with a real polling loop. So agents `echo .` every three seconds to stay alive, at
 * ~557,000 tokens a turn — measured at 18.3% of all fleet tokens in the 24h to 2026-09-07 (issue #874).
 */
describe('wait-spin-guard blocks a command whose only purpose is staying alive', () => {
    it('blocks the keep-alive tokens the measured runs actually used', () => {
        for (const token of ['.', '..', 'idle', 'idle2', 'idle6', 'ok', 'waiting', 'waiting-for-reviewers', 'standby']) {
            expect(blocked(`echo ${token}`)).toBe(true);
        }
    });

    it('blocks a quoted keep-alive token — quoting one word does not make it content', () => {
        expect(blocked('echo "."')).toBe(true);
        expect(blocked("echo 'idle'")).toBe(true);
    });

    it('blocks the no-output spins', () => {
        expect(blocked('true')).toBe(true);
        expect(blocked(':')).toBe(true);
    });

    it('blocks a bare date and a formatted one — both only print the clock', () => {
        expect(blocked('date')).toBe(true);
        expect(blocked('date -u +%H:%M')).toBe(true);
    });
});

/**
 * ══ THE CARVE-OUTS ARE THE WHOLE RISK ══════════════════════════════════════════════════════════════
 *
 * `echo` and `date` are everywhere in legitimate work, and every line below is a real shape from this
 * repo's own guard logs. A guard that cries wolf is a guard somebody turns off.
 */
describe('wait-spin-guard allows every legitimate use of the same programs', () => {
    it('allows echo inside a compound command that actually does something', () => {
        expect(check('echo "=== IN-SCOPE DIFF ===" && git diff origin/main...HEAD')).toEqual([]);
        expect(check('sed -n 1,50p f.ts; echo ---; sed -n 60,90p f.ts')).toEqual([]);
    });

    it('allows echo with a redirect — that writes a file', () => {
        expect(check('echo done > /tmp/marker')).toEqual([]);
        expect(check('echo hi >> notes.md')).toEqual([]);
    });

    it('allows date piped into something that consumes it', () => {
        expect(check('date +%s | xargs -I{} echo {}')).toEqual([]);
        expect(check('date > /tmp/started-at')).toEqual([]);
    });

    /**
     * The family is NAMED, not inferred from length. An earlier cut matched any short bare token and
     * blocked `echo hi` — a benign line in this package's own golden fixtures — plus the prose-stripped
     * remains of an `echo "<a sentence>"` that runner.spec.ts asserts is allowed.
     */
    it('allows echo printing real content rather than a keep-alive token', () => {
        expect(check('echo hi')).toEqual([]);
        expect(check('echo done')).toEqual([]);
        expect(check('echo $PATH')).toEqual([]);
        expect(check('echo -n .')).toEqual([]);
        expect(check('echo /some/long/path/that/is/not/a/token/at/all.ts')).toEqual([]);
    });

    // commandCode strips a quoted SENTENCE to nothing, so a bare `echo` here is a command whose content
    // nobody looked at — never a spin.
    it('allows a bare echo, which is what a stripped quoted sentence looks like', () => {
        expect(check('echo')).toEqual([]);
        expect(check('echo "some sentence with spaces in it"')).toEqual([]);
    });

    it('allows the cures it prescribes — a guard with no accepted spelling is a deadlock', () => {
        expect(check('pnpm wp-await-reviews')).toEqual([]);
        expect(check('pnpm wp-await-checks --pr 874')).toEqual([]);
    });
});

/**
 * ══ POLLING: ONE SNAPSHOT IS NOT A SPIN ════════════════════════════════════════════════════════════
 *
 * The difference between asking a question and refusing to stop asking it is the number of times, so
 * the count — not the command text — is what decides.
 */
describe('wait-spin-guard blocks a REPEATED status poll and nothing less', () => {
    it('allows the first and second identical gh pr checks', () => {
        for (let prior = 0; prior < REPEATS_BEFORE_REFUSAL; prior++) {
            priorCalls = prior;
            expect(check('gh pr checks 874')).toEqual([]);
        }
    });

    it('blocks the third', () => {
        priorCalls = REPEATS_BEFORE_REFUSAL;
        expect(blocked('gh pr checks 874')).toBe(true);
        expect(blocked('gh pr view 874 --json state')).toBe(true);
    });

    it('leaves every other gh command alone however often it is run', () => {
        priorCalls = 40;
        expect(check('gh pr list')).toEqual([]);
        expect(check('gh issue view 874 --comments')).toEqual([]);
        expect(check('gh pr checks 874 | grep fail')).toEqual([]);
    });
});

/**
 * ══ THE CURE MUST MATCH THE AGENT KIND ═════════════════════════════════════════════════════════════
 *
 * Prescribing "end your turn" to a worktree-isolated subagent destroys it mid-wait; prescribing a
 * ten-minute blocking command to a main agent wastes ten minutes. Never both, never the wrong one.
 */
describe('wait-spin-guard prescribes one cure per agent kind', () => {
    it('tells a PRIMARY-clone agent to start a Monitor and end its turn', () => {
        priorCalls = 0;
        const text = message('echo .');
        expect(text).toContain('END YOUR TURN');
        expect(text).not.toContain('wp-await-reviews');
    });

    it('tells a WORKTREE-isolated subagent to block, and never to end its turn', () => {
        const worktree = '/repo/.claude/worktrees/agent-abc';
        const isolated = new WaitSpinGuardRule();
        // The kind is git's answer about the tree, so it is stubbed at that one call rather than by
        // building a real worktree — see target-tree.spec.ts for the fixture-based form.
        const spy = vi.spyOn(
            isolated as unknown as { isWorktreeIsolated: (c: BashContext) => boolean },
            'isWorktreeIsolated').mockReturnValue(true);
        const text = isolated.check(new BashContext('echo .', worktree))[0].message ?? '';
        expect(text).toContain('pnpm wp-await-reviews');
        expect(text).toContain('pnpm wp-await-checks --pr <n>');
        expect(text).toContain('CANNOT end your turn');
        expect(text).not.toContain('END YOUR TURN');
        spy.mockRestore();
    });

    it('states the reason in one clause on both cures — a turn costs your whole context', () => {
        priorCalls = 0;
        expect(message('echo .')).toContain('557,000 tokens');
    });

    /** The framework owns "Fix Option N:". A hand-numbered list in a literal is an automatic reject. */
    it('hand-numbers nothing, and offers no static Option that could name the wrong cure', () => {
        const hint = guard().fixHint;
        expect(hint.fixOptions).toEqual([]);
        expect(hint.mainMessage).not.toContain('Fix Option');
        expect(hint.violation).not.toContain('Fix Option');
        expect(hint.mainMessage).not.toContain('wp-await-reviews');
    });
});
