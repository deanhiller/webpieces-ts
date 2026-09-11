import { describe, it, expect, vi } from 'vitest';

import { BashContext } from '../types';
import { WaitSpinGuardRule } from './wait-spin-guard';

// Same two stubs the guard's own suite uses: the decision log and the session call log are this rule's
// only I/O, and neither one is what this file is about.
type DecisionLogModule = typeof import('../decision-log');
vi.mock('../decision-log', async (importActual: () => Promise<DecisionLogModule>) => {
    const actual = await importActual();
    return { ...actual, logGuardDecision: (): void => undefined };
});

type HistoryModule = typeof import('../session-call-history');
vi.mock('../session-call-history', async (importActual: () => Promise<HistoryModule>) => {
    const actual = await importActual();
    class StubHistory extends actual.SessionCallHistory {
        priorBashCalls(): number {
            return 99;
        }
    }
    return { ...actual, SessionCallHistory: StubHistory };
});

/**
 * ══ webpieces NEVER TELLS AN AI TO END ITS TURN (issue #902) ═══════════════════════════════════════
 *
 * The principle is `.claude/rules/never-tell-an-ai-to-end-its-turn.md`. This file is the half of its
 * enforcement that lives with the GUARDS; the other half is `pr-gate`'s spec of the same name, which
 * covers what the gate prints.
 *
 * It asserts over the strings the guard ACTUALLY EMITS — every refusal message, for both agent kinds
 * and every spin shape, plus the rule's own `description` and `fixHint` — and not over the source text,
 * because a grep of the source is satisfied the moment somebody moves the sentence into a constant.
 *
 * THE ONE PERMITTED SPELLING is the NEGATIVE one. "Do NOT end your turn expecting a backgrounded wait
 * to re-invoke you" is the OPPOSITE instruction — it tells an agent not to stop — and #900 measured why
 * it has to be there. So the check strips the negated form first and only then forbids what is left.
 */
const NEGATED = /\b(?:do not|do NOT|don't|never)\s+end (?:your|the|its) turn/gi;
const PRESCRIBES_ENDING = /\bend(?:ing|s)? (?:your|the|its) turn\b/i;

const offends = (text: string): boolean => PRESCRIBES_ENDING.test(text.replace(NEGATED, ''));

/** Every refusal message this guard can put in front of an agent, keyed by how it got there. */
const emittedMessages = (): Map<string, string> => {
    const emitted = new Map<string, string>();
    for (const command of ['echo .', 'true', 'date', 'gh pr checks 902']) {
        const main = new WaitSpinGuardRule();
        emitted.set(`main-agent: ${command}`, main.check(new BashContext(command, '/repo'))[0]?.message ?? '');

        const isolated = new WaitSpinGuardRule();
        vi.spyOn(
            isolated as unknown as { isWorktreeIsolated: (c: BashContext) => boolean },
            'isWorktreeIsolated').mockReturnValue(true);
        const sub = isolated.check(new BashContext(command, '/repo/.claude/worktrees/agent-abc'));
        emitted.set(`subagent: ${command}`, sub[0]?.message ?? '');
    }
    const rule = new WaitSpinGuardRule();
    emitted.set('description', rule.description);
    emitted.set('fixHint.violation', rule.fixHint.violation);
    emitted.set('fixHint.mainMessage', rule.fixHint.mainMessage);
    return emitted;
};

describe('no guard string tells an AI to end its turn', () => {
    it('emits at least one non-empty message per case, so an empty map cannot pass this file', () => {
        const emitted = emittedMessages();
        expect(emitted.size).toBeGreaterThan(8);
        for (const [where, text] of emitted) {
            expect(text.length, `${where} emitted nothing`).toBeGreaterThan(0);
        }
    });

    it('never prescribes ending the turn, in any refusal it can print', () => {
        for (const [where, text] of emittedMessages()) {
            expect(offends(text), `${where} tells the agent to end its turn`).toBe(false);
        }
    });

    /**
     * The detector has to be able to FAIL, or the three assertions above are decoration. These pin both
     * directions: the prescription is caught, the negation that #900 requires is not.
     */
    it('catches the prescription and spares the negation', () => {
        expect(offends('Cheapest: END YOUR TURN — anything pending re-invokes you.')).toBe(true);
        expect(offends('ending the turn is cheaper')).toBe(true);
        expect(offends('Do NOT end your turn expecting a backgrounded wait to re-invoke you.')).toBe(false);
        expect(offends('Be efficient with tokens: block in one call with pnpm wp-await-checks.')).toBe(false);
    });
});
