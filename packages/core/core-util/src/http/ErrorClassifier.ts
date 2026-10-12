import { ApiMethodInfo } from './ApiMethodInfo';

/**
 * The ONE verdict on a thrown API-call error. Three readers share it, so there is exactly one table
 * answering "is this error expected, and is it worth repeating?":
 *
 * - `RetryStrategy` retries only {@link CallOutcome.TRANSIENT_FAILURE} (and only on a `READ` /
 *   `WRITE_IDEMPOTENT` endpoint — the ENDPOINT's safety is `CallContext.operation`'s question, never
 *   the classifier's);
 * - `LogApiCall` logs {@link CallOutcome.EXPECTED} as `[API-*-resp-OTHER]` (`result='success'`) and
 *   both failure outcomes as `[API-*-resp-FAIL]` (`result='failure'`);
 * - the MCP tool-call renderer derives its model-visible `retry` advice from the outcome plus the
 *   endpoint's operation.
 */
export enum CallOutcome {
    /** It threw, but things are WORKING: a 266, a server-side 4xx, an external client's "404 = miss". */
    EXPECTED = 'expected',
    /** Broken NOW, may work if repeated: unavailable, connection, timeouts, 429/backoff, bad-gateway. */
    TRANSIENT_FAILURE = 'transient',
    /** Broken, and repeating will not help: a RECEIVED 4xx (our bug), implementation, 501, retries exhausted. */
    FAILURE = 'failure',
}

/**
 * Classifies a thrown API-call error into a {@link CallOutcome}.
 *
 * This is BEHAVIOR, so it is an interface (per CLAUDE.md), passed as an object with a NAMED method
 * rather than a bare function — so "find usages" in an IDE lands on every implementation.
 *
 * Registered on {@link ClientRegistry} at startup — the same browser-safe, no-DI, populated-once
 * singleton that owns URL mappings and the {@link ErrorTranslator}. Resolved most-specific first by
 * {@link ClientRegistry.classify}:
 *
 * 1. `ClientRegistry.addErrorClassifier(new KeyedErrorClassifier(apiClass, c))` — per EXTERNAL
 *    client, keyed by {@link ApiMethodInfo.apiClass} ('FirestoreAdminClient', 'ClaudeApi',
 *    'TwilioApi'). Each external API qualifies its errors differently (a Firestore 404 miss is
 *    EXPECTED; a Twilio 429 is TRANSIENT), so it overrides the tiers below for that apiClass only.
 * 2. `ClientRegistry.setDefaultErrorClassifier(c)` — ONE per app/company. It reads
 *    {@link ApiMethodInfo.side}, so a single classifier covers the SERVER router AND every INTERNAL
 *    client (webpieces http client, cloud tasks).
 * 3. {@link WebpiecesDefaultErrorClassifier} — the terminal tier, which never defers.
 *
 * Internal clients and the server register NOTHING — the ABSENCE of an apiClass entry is the signal.
 * An external client that forgets to register is FAIL-SAFE: it falls to the tiers below, where every
 * client-side error except a 266 is a failure.
 */
export interface ErrorClassifier {
    /**
     * @param error - the already-normalized thrown error (callers pass `toError(err)`)
     * @param methodInfo - the call identity; `side` distinguishes server/client, `apiClass` the client
     * @returns the outcome, or `undefined` to DEFER to the next tier (a per-apiClass classifier defers
     *   to the app default; the app default defers to the webpieces built-in). Deferring is what
     *   makes classifiers additive AND override-capable.
     */
    classify(error: Error, methodInfo: ApiMethodInfo): CallOutcome | undefined;
}

/**
 * A per-external-client registration pair: the {@link ApiMethodInfo.apiClass} to key on, and the
 * {@link ErrorClassifier} to apply for it. Data only, so it is a class (not an inline object literal),
 * per CLAUDE.md — handed to {@link ClientRegistry.addErrorClassifier}.
 */
export class KeyedErrorClassifier {
    constructor(
        public readonly apiClass: string,
        public readonly classifier: ErrorClassifier,
    ) {}
}
