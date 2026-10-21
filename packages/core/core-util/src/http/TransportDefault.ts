import { CallStrategy } from './CallStrategy';

/**
 * What a TRANSPORT does for a call nobody registered a policy for — the last rung of
 * {@link ClientRegistry.execute}'s ladder (strategy method → API → ALL, else timeout method → API →
 * ALL, else this).
 *
 * It is the ONLY per-transport difference: every transport calls the same `ClientRegistry.execute`, so
 * a strategy registered at ALL / API / method governs RPC and Cloud Tasks enqueue identically.
 *
 * - RPC (node and browser, through `ProxyClient`): `new TransportDefault(30_000)` — one attempt, no
 *   default retry, because only the application knows whether repeating a POST is safe.
 * - Cloud Tasks enqueue: `new TransportDefault(30_000, new RetryStrategy(5_000, 3, 500, 2, 4_000).run)`
 *   — enqueue is idempotent by construction (one task name for every attempt), so it retries.
 */
export class TransportDefault {
    constructor(
        /** The single attempt's deadline when no strategy (registered or default) runs. */
        readonly timeoutMs: number,
        /** The transport's own strategy; when set it owns timing exactly like a registered one. */
        // webpieces-disable no-any-unknown -- transport strategies span heterogeneous response DTOs
        readonly strategy?: CallStrategy<unknown>,
    ) {}
}
