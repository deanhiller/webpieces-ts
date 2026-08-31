import { MaskSpec } from './LogFieldMask';
import { AuthMeta } from './auth-mode';

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
     * absolute url for the `@AuthWebhook` hook to verify a vendor signature over. Rides the route
     * metadata for the same reason {@link formPost} does — the transport adapter decides how to read
     * the body from the ROUTE, without knowing the apiClass/methodName.
     */
    readonly rawBody: boolean;

    constructor(
        httpMethod: string,
        path: string,
        methodName: string,
        controllerClassName?: string,
        authMeta?: AuthMeta,
        apiName?: string,
        formPost: boolean = false,
        mask?: MaskSpec,
        rawBody: boolean = false,
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
    }
}
