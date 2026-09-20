import { ExternalSystemKind } from './external-caller';
import { ContractHttpMethod, EndpointResponseType } from './HttpContract';

/** Options for one `@Endpoint`, stored parallel to the method-to-path metadata. */
export interface EndpointOptions {
    /** HTTP verb for this route. Defaults to POST. */
    httpMethod?: ContractHttpMethod;
    /** Return only a JSON body (default), or the full transport-neutral status/header/body value. */
    responseType?: EndpointResponseType;
    /**
     * Parse the request body as application/x-www-form-urlencoded instead of JSON. The request
     * DTO must be flat; urlencoded has no nesting. Default false = JSON.
     */
    formPost?: boolean;
    /**
     * Retain the verbatim request bytes and absolute URL for a `@WpAuthWebhook` callback to verify.
     * This is retention, not new buffering: the Express adapter already accumulates the body.
     *
     * `@WpAuthWebhook` requires this option at wiring time. It combines with `formPost` for vendors
     * that sign flat form bodies, e.g. `{ formPost: true, rawBody: true }`.
     */
    rawBody?: boolean;
    /**
     * This route is plumbing the USER did not ask for — a log shipper, a heartbeat, a telemetry
     * flush. It is not progress to report, and it must not be logged as an api call, because the
     * line it would write is itself the thing being shipped.
     *
     * Rides the route metadata for the same reason {@link formPost} and {@link rawBody} do: the
     * consumer branches on the ROUTE, without knowing the apiClass/methodName. Two consumers read
     * it today — {@link LogApiCallImpl} emits no `[API-*-req]`/`[API-*-resp-*]` line for the call,
     * and an app's `RequestLifecycleListener` can skip its progress bar and its own RPC
     * instrumentation.
     *
     * WHY a declaration and not a suppression switch: shipping a log over a logged transport logs
     * about shipping logs. The two mechanisms that do not know the endpoint both failed in prod
     * (see #976) — a wall-clock "we are shipping" boolean swallowed unrelated lines including an
     * error alarm, and a logger-name allowlist was incomplete by construction the moment anyone
     * added a logger, producing a steady-state 4-lines-per-second request loop on an idle page.
     * The ENDPOINT is the only stable, declarative fact, so it is where the decision belongs.
     *
     * Default false: absent means the ordinary, fully-logged route. The quiet path is the one you
     * have to say out loud, so `grep -rn background` lists every endpoint webpieces stops logging.
     */
    background?: boolean;
}

/** An external endpoint must also identify the outside system that calls it. */
export interface ExternalEndpointOptions extends EndpointOptions {
    /** The outside system (`'twilio'`) — graph identity, not display text. */
    calledBy: string;
    /** What that caller is; picks its graph shape. Defaults to `'saas'`. */
    callerKind?: ExternalSystemKind;
}
