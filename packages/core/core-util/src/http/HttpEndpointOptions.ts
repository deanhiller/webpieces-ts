import { ExternalSystemKind } from './external-caller';
import { EndpointResponseType } from './HttpContract';

/** Nominal backing keeps raw string literals out of endpoint declarations. */
enum EndpointOperationValue {
    READ = 'read',
    WRITE_IDEMPOTENT = 'write-idempotent',
    WRITE = 'write',
}

/** Short, statically importable decorator arguments. */
export const READ = EndpointOperationValue.READ;
export const WRITE_IDEMPOTENT = EndpointOperationValue.WRITE_IDEMPOTENT;
export const WRITE = EndpointOperationValue.WRITE;

/** The side-effect contract callers use to decide whether repeating an operation is safe. */
export type EndpointOperation = typeof READ | typeof WRITE_IDEMPOTENT | typeof WRITE;

/** Options for one `@Endpoint`, stored parallel to the method-to-path metadata. */
export interface EndpointOptions {
    /** Return only a JSON body (default), or the full transport-neutral status/header/body value. */
    responseType?: EndpointResponseType;
    /**
     * Parse the request body as application/x-www-form-urlencoded instead of JSON. The request
     * DTO must be flat; urlencoded has no nesting. Default false = JSON.
     */
    formPost?: boolean;
    /**
     * Retain the verbatim request bytes and absolute URL for a `webhook(...)` callback to verify.
     * This is retention, not new buffering: the Express adapter already accumulates the body.
     *
     * `webhook(...)` requires this option at wiring time. It combines with `formPost` for vendors
     * that sign flat form bodies, e.g. `{ formPost: true, rawBody: true }`.
     */
    rawBody?: boolean;
    /**
     * The app should show NO progress UI for this call — it is not something the USER is waiting on
     * (a background download, a log shipper, a heartbeat, a telemetry flush).
     *
     * webpieces draws no progress bar itself; it DECLARES the fact and carries it on
     * `RouteMetadata.hideProgress`, which an app's `RequestLifecycleListener` reads to keep the call
     * out of its bar. WHY a declaration on the endpoint: the alternative is the app matching path
     * strings in its listener, which silently drifts the first time a route is renamed. The ROUTE is
     * the stable fact, so the decision belongs to the route's author.
     *
     * Independent of {@link noLogging} and {@link allowUpgradeInFlight}: a background download hides
     * its progress yet still wants its `[API-*]` lines (exactly what you need when a sync is slow)
     * and still must finish before an app upgrades under it.
     *
     * Default false: absent means the call drives the app's progress UI, like any ordinary route.
     * `grep -rn hideProgress` lists every endpoint the user is not shown waiting on.
     */
    hideProgress?: boolean;
    /**
     * webpieces writes NO `[API-*-req]` / `[API-*-resp-*]` line for this call, on either side —
     * {@link LogApiCallImpl} reads it via `ApiMethodInfo.noLogging`, handed in by both the client
     * proxy and the server's `LogApiFilter` — and stamps no per-call `api` tag.
     *
     * WHY a declaration and not a suppression switch: shipping a log over a logged transport logs
     * about shipping logs — the line describing the call IS the thing being shipped, and emitting it
     * feeds the next batch its own payload. The two mechanisms that do not know the endpoint both
     * failed in prod (see #976) — a wall-clock "we are shipping" boolean swallowed unrelated lines
     * including an error alarm, and a logger-name allowlist was incomplete by construction the moment
     * anyone added a logger, producing a steady-state 4-lines-per-second request loop on an idle page.
     * The ENDPOINT is the only stable, declarative fact, so it is where the decision belongs.
     *
     * Rides the route metadata for the same reason {@link formPost} and {@link rawBody} do: the
     * consumer branches on the ROUTE, without knowing the apiClass/methodName.
     *
     * Default false: absent means the ordinary, fully-logged route. The quiet path is the one you
     * have to say out loud, so `grep -rn noLogging` lists every endpoint webpieces stops logging.
     */
    noLogging?: boolean;
    /**
     * An app MAY upgrade (reload onto a newer deployed bundle) while this call is in flight, and the
     * call neither blocks nor arms that upgrade.
     *
     * By default every RPC participates in the app's upgrade decision: the app must not upgrade while
     * it is in flight, and it counts toward the "finished with a SUCCESS result" boundary at which an
     * app typically arms its seamless upgrade. That default is the safe one — reloading under an
     * in-flight write or download loses it. A call nobody asked for, and that is harmless to cut off
     * (a log shipper, a heartbeat), declares `true` so it can neither hold an upgrade hostage nor be
     * the success that triggers one.
     *
     * WHY separate from {@link hideProgress}: apps commonly arm an upgrade off their progress bar's
     * request group, so hiding a call from the bar used to drop it out of the upgrade decision as a
     * side effect. A hidden background download must still block an upgrade until it succeeds; only
     * this flag, said out loud, lets a call stop participating.
     *
     * webpieces only declares and carries it (`RouteMetadata.allowUpgradeInFlight`); the app's
     * `RequestLifecycleListener` / upgrade logic decides what to do with it. Default false.
     * `grep -rn allowUpgradeInFlight` lists every endpoint an upgrade may cut off.
     */
    allowUpgradeInFlight?: boolean;
    /**
     * This route is NOT part of the CUSTOMER-facing contract. `public-openapi.json` — the document a
     * customer gets, and the only one a publish path uploads — contains no path, no operation, no
     * schema and no prose for it. It is not "rendered with a flag set", it is absent.
     *
     * It is still in `full-private-openapi.json`, and still in `mcp-openapi.json` when it carries
     * `@WpMcpTool`. The reason it is withheld belongs in the method's JSDoc, which is where every
     * other piece of its documentation already lives.
     *
     * WHY A BOOLEAN HERE IS NOT SHIM SHAPE #5, given that `@ApiType` exists precisely to avoid a
     * falsy default meaning "publish": the two operate at different levels and the default here is
     * NOT the permissive one. A contract reaches customers only by declaring
     * `@ApiType(..., EXTERNAL_CUSTOMER)` — one deliberate token per contract — and `hidden` only ever
     * SUBTRACTS from what that token already granted. Omitting it on a contract nobody published to
     * customers publishes nothing. The per-method case it exists for is real and cannot be said at
     * class level: a NEW endpoint on an already-published API, built on main before it is announced.
     *
     * Default false, and `grep -rn "hidden: true"` lists every method withheld from customers.
     *
     * HIDING IS A DOCUMENTATION DECISION AND NEVER AN ACCESS-CONTROL ONE. The route is served exactly
     * as before and is still reachable by anything holding its credential — including an agent, if it
     * also carries `@WpMcpTool`. Declare its authorization as loudly as a published one.
     */
    hidden?: boolean;
    /**
     * This operation may touch systems OUTSIDE this service — a payment processor, a partner's API,
     * the physical world. It feeds MCP's `openWorldHint`, and it is rendered as a sentence in the
     * operation's description so a human integrating against the document sees it too.
     *
     * DEFAULT FALSE, deliberately unlike the MCP specification's own `true` default. MCP defaults to
     * "open world" because it cannot know; webpieces CAN know, because the author of the endpoint is
     * right here. Defaulting to `true` would make the interesting case the silent one and the boring
     * case the one you have to type, which is backwards — and an agent told that every endpoint might
     * reach the outside world has been told nothing. `grep -rn "openWorld: true"` lists the ones that
     * genuinely do.
     */
    openWorld?: boolean;
}

/** An external endpoint must also identify the outside system that calls it. */
export interface ExternalEndpointOptions extends EndpointOptions {
    /** The outside system (`'twilio'`) — graph identity, not display text. */
    calledBy: string;
    /** What that caller is; picks its graph shape. Defaults to `'saas'`. */
    callerKind?: ExternalSystemKind;
}
