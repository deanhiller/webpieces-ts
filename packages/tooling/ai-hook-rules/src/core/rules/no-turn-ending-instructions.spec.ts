import { describe, it, expect, vi } from 'vitest';

import { Option, WebpiecesRulesConfig } from '@webpieces/rules-config';
import { BashContext, Rule } from '../types';
import { WaitSpinGuardRule } from './wait-spin-guard';
import { renderEverySkewReport } from '../version-sync-harness.spec';
import { renderL1Doc } from '../l1-doc';
import { renderL2Doc } from '../l2-doc';
import { renderGuardMatrixDoc } from '../l0-matrix';
import { L0ToolingDoc } from '../l0-tooling-doc';
import { GuardIndexDoc } from '../guard-index-doc';
import { GuardHintCommands, loadKeylessBashRules, loadRules } from '../load-rules';
import { renderShim } from '../../bin/shim';
import { shimStaleDenyReason } from '../../bin/shim-deny-reason';

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
const NEGATED = /\b(?:do not|don't|never)\s+(?:end (?:your|the|its) turn|stop working)/gi;

/**
 * Every spelling of "your turn is over" that has actually shipped. The first is #902's; the rest are
 * #1000's, from the version-skew escalation #902's detector never rendered: "THEN STOP WORKING NOW.
 * Forwarding that message IS the end of your turn: make NO further tool calls". The last catches the
 * shouted closing beat ("forward the ask to the coordinator and STOP") that L1 row 8's cure carried —
 * case-SENSITIVE on purpose, so "stop and ask the human" and an ordinary lower-case "stop" are not
 * mistaken for it.
 */
const PRESCRIPTIONS: readonly RegExp[] = [
    /\bend(?:ing|s)? (?:your|the|its) turn\b/i,
    /\bend of (?:your|the|its) turn\b/i,
    /\bSTOP WORKING\b/i,
    /\bno (?:further|more) tool\s+calls?\b/i,
    /\b(?:then|and),?\s+STOP\b/,
];

const offends = (text: string): boolean => {
    const stripped = text.replace(NEGATED, '');
    return PRESCRIPTIONS.some((pattern: RegExp) => pattern.test(stripped));
};

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

    /** The #1000 shapes, verbatim from the escalation block and the L1 row-8 cure that carried them. */
    it('catches every #1000 spelling and spares the retry refusal that replaced it', () => {
        expect(offends('   THEN STOP WORKING NOW.')).toBe(true);
        expect(offends('Forwarding that message IS the end of your turn')).toBe(true);
        expect(offends('make NO further tool\n   calls and do NOT retry this one')).toBe(true);
        expect(offends('forward the deny\'s verbatim ask to the coordinator and STOP<br>Do NOT: expect')).toBe(true);
        expect(offends('WAIT for the main agent to confirm it is done, then STOP.')).toBe(true);
        // The legitimate half: refusing ONE futile command decides nothing about control flow.
        expect(offends('   Do NOT retry this call — RETRYING IS THE BUG. It re-fires this identical deny.')).toBe(false);
        expect(offends('Do not stop working on the PR to ask permission.')).toBe(false);
        expect(offends('If you genuinely believe this IS a chokepoint, STOP and ask the human first')).toBe(false);
    });
});

/**
 * ══ THE REST OF WHAT ai-hook-rules CAN PRINT (issue #1000) ═════════════════════════════════════════
 *
 * #902's enforcement rendered wait-spin-guard and nothing else, so the version-skew escalation kept
 * telling subagents "Forwarding that message IS the end of your turn" for a release after the rule
 * existed. The fix for a detector that only sees one surface is not a second detector for a second
 * surface — it is rendering EVERY surface through the same one:
 *
 *   • the version-skew report, every `SkewCase` × both harnesses (L1 row 8),
 *   • every generated guard doc a deny points the reader at — L0 matrix, L0 tooling, L1 location
 *     matrix (every row's cure, incl. the row-8 subagent cure), L2 branch-state, the guard index,
 *   • the rendered L0 shim (every sh-side deny) and the fault-S deny, both agent kinds,
 *   • every built-in and keyless rule's `description` and `fixHint` (violation, main message, options).
 */
const renderedDocs = (): Map<string, string> => new Map<string, string>([
    ['L0 guard matrix', renderGuardMatrixDoc()],
    ['L0 tooling doc', new L0ToolingDoc().render()],
    ['L1 location matrix', renderL1Doc()],
    ['L2 branch-state matrix', renderL2Doc()],
    ['guard index', new GuardIndexDoc().render()],
    ['L0 shim (ai-hook.sh)', renderShim()],
    ['L0 fault-S deny, main agent', shimStaleDenyReason('0.4.624', '/tmp/wp-root', ['ai-hook.sh'], false)],
    ['L0 fault-S deny, subagent', shimStaleDenyReason('0.4.624', '/tmp/wp-root', ['ai-hook.sh'], true)],
]);

const ruleHints = (): Map<string, string> => {
    const hints = new Map<string, string>();
    const rules: readonly Rule[] = [
        ...loadRules({} as WebpiecesRulesConfig, '/repo', new GuardHintCommands('pnpm wp-start-upsert-pr', 'pnpm wp-merge-complete')),
        ...loadKeylessBashRules('pnpm wp-build'),
    ];
    for (const rule of rules) {
        hints.set(`${rule.name}.description`, rule.description);
        hints.set(`${rule.name}.fixHint.violation`, rule.fixHint.violation);
        hints.set(`${rule.name}.fixHint.mainMessage`, rule.fixHint.mainMessage);
        rule.fixHint.fixOptions.forEach((option: Option, index: number) => {
            hints.set(`${rule.name}.fixHint.fixOptions[${index}]`, option.text);
        });
    }
    return hints;
};

describe('no ai-hook-rules surface tells an AI to end its turn', () => {
    it('renders all ten skew reports (5 SkewCases × 2 harnesses), each non-empty', () => {
        const reports = renderEverySkewReport();
        expect(reports.size).toBe(10);
        for (const [where, text] of reports) expect(text.length, `${where} rendered nothing`).toBeGreaterThan(0);
        // The escalating cases MUST still carry the retry refusal — the legitimate half of #679.
        for (const skew of ['main-inconsistent', 'main-behind', 'bump']) {
            for (const aiType of ['claude-code', 'codex']) {
                expect(reports.get(`${skew} × ${aiType}`), `${skew} × ${aiType}`).toContain('Do NOT retry this call');
            }
        }
    });

    it('never prescribes ending the turn in any version-skew report', () => {
        for (const [where, text] of renderEverySkewReport()) {
            expect(offends(text), `skew report ${where} tells the agent to end its turn`).toBe(false);
        }
    });

    it('never prescribes ending the turn in any generated guard doc or L0 deny', () => {
        const docs = renderedDocs();
        for (const [where, text] of docs) {
            expect(text.length, `${where} rendered nothing`).toBeGreaterThan(0);
            expect(offends(text), `${where} tells the agent to end its turn`).toBe(false);
        }
    });

    it('never prescribes ending the turn in any rule description or fix hint', () => {
        const hints = ruleHints();
        // 16 config keys expand to 22 rules, plus 4 keyless guards — three strings each at minimum.
        expect(hints.size).toBeGreaterThan(60);
        for (const [where, text] of hints) {
            expect(offends(text), `${where} tells the agent to end its turn`).toBe(false);
        }
    });
});
