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
 * The refusal a WORKTREE-ISOLATED subagent sees. The kind is git's answer about the tree, so it is
 * stubbed at that one call rather than by building a real worktree — see target-tree.spec.ts for the
 * fixture-based form.
 */
function subagentMessage(): string {
    const isolated = new WaitSpinGuardRule();
    vi.spyOn(
        isolated as unknown as { isWorktreeIsolated: (c: BashContext) => boolean },
        'isWorktreeIsolated').mockReturnValue(true);
    return isolated.check(new BashContext('echo .', '/repo/.claude/worktrees/agent-abc'))[0].message ?? '';
}

/**
 * ══ WHAT THIS GUARD IS FOR ═════════════════════════════════════════════════════════════════════════
 *
 * `Monitor` says "keep working" and the harness refuses a Monitor with a real polling loop, so agents
 * `echo .` every three seconds to stay alive, at ~557,000 tokens a turn — measured at 18.3% of all fleet
 * tokens in the 24h to 2026-09-07 (issue #874).
 *
 * #878 corrected the first cut's claim that a subagent cannot end its turn at all — 449 measured
 * resumptions say it can — and the cure then led with ENDING THE TURN. #900 measured the part that
 * actually mattered and it does not hold: for a worktree subagent whose only pending work is one
 * `run_in_background` wait, the re-invocation does NOT fire. Three stalls, two subagents, one session,
 * every notification reading "no live background children of its own". So the subagent cure is now the
 * FOREGROUND block, re-run while it is still waiting, and the tests below pin that text.
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

    /**
     * The single-segment rule hid the MAJORITY form. These three are real commands off this machine —
     * 173, 81 and 72 occurrences over 30 days — and a trailing pager does not change the question the
     * poll asks, so it must not change the verdict either (issue #878).
     */
    it('counts a poll wearing a trailing pager, using the real missed commands', () => {
        priorCalls = REPEATS_BEFORE_REFUSAL;
        expect(blocked('gh pr checks 1058 2>&1 | head')).toBe(true);
        expect(blocked('gh pr checks 464 2>&1 | head')).toBe(true);
        expect(blocked('gh pr checks 428 2>&1 | head -10')).toBe(true);
        expect(blocked('gh pr checks 428 | head -n 10')).toBe(true);
        expect(blocked('gh pr view 874 --json state | cat')).toBe(true);
        expect(blocked('gh pr checks 428 | wc -l')).toBe(true);
        expect(blocked('gh pr checks 428 | tail')).toBe(true);
    });

    it('still allows the first and second of the piped form — the count is what decides', () => {
        priorCalls = 0;
        expect(check('gh pr checks 1058 2>&1 | head')).toEqual([]);
    });

    /**
     * The pager normalisation is POLL-ONLY. Relaxing the single-segment rule for the NO-OP shape would
     * break `echo "=== IN-SCOPE DIFF ===" && git diff …` and friends, which is the carve-out that keeps
     * this guard usable at all.
     */
    it('never lets the pager path reach the NO-OP shape', () => {
        priorCalls = 40;
        expect(check('echo . | head')).toEqual([]);
        expect(check('date | cat')).toEqual([]);
        expect(check('gh pr checks 428 | head -c 200')).toEqual([]);
        expect(check('gh pr checks 428 | head file.txt')).toEqual([]);
        expect(check('gh pr checks 428 | head | tail')).toEqual([]);
    });
});

/**
 * ══ `gh pr checks --watch` IS THE CURE, NOT THE SPIN ═══════════════════════════════════════════════
 *
 * It BLOCKS in one call — 224 subagent and 84 main-agent uses in the measured window — which is the
 * exact behaviour this guard pushes agents toward. Refusing it however often it appears would refuse
 * the cure (issue #878).
 */
describe('wait-spin-guard never denies a blocking --watch', () => {
    it('allows it however many identical calls precede it', () => {
        priorCalls = 999;
        expect(check('gh pr checks 874 --watch')).toEqual([]);
        expect(check('gh pr checks 874 --watch --interval 10')).toEqual([]);
        expect(check('gh pr checks 874 --watch | head')).toEqual([]);
    });
});

/**
 * ══ THE CURE MUST MATCH THE AGENT KIND ═════════════════════════════════════════════════════════════
 *
 * A main agent has `Monitor` and `run_in_background` genuinely available and is pointed at them.
 * A worktree subagent is told to BLOCK IN THE FOREGROUND, because #900 measured that the background
 * re-invocation it would otherwise rely on does not fire. Never both, never the wrong one.
 *
 * NEITHER cure tells the agent to end its turn (issue #902): webpieces names the efficient wait and
 * refuses the wasteful poll, and the turn-level decision is the agent's.
 */
describe('wait-spin-guard prescribes one cure per agent kind', () => {
    it('tells a PRIMARY-clone agent to start a Monitor or background the command', () => {
        priorCalls = 0;
        const text = message('echo .');
        expect(text).toContain('start a `Monitor`');
        expect(text).toContain('run_in_background');
        expect(text).not.toContain('wp-await-reviews');
    });

    it('never tells the MAIN agent to end its turn either', () => {
        priorCalls = 0;
        const text = message('echo .');
        expect(text).not.toContain('END YOUR TURN');
    });

    it('tells a WORKTREE-isolated subagent to BLOCK IN ONE FOREGROUND CALL', () => {
        const text = subagentMessage();
        expect(text).toContain('BLOCK IN ONE FOREGROUND CALL');
        expect(text).toContain('pnpm wp-await-reviews');
        expect(text).toContain('pnpm wp-await-checks --pr <n>');
        expect(text.indexOf('BLOCK IN ONE FOREGROUND CALL'))
            .toBeLessThan(text.indexOf('pnpm wp-await-reviews'));
    });

    /**
     * The regression #900 exists to delete. The previous cure told a subagent to END ITS TURN and be
     * re-invoked when its backgrounded wait exited; measured three times in one session, it was not,
     * and the run stalled. So the subagent cure must not prescribe either half of that mechanism.
     */
    it('never tells a subagent to end its turn or to background its wait', () => {
        const text = subagentMessage();
        expect(text).not.toContain('END YOUR TURN');
        expect(text).toContain('do NOT pass\nrun_in_background');
        expect(text).toContain('Do NOT end your turn expecting a backgrounded wait to re-invoke you');
    });

    /**
     * The 540s return is the whole reason the foreground wait is affordable: the harness demotes a
     * foreground call to the background at 600s and the result is lost, so the command must come back
     * first and the agent must know that coming back is not a failure.
     */
    it('names the bounded return and tells the agent to re-run the identical command', () => {
        const text = subagentMessage();
        expect(text).toContain('540s');
        expect(text).toContain('run the IDENTICAL command again');
        expect(text).toContain('#900');
    });

    /**
     * The full-cycle skill's `wp-await.sh` is now TRACKED in this repo and carries the identical
     * contract — foreground, `--timeout 545` under the same 600s ceiling, re-run on exit 2. The guard
     * and the skill disagreeing about how to wait is the exact defect #900 is about, so the cure names
     * the script's numbers too rather than leaving an agent to reconcile two documents.
     */
    it('agrees with the tracked wp-await.sh contract — foreground, --timeout 545, re-run on exit 2', () => {
        const text = subagentMessage();
        expect(text).toContain('wp-await.sh');
        expect(text).toContain('--timeout 545');
        expect(text).toContain('exit 2');
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
