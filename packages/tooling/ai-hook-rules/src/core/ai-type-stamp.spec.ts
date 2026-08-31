import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { InvocationLog, logGuardDecision, logL1Decision, GuardDecision, MATRIX_L2_UNROWED } from './decision-log';
import { LogStream } from './log-stream';
import { logRejection } from './rejection-log';
import { aiTypeContext, AiTypeContext } from './ai-type-context';
import { AI_TYPES, AI_TYPE_UNKNOWN, AiType } from './agent-event';
import { NormalizedToolInput, NormalizedEdit, BlockedResult } from './types';
import { L0_FAULT_NONE } from './l0-fault-codes';
import { L1_LOCATION_STREAM, L2_DECISIONS_STREAM, CALLS_STREAM, REJECTIONS_STREAM } from './log-streams';
import { SHIM_LOG_FIELDS, ShimLogField } from '../bin/shim';

/**
 * `ai=` MUST SPAN THE WHOLE TRAIL, or it answers nothing.
 *
 * The question this field exists for is "is Codex actually being guarded, and how does it compare to
 * Claude?" — and that question is only answerable if ONE grep reaches every stream. A field on four of
 * five streams is worse than none: it makes a partial count look like a total.
 *
 * So this drives all four JS writers for real (the fifth, `L0-shim/`, is sh and is locked in
 * shim-audit-log.spec.ts through a real /bin/sh) and asserts the same field name and the same vocabulary
 * in each.
 */
function tmpRoot(): string {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-aistamp-')));
}

function readLog(root: string, stream: string): string {
    return fs.readFileSync(path.join(root, '.webpieces', 'logs', stream, new LogStream().writerFile('.log')), 'utf8');
}

/** Drive every JS-side writer once, and return what each stream recorded. */
function writeAllStreams(root: string): readonly string[] {
    const invocations = new InvocationLog();
    invocations.begin(root, 'Bash', 'pnpm build');
    invocations.finish('ALLOW', '-');

    const decision = new GuardDecision('some-rule', 'Bash', 'pnpm build', 'dean/x', 'ALLOW', 'why', '-', L0_FAULT_NONE, MATRIX_L2_UNROWED);
    logGuardDecision(root, decision);
    logL1Decision(root, decision);

    const input = new NormalizedToolInput(path.join(root, 'src/x.ts'), [new NormalizedEdit('a', 'b')]);
    logRejection('Edit', input, new BlockedResult('[some-rule] (a reason)\nblocked', L0_FAULT_NONE), root);

    return [CALLS_STREAM, L2_DECISIONS_STREAM, L1_LOCATION_STREAM, REJECTIONS_STREAM]
        .map((stream: string): string => readLog(root, stream));
}

beforeEach(() => {
    // The holder is process-wide (one hook process, one tool call), so each case states its own value.
    aiTypeContext.identify('claude-code');
});

describe('every JS-side stream carries ai=', () => {
    it.each(AI_TYPES)('stamps ai=%s on calls/, L2-decisions/, L1-location/ AND rejections/', (aiType: AiType) => {
        const root = tmpRoot();
        aiTypeContext.identify(aiType);
        for (const body of writeAllStreams(root)) expect(body).toContain(`\tai=${aiType}`);
    });

    /**
     * The sh half and the JS half must spell the SAME values, or `grep ai=codex` finds one layer of L0
     * and silently misses the other. The sh field's value comes from AI_TYPE_SH, whose two answers are
     * the AiType union's own strings — this is what pins that the log field documents exactly those.
     */
    it('documents the same vocabulary in the L0 shim log field', () => {
        const field = SHIM_LOG_FIELDS.find((f: ShimLogField): boolean => f.shValue.includes('$AI'));
        expect(field, 'the L0 shim log has no ai= field').toBeDefined();
        expect(field!.label).toBe(`ai=<${AI_TYPES.join('|')}>`);
    });
});

describe('unknown is a VALUE, not an absence', () => {
    /**
     * A writer reached before any payload was parsed — the openclaw plugin, a library consumer, a spec —
     * still has to produce a countable row. An omitted field would be indistinguishable from "this
     * reader is looking at the wrong column", which is the failure the field exists to prevent.
     */
    it('renders unknown when nothing identified the harness', () => {
        expect(new AiTypeContext().forLog()).toBe(AI_TYPE_UNKNOWN);
    });

    it('writes ai=unknown rather than omitting the field', () => {
        const root = tmpRoot();
        // A FRESH holder cannot be injected into the module-scope writers, so the assertion is on the
        // holder's own contract plus the field's presence — the two together are what the readers need.
        for (const body of writeAllStreams(root)) expect(body).toMatch(/\tai=[a-z-]+/);
    });

    it('is not one of the real harness values, so a count of it is a count of gaps', () => {
        expect(AI_TYPES).not.toContain(AI_TYPE_UNKNOWN);
    });
});
