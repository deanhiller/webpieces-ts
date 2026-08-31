import { AiType, AI_TYPE_UNKNOWN } from './agent-event';

/**
 * WHICH HARNESS this hook process is serving, for the four JS-side audit streams.
 *
 * ─── Why a process-wide holder and not a parameter ────────────────────────────────────────────────
 * One hook process handles exactly one tool call, so the harness is a property of the PROCESS, not of
 * any individual log line. Threading it as a parameter instead would have meant a new argument on
 * `logGuardDecision()`, `logL1Decision()`, `InvocationLog.finish()` and `logRejection()`, which between
 * them are constructed at fourteen call sites across eight guard modules — none of which has any
 * business knowing what a harness is. That is the identical argument `LogStream`'s docblock makes for
 * the session/agent/hook identity, and this is the identical shape: identified ONCE by the adapter that
 * parsed the payload, read by every writer downstream.
 *
 * ─── Why it is NOT folded into StreamIdentity ─────────────────────────────────────────────────────
 * `StreamIdentity` is defined as "the three fields that make a log FILENAME unique", and it crosses a
 * process boundary on argv (the detached main-sync refresher). The harness is neither: it never appears
 * in a filename, and a fourth field would have to be threaded through that argv round trip to mean
 * anything. Two small values with two clear jobs beat one value that answers two different questions.
 *
 * ─── `unknown` is a value ─────────────────────────────────────────────────────────────────────────
 * A writer reached before any payload was parsed — the openclaw plugin, a library consumer, a spec —
 * renders `ai=unknown`, and so does every row written by a release older than this field. That is a real
 * value to count, not an absence and not a back-compat shim: see AI_TYPE_UNKNOWN.
 */
export class AiTypeContext {
    private aiType: AiType | null = null;

    /** Called once per invocation, by the adapter that parsed the payload. */
    identify(aiType: AiType): void {
        this.aiType = aiType;
    }

    /** The `ai=` field's value — the harness, or `unknown` when nothing established one. */
    forLog(): string {
        return this.aiType ?? AI_TYPE_UNKNOWN;
    }
}

/**
 * Process-wide instance, for the reason given above and in LogStream's own docblock: one process, one
 * tool call, one harness.
 */
export const aiTypeContext = new AiTypeContext();
