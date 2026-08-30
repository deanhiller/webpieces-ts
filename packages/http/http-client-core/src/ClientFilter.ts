import { Filter } from '@webpieces/core-util';
import { ClientRequest } from './ClientRequest';

/**
 * An OUTBOUND filter — the client-side counterpart of the server's `HttpFilter`, and the same
 * `Filter` abstraction from @webpieces/core-util pointed the other way:
 *
 * - server: `Filter<MethodMeta, WpResponse<unknown>>` wraps the controller invocation
 * - client: `Filter<ClientRequest, Response>` wraps the send
 *
 * `REQ` is the mutable {@link ClientRequest}, so a filter can re-point the URL, add headers, or
 * replace the serialized body. `RESP` is the platform `Response`, so a filter can read the status
 * and headers of what came back, short-circuit without sending at all, or invoke the rest of the
 * chain more than once (which is how a redirect is followed under policy).
 *
 * ## One rule: do not consume the body
 *
 * A `Response` body can be read exactly once, and the response body is read AFTER the chain by the
 * engine that turns it into the caller's DTO or typed error. A filter that calls `.json()` or
 * `.text()` on the response it is passing back breaks the call. Read `response.status` and
 * `response.headers` freely; `response.clone()` first if you genuinely need the bytes.
 */
export type ClientFilter = Filter<ClientRequest, Response>;

/**
 * ONE registered client filter and the priority it runs at — the client-side twin of the server's
 * `FilterDefinition`, and it carries a priority for the same reason: priority belongs to the
 * REGISTRATION, never to the filter, so the same filter class can sit at different depths in two
 * different clients.
 *
 * Highest priority runs OUTERMOST (first in, last out), matching `FilterMatcher`'s ordering, so a
 * filter with a higher number wraps everything below it.
 *
 * ## Priority orders APP filters against each other, and nothing else
 *
 * The framework's own built-ins (the SSRF guard, the outbound credential minter) are not in this
 * ordering at all: `ProxyClient.initRoutes` appends them BENEATH every app filter, whatever numbers
 * the app chose. So there is no priority — not `Number.MAX_SAFE_INTEGER` — that gets an app filter
 * underneath them, which is the point. The guard must judge, and the minter must sign for, the URL
 * that is actually about to be fetched; a filter that could run below them would be able to move
 * the request after both had spoken.
 *

 * ## Two deliberate differences from the server's FilterDefinition
 *
 * 1. It holds an INSTANCE, not a DI class token. Server filters are resolved from the container by
 *    the router; a client filter is constructed at the `createRpcClient` call site, which is code
 *    already inside a DI module and already holding whatever the filter needs (a signing key, a
 *    clock). Adding a container round-trip would buy nothing and would make the filter's collaborators
 *    invisible at the one place a reader looks.
 * 2. There is no filepath pattern. The server matches filters to controllers because ONE router
 *    serves many controllers; a client is bound to exactly ONE contract, so there is nothing to
 *    match against and a pattern would always be a no-op.
 */
export class ClientFilterDefinition {
    constructor(
        /** Higher runs OUTERMOST, among THIS client's app filters. See the class doc. */
        public readonly priority: number,
        public readonly filter: ClientFilter,
    ) {}
}

/**
 * The app filters ONE client installs — a NON-EMPTY list, which is the whole point of the type.
 *
 * `createRpcClient`'s filters argument is optional and typed as this, so "this client has no app
 * filters" has exactly ONE spelling: omit the argument. `[]` would be a second way to say the
 * identical thing, so it is a COMPILE error rather than a discouraged-but-accepted alternative —
 * the same device `JwtRoles`'s `roles` uses, and for the same reason (see
 * `.claude/review/backwards-compatibility.md` shim shape #1: delete the bad case from the type
 * instead of documenting a preference). Pinned in `CreateRpcClientCompileAssertions.ts`.
 */
export type ClientFilters = readonly [ClientFilterDefinition, ...ClientFilterDefinition[]];
