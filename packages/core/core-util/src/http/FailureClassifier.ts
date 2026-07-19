import { ApiMethodInfo } from './ApiMethodInfo';

/**
 * Decides whether a thrown API-call error is a real FAILURE — the process not working, SURFACE it
 * (LogApiCall logs `[API-*-resp-FAIL]`, `jsonPayload.api.result='failure'` — what dashboards/alerts
 * count) — or an EXPECTED non-failure — the process working correctly, a handled condition
 * (`[API-*-resp-OTHER]`, `result='success'`).
 *
 * This is BEHAVIOR, so it is an interface (per CLAUDE.md), passed as an object with a NAMED method
 * rather than a bare function — so "find usages" in an IDE lands on every implementation.
 *
 * Registered on {@link ClientRegistry} at startup — the same browser-safe, no-DI, populated-once
 * singleton that owns URL mappings and {@link ErrorTranslation}. TWO tiers, resolved most-specific
 * first (see {@link ClientRegistry.classifyFailure}):
 *
 * 1. `ClientRegistry.setDefaultFailureClassifier(c)` — ONE per app/company. It reads
 *    {@link ApiMethodInfo.side}, so a single strategy covers the SERVER router AND all INTERNAL
 *    clients (webpieces http client, cloud tasks). Optional: if unset, webpieces uses
 *    {@link WebpiecesDefaultFailureClassifier} (server 4xx = non-failure; client non-266 = failure).
 * 2. `ClientRegistry.addFailureClassifier(apiClass, c)` — per EXTERNAL client, keyed by
 *    {@link ApiMethodInfo.apiClass} ('FirestoreAdminClient', 'ClaudeApi', 'TwilioApi'). Each external
 *    API qualifies errors differently (a Firestore 404 miss, a Twilio 429 retry are EXPECTED, not
 *    failures), so it overrides the default for that apiClass only.
 *
 * Internal clients and the server register NOTHING — the ABSENCE of an apiClass entry is the signal;
 * they fall through to tier 1. An external client that forgets to register is FAIL-SAFE: it also
 * falls to tier 1 (client side ⇒ every non-266 = failure) until it opts in.
 */
export interface FailureClassifier {
    /**
     * @param error - the already-normalized thrown error (callers pass `toError(err)`)
     * @param methodInfo - the call identity; `side` distinguishes server/client, `apiClass` the client
     * @returns `true` = real failure; `false` = expected/non-failure; `undefined` = DEFER
     *   (a per-apiClass classifier defers to the app default; the app default defers to the
     *   webpieces built-in). Deferring is what makes classifiers additive AND override-capable.
     */
    isFailure(error: Error, methodInfo: ApiMethodInfo): boolean | undefined;
}

/**
 * A per-external-client registration pair: the {@link ApiMethodInfo.apiClass} to key on, and the
 * {@link FailureClassifier} to apply for it. A data-only structure, so it is a class (not an inline
 * object literal), per CLAUDE.md — lets startup wiring carry a list of these and hand each to
 * {@link ClientRegistry.addFailureClassifier}.
 */
export class KeyedFailureClassifier {
    constructor(
        public readonly apiClass: string,
        public readonly classifier: FailureClassifier,
    ) {}
}
