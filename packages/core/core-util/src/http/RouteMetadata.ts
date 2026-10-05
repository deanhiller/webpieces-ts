import { MaskSpec } from './LogFieldMask';
import { AuthMeta } from './auth-mode';
import { EndpointResponseType, HttpParameterBinding } from './HttpContract';
import { StreamingEndpointMetadata } from './StreamingContract';
import { EndpointOperation } from './HttpEndpointOptions';

/**
 * Route metadata stored per-method at runtime.
 * Used internally by http-routing and http-client as the runtime representation
 * of a route. Constructed from @ApiPath + @Endpoint metadata by ProxyClient
 * and ApiRoutingFactory.
 *
 * Lives in its own file (one class per file) purely for file size, exactly as `api-kind.ts` and
 * `external-caller.ts` were split off `decorators.ts` before it. Nothing about its role changed.
 */
export class RouteMetadata {
    apiClass?: Function;
    // webpieces-disable no-any-unknown -- erased application policy is validated by AuthorizationHook at server startup
    authorization?: import('./authorization').AuthorizationRequirement<unknown>;
    localOnly = false;

    /** Clients clone metadata per call so a concrete winning mode governs both trust directions. */
    withSelectedAuth(method: import('./auth-mode').AuthMode): RouteMetadata {
        if (!this.authMeta?.methods.includes(method)) throw new Error('Selected credential is not declared by this endpoint.');
        const route = Object.assign(new RouteMetadata(this.httpMethod, this.path, this.methodName, this.operation), this);
        route.authMeta = new AuthMeta([method], method.kind === 'public' ? this.authMeta.publicReason : undefined);
        return route;
    }
    httpMethod: string;
    path: string;
    methodName: string;
    controllerClassName?: string;
    authMeta?: AuthMeta;
    /** The API contract class name (e.g. 'SaveApi') — distinct from the controller name. */
    apiName?: string;
    /**
     * True when @Endpoint(..., { formPost: true }): the body is application/x-www-form-urlencoded
     * (flat key→value), not JSON. Rides the route metadata so the per-route body parse can branch
     * without knowing the apiClass/methodName. Default false = JSON.
     */
    readonly formPost: boolean;
    /**
     * The @MaskLog field-mask spec for this route, or undefined when the method declared none. Read
     * ONCE here at route-build time and handed to {@link LogApiCallImpl} via ApiMethodInfo, so the per-call
     * log path pays for masking only on routes that opted in (the rest stay on plain JSON.stringify).
     */
    readonly mask?: MaskSpec;
    /**
     * True when @Endpoint(..., { rawBody: true }): the transport must retain the verbatim bytes +
     * absolute url for the `webhook(...)` hook to verify a vendor signature over. Rides the route
     * metadata for the same reason {@link formPost} does — the transport adapter decides how to read
     * the body from the ROUTE, without knowing the apiClass/methodName.
     */
    readonly rawBody: boolean;
    /**
     * True when @Endpoint(..., { hideProgress: true }): the app should show no progress UI for this
     * call. webpieces does not act on it; an app's `RequestLifecycleListener.onRequestStart/onRequestEnd`
     * reads it from the ROUTE, for the same reason {@link formPost} and {@link rawBody} ride here —
     * the consumer branches without knowing the apiClass/methodName. Default false = the call drives
     * the progress UI.
     */
    readonly hideProgress: boolean;
    /**
     * True when @Endpoint(..., { noLogging: true }): read by {@link LogApiCallImpl} (via
     * ApiMethodInfo, exactly as {@link mask} is) so no `[API-*-req]`/`[API-*-resp-*]` line is
     * emitted for the call, on the client or the server. Default false = an ordinary, fully-logged
     * route.
     */
    readonly noLogging: boolean;
    /**
     * True when @Endpoint(..., { allowUpgradeInFlight: true }): an app may upgrade while this call is
     * in flight, and the call neither blocks nor arms an upgrade. webpieces only carries it; the
     * app's `RequestLifecycleListener` / upgrade logic reads it. Default false = the app must not
     * upgrade while the call is in flight, and its success counts toward arming one.
     */
    readonly allowUpgradeInFlight: boolean;

    constructor(
        httpMethod: string,
        path: string,
        methodName: string,
        /** Explicit side-effect semantics; deliberately independent of the HTTP verb. */
        readonly operation: EndpointOperation,
        controllerClassName?: string,
        authMeta?: AuthMeta,
        apiName?: string,
        formPost: boolean = false,
        mask?: MaskSpec,
        rawBody: boolean = false,
        /** Explicit path/query mappings, in API declaration order. */
        readonly parameterBindings: readonly HttpParameterBinding[] = [],
        /** The sole unannotated POST parameter, or undefined for a bodyless route. */
        readonly bodyParameterIndex?: number,
        /** Whether clients receive only the body or the complete status/header/body response. */
        readonly responseType: EndpointResponseType = 'body',
        /** Present only for `(ResponseStream) => Promise<RequestStream>` contracts. */
        readonly streaming?: StreamingEndpointMetadata,
        hideProgress: boolean = false,
        noLogging: boolean = false,
        allowUpgradeInFlight: boolean = false,
    ) {
        this.httpMethod = httpMethod;
        this.path = path;
        this.methodName = methodName;
        this.controllerClassName = controllerClassName;
        this.authMeta = authMeta;
        this.apiName = apiName;
        this.formPost = formPost;
        this.mask = mask;
        this.rawBody = rawBody;
        this.parameterBindings = parameterBindings;
        this.bodyParameterIndex = bodyParameterIndex;
        this.responseType = responseType;
        this.streaming = streaming;
        this.hideProgress = hideProgress;
        this.noLogging = noLogging;
        this.allowUpgradeInFlight = allowUpgradeInFlight;
    }
}
