import 'reflect-metadata';
import { MaskSpec, MaskMode } from './LogFieldMask';
import { DEFAULT_CALLER_KIND, ENDPOINT_CALLER_KEY, ExternalCaller, ExternalSystemKind, getEndpointCaller } from './external-caller';

/**
 * Metadata keys for storing API routing information.
 * These keys are used by both server-side (routing) and client-side (client generation).
 */
export const METADATA_KEYS = {
    API_PATH: 'webpieces:api-path',
    ENDPOINTS: 'webpieces:endpoints',
    AUTH_META: 'webpieces:auth-meta',
    /** 'rpc' (default, sync request/response) vs 'pubsub' (fire-and-forget cloud task). */
    API_KIND: 'webpieces:api-kind',
    /** Per-method Cloud Tasks queue-name override (set via @Queue). */
    QUEUE_OVERRIDE: 'webpieces:queue-override',
    /** Per-method @Endpoint options (e.g. formPost), parallel to ENDPOINTS. */
    ENDPOINT_OPTIONS: 'webpieces:endpoint-options',
    /** Per-method @Endpoint trigger kind (rpc | cloudtasks | cron | external), parallel to ENDPOINTS. */
    ENDPOINT_KIND: 'webpieces:endpoint-kind',
    /** Per-method declared external CALLER (only for kind 'external'), parallel to ENDPOINTS. */
    ENDPOINT_CALLER: ENDPOINT_CALLER_KEY,
    /** Per-method @MaskLog spec (which DTO fields the LogApiCall path masks). */
    MASK_LOG: 'webpieces:mask-log',
};

/**
 * WHAT TRIGGERS an endpoint at runtime — the single fact that decides how the runtime architecture
 * graph draws it, and which Terraform resource must exist for it to ever fire:
 *
 *  - `rpc`        — a caller in this repo (or a browser) calls it synchronously. A direct arrow.
 *  - `cloudtasks` — a producer ENQUEUES it; Cloud Tasks delivers it later. Drawn producer → queue →
 *                   consumer, one queue node per METHOD (see {@link Queue}). Producer and consumer
 *                   being the SAME service is legal and common — the queue decouples them.
 *  - `cron`       — a scheduler fires it on a clock. Nothing in-repo calls it; drawn hanging off a
 *                   clock symbol. Backed by a Cloud Scheduler job.
 *  - `external`   — a system OUTSIDE this repo drives it (a GCP Pub/Sub push subscription, a Twilio
 *                   or Gmail webhook). Drawn as an inbound dashed arrow from that system.
 *
 * Declared PER METHOD, because one api class routinely mixes them: an admin contract can have
 * caller-driven endpoints AND a nightly cron sweep. A class-level marker cannot express that, which
 * is exactly why the graph could not tell these apart before.
 */
export type EndpointKind = 'rpc' | 'cloudtasks' | 'cron' | 'external';

/**
 * Options for a single @Endpoint. Kept in a metadata map PARALLEL to ENDPOINTS so the existing
 * `Record<methodName, path>` shape every consumer iterates stays unchanged.
 */
export interface EndpointOptions {
    /**
     * Parse the request body as application/x-www-form-urlencoded (flat key→value) instead of JSON.
     * For EXTERNAL webhooks (e.g. Twilio) that post form-encoded. The request DTO must be FLAT —
     * urlencoded has no nesting (unlike JSON). Default false = JSON.
     */
    formPost?: boolean;
}

/**
 * Options for an `external` @Endpoint: everything {@link EndpointOptions} carries, PLUS a REQUIRED
 * declaration of WHO is calling. See {@link Endpoint} for why, `external-caller.ts` for identity.
 */
export interface ExternalEndpointOptions extends EndpointOptions {
    /** The outside system that posts here (`'twilio'`) — the graph node IDENTITY, not display text. */
    calledBy: string;
    /** What that caller IS; picks the node's shape. Defaults to `'saas'` (see DEFAULT_CALLER_KIND). */
    callerKind?: ExternalSystemKind;
}

/**
 * Route metadata stored per-method at runtime.
 * Used internally by http-routing and http-client as the runtime representation
 * of a route. Constructed from @ApiPath + @Endpoint metadata by ProxyClient
 * and ApiRoutingFactory.
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
     * ONCE here at route-build time and handed to {@link LogApiCall} via ApiMethodInfo, so the per-call
     * log path pays for masking only on routes that opted in (the rest stay on plain JSON.stringify).
     */
    readonly mask?: MaskSpec;

    constructor(
        httpMethod: string,
        path: string,
        methodName: string,
        controllerClassName?: string,
        authMeta?: AuthMeta,
        apiName?: string,
        formPost: boolean = false,
        mask?: MaskSpec,
    ) {
        this.httpMethod = httpMethod;
        this.path = path;
        this.methodName = methodName;
        this.controllerClassName = controllerClassName;
        this.authMeta = authMeta;
        this.apiName = apiName;
        this.formPost = formPost;
        this.mask = mask;
    }
}

/**
 * The service-to-service / user auth mode of an endpoint. Discriminated union so
 * a filter can `switch (mode.kind)` and get the data it needs, exhaustively.
 *
 * - `public`        → no auth check
 * - `jwt`           → user-facing JWT (optionally role-gated), validated by the app AuthFilter
 * - `oidc`          → Google OIDC service-to-service (Cloud Tasks delivery / cross-service RPC);
 *                     `callers` is the allow-list of caller service accounts ('self' = this service's SA)
 * - `shared-secret` → constant-time compare of a header against the secret bound for `secretKey`
 */
/**
 * JwtRequirement - the endpoint's JWT authorization requirement, OPAQUE to the framework. The
 * default JwtHook.authorizeJwt enforces `roles` (any-of; empty = any authenticated user); apps
 * add their OWN fields (inOrg, tenant, feature, ...) via @Auth({...}) and override authorizeJwt to
 * enforce them. This is the pluggable seam: the framework authenticates, the app authorizes.
 */
export interface JwtRequirement {
    roles?: string[];
    // webpieces-disable no-any-unknown -- app-defined authorization fields (inOrg, tenant, ...)
    [field: string]: unknown;
}

export type AuthMode =
    | { kind: 'public' }
    | { kind: 'jwt'; requirement: JwtRequirement }
    | { kind: 'oidc'; callers: string[] }
    | { kind: 'shared-secret'; secretKey: string };

/**
 * Auth metadata attached to a class or method via one of the auth decorators
 * (@Public / @AuthJwt / @AuthJwtAllRolesAllowed / @Auth / @AuthOidc / @AuthSharedSecret).
 *
 * Carries a discriminated {@link AuthMode} and nothing else. It USED to also expose
 * `authenticated`/`roles` getters "for back-compat with readers that only understand the user-JWT
 * model" — deleted, because nothing read them: every reader (AuthFilter, BrowserProxyClient,
 * ProxyClient) switches on `mode.kind`, which is the whole point of the discriminated union. A
 * flattened view of a union is a second spelling of it, and the flattened one silently answers
 * `authenticated: true` for oidc and shared-secret too.
 */
export class AuthMeta {
    mode: AuthMode;

    constructor(mode: AuthMode) {
        this.mode = mode;
    }
}

/**
 * @ApiPath(basePath) - Class decorator that marks a class as an API definition
 * and sets the base path for all endpoints.
 *
 * Usage:
 * ```typescript
 * @AuthJwt('admin')
 * @ApiPath('/api/save')
 * abstract class SaveApi {
 *   @Endpoint('/item', 'rpc')
 *   save(request: SaveRequest): Promise<SaveResponse> { ... }
 * }
 * ```
 */
export function ApiPath(basePath: string): ClassDecorator {
    // webpieces-disable no-any-unknown -- reflect-metadata decorator API requires any
    return (target: any) => {
        Reflect.defineMetadata(METADATA_KEYS.API_PATH, basePath, target);

        // Initialize endpoints map if not exists
        if (!Reflect.hasMetadata(METADATA_KEYS.ENDPOINTS, target)) {
            Reflect.defineMetadata(METADATA_KEYS.ENDPOINTS, {}, target);
        }
    };
}

/**
 * @Endpoint(path, kind, options?) - Method decorator that registers a POST endpoint at the given
 * path and declares WHAT TRIGGERS it.
 *
 * All endpoints are POST-only (matching gRPC/thrift style).
 *
 * Usage:
 * ```typescript
 * @Endpoint('/item', 'rpc')
 * save(request: SaveRequest): Promise<SaveResponse> { ... }
 *
 * // enqueued by a producer, delivered later by Cloud Tasks:
 * @Endpoint('/send', 'cloudtasks')
 * send(request: SendRequest): Promise<void> { ... }
 *
 * // fired by Cloud Scheduler on a clock, called by nobody in this repo:
 * @Endpoint('/nightly', 'cron')
 * nightly(request: NightlyRequest): Promise<void> { ... }
 *
 * // EXTERNAL webhook posting application/x-www-form-urlencoded (e.g. Twilio):
 * @Endpoint('/hook', 'external', { formPost: true, calledBy: 'twilio' })
 * inbound(request: InboundRequest): Promise<InboundResponse> { ... }
 * ```
 *
 * `kind` is REQUIRED and deliberately positional: it makes every pre-existing single-argument
 * `@Endpoint('/x')` a COMPILE error rather than something a lint rule has to chase, so no endpoint
 * can slip into the runtime architecture graph with its trigger left to guesswork. See
 * {@link EndpointKind} for what each value draws and which Terraform resource backs it.
 *
 * `calledBy` is REQUIRED for `external` FOR EXACTLY THE SAME REASON, enforced by the overloads below:
 * the one box on the runtime graph whose whole job is to say who calls us from outside could only
 * restate OUR OWN contract name, because nothing in the source ever said who the caller was. This is
 * BREAKING for published consumers, intentionally — an existing `@Endpoint(p, 'external', {...})`
 * stops compiling until it names its caller. Migration is one property; see the migration note in
 * `external-caller.ts`. Non-`external` endpoints are completely unaffected.
 *
 * The path write to ENDPOINTS is UNCHANGED (every consumer iterates `[methodName, path]`); kind,
 * options and caller ride PARALLEL ENDPOINT_KIND / ENDPOINT_OPTIONS / ENDPOINT_CALLER maps.
 */
// webpieces-disable no-function-outside-class -- decorator factory; decorators are inherently module-scope
export function Endpoint(path: string, kind: 'external', options: ExternalEndpointOptions): MethodDecorator;
// webpieces-disable no-function-outside-class -- decorator factory; decorators are inherently module-scope
export function Endpoint(path: string, kind: Exclude<EndpointKind, 'external'>, options?: EndpointOptions): MethodDecorator;
// webpieces-disable no-function-outside-class -- decorator factory; decorators are inherently module-scope
export function Endpoint(path: string, kind: EndpointKind, options: EndpointOptions = {}): MethodDecorator {
    // webpieces-disable no-any-unknown -- reflect-metadata decorator API requires any
    return (target: any, propertyKey: string | symbol, _descriptor: PropertyDescriptor) => {
        const metadataTarget = typeof target === 'function' ? target : target.constructor;

        const endpoints: Record<string, string> =
            Reflect.getMetadata(METADATA_KEYS.ENDPOINTS, metadataTarget) || {};

        endpoints[propertyKey as string] = path;

        Reflect.defineMetadata(METADATA_KEYS.ENDPOINTS, endpoints, metadataTarget);

        const kinds: Record<string, EndpointKind> =
            Reflect.getMetadata(METADATA_KEYS.ENDPOINT_KIND, metadataTarget) || {};
        kinds[propertyKey as string] = kind;
        Reflect.defineMetadata(METADATA_KEYS.ENDPOINT_KIND, kinds, metadataTarget);

        const opts: Record<string, EndpointOptions> =
            Reflect.getMetadata(METADATA_KEYS.ENDPOINT_OPTIONS, metadataTarget) || {};
        opts[propertyKey as string] = options;
        Reflect.defineMetadata(METADATA_KEYS.ENDPOINT_OPTIONS, opts, metadataTarget);

        // ONLY for 'external', mirroring how a queue name is recorded only for the kinds that HAVE
        // a queue: a caller on an rpc endpoint would be a fact about nothing.
        const declared = options as ExternalEndpointOptions;
        if (kind !== 'external' || typeof declared.calledBy !== 'string' || declared.calledBy === '') return;
        const callers: Record<string, ExternalCaller> = Reflect.getMetadata(METADATA_KEYS.ENDPOINT_CALLER, metadataTarget) || {};
        callers[propertyKey as string] = new ExternalCaller(declared.callerKind ?? DEFAULT_CALLER_KIND, declared.calledBy);
        Reflect.defineMetadata(METADATA_KEYS.ENDPOINT_CALLER, callers, metadataTarget);
    };
}

/**
 * @MaskLog(fields) - declare which fields of THIS method's request/response DTOs the
 * {@link LogApiCall} logging path must mask, so a secret riding on a DTO (an OAuth refresh token, an
 * id-token JWT) is never written to the logs in cleartext. The REAL value still travels on the wire
 * untouched — masking lives in the logging path only.
 *
 * ```typescript
 * @Endpoint('/account', 'rpc')
 * @MaskLog({ refreshToken: 'full', accessToken: 'last4', credential: 'full' })
 * getEmailAccount(request: GetEmailAccountRequest): Promise<GetEmailAccountResponse> { ... }
 * ```
 *
 * Matching is by field NAME at any depth (nested objects + array elements), so
 * `response.account.refreshToken` is masked. Declared on the SHARED api contract, so BOTH the client
 * `[API-client-*]` and server `[API-server-*]` lines mask it. The spec is read ONCE at route-build
 * time and rides {@link RouteMetadata.mask}, so an unmasked method pays nothing at call time.
 */
// webpieces-disable no-function-outside-class -- decorator factory; decorators are inherently module-scope
export function MaskLog(fields: Record<string, MaskMode>): MethodDecorator {
    const spec = new MaskSpec(fields);
    // webpieces-disable no-any-unknown -- reflect-metadata decorator API requires any
    return (target: any, propertyKey: string | symbol, _descriptor: PropertyDescriptor) => {
        const metadataTarget = typeof target === 'function' ? target : target.constructor;
        const specs: Record<string, MaskSpec> =
            Reflect.getMetadata(METADATA_KEYS.MASK_LOG, metadataTarget) || {};
        specs[propertyKey as string] = spec;
        Reflect.defineMetadata(METADATA_KEYS.MASK_LOG, specs, metadataTarget);
    };
}

/**
 * The @MaskLog spec for one method, or undefined if the method declared none (the common case — the
 * caller then logs the DTO verbatim on the plain JSON.stringify fast path).
 */
// webpieces-disable no-function-outside-class -- reflect-metadata reader, sibling of getEndpointOptions
export function getMaskSpec(apiClass: Function, methodName: string): MaskSpec | undefined {
    const specs: Record<string, MaskSpec> =
        Reflect.getMetadata(METADATA_KEYS.MASK_LOG, apiClass) || {};
    return specs[methodName];
}

/**
 * Shared implementation for every auth decorator: stores an {@link AuthMeta} for
 * the given {@link AuthMode} at class- or method-level, rejecting a second auth
 * decorator on the same target.
 */
function defineAuthMode(mode: AuthMode): ClassDecorator & MethodDecorator {
    const authMeta = new AuthMeta(mode);

    // webpieces-disable no-any-unknown -- reflect-metadata decorator API requires any
    return (target: any, propertyKey?: string | symbol, _descriptor?: PropertyDescriptor) => {
        if (propertyKey !== undefined) {
            // Method decorator
            const metadataTarget = typeof target === 'function' ? target : target.constructor;
            validateNoConflictingDecorators(metadataTarget, propertyKey as string);
            Reflect.defineMetadata(METADATA_KEYS.AUTH_META, authMeta, metadataTarget, propertyKey);
        } else {
            // Class decorator
            validateNoConflictingDecorators(target, undefined);
            Reflect.defineMetadata(METADATA_KEYS.AUTH_META, authMeta, target);
        }
    };
}

/**
 * @Public() - endpoint requires no authentication. Class- or method-level.
 */
export function Public(): ClassDecorator & MethodDecorator {
    return defineAuthMode({ kind: 'public' });
}

/**
 * @AuthJwt(...roles) - user-facing JWT auth, role-gated. The app-level AuthFilter validates the
 * token, then JwtHook.authorizeJwt enforces the roles any-of.
 *
 * AT LEAST ONE ROLE IS REQUIRED, by the signature. `@AuthJwt()` used to compile and produced
 * `roles: []`, which authorizeJwt treats as "any authenticated user" — so the WIDEST grant in the
 * system was also the shortest thing to type, and an absence of arguments was doing the widening.
 * The wide case now has to name itself: {@link AuthJwtAllRolesAllowed}. That makes it greppable and
 * makes forgetting the roles a compile error instead of a silent open endpoint.
 */
// webpieces-disable no-function-outside-class -- decorator factory; decorators are inherently module-scope
export function AuthJwt(firstRole: string, ...moreRoles: string[]): ClassDecorator & MethodDecorator {
    return defineAuthMode({ kind: 'jwt', requirement: { roles: [firstRole, ...moreRoles] } });
}

/**
 * @AuthJwtAllRolesAllowed() - user-facing JWT auth with NO role restriction: every authenticated
 * user gets in. Deliberately a distinct, greppable token rather than `@AuthJwt()` with the roles
 * left off, so "any logged-in user is allowed here" is a decision someone typed on purpose and an
 * auditor can find with one grep.
 */
// webpieces-disable no-function-outside-class -- decorator factory; decorators are inherently module-scope
export function AuthJwtAllRolesAllowed(): ClassDecorator & MethodDecorator {
    return defineAuthMode({ kind: 'jwt', requirement: { roles: [] } });
}

/**
 * @Auth(requirement) - user-facing JWT auth with an APP-DEFINED authorization requirement beyond
 * roles, e.g. `@Auth({ inOrg: true })` or `@Auth({ roles: ['admin'], tenantScoped: true })`. The
 * framework authenticates the JWT (JwtHook.parseJwt), then hands `requirement` + the parsed
 * values to JwtHook.authorizeJwt — which the app overrides to enforce its own policy. This is
 * how clients plug in their own JWT security without touching the framework.
 */
export function Auth(requirement: JwtRequirement): ClassDecorator & MethodDecorator {
    return defineAuthMode({ kind: 'jwt', requirement });
}

/**
 * @AuthOidc(...callers) - Google OIDC service-to-service auth (Cloud Tasks delivery / cross-service
 * RPC). `callers` is an OPTIONAL app-level allow-list of caller service accounts.
 *
 * NO args = TRUST THE EDGE: accept any genuine Google-signed OIDC caller, because a PRIVATE Cloud
 * Run service's edge already gates WHO via `run.invoker` IAM (managed in terraform — one source of
 * truth, no hand-synced list in code). If the service is actually PUBLIC, the verifier logs a loud
 * warning (it can't be the gate then). Pass explicit SAs (`@AuthOidc('svc-a')`) only when you want
 * an additional app-level allow-list as defense-in-depth.
 */
export function AuthOidc(...callers: string[]): ClassDecorator & MethodDecorator {
    return defineAuthMode({ kind: 'oidc', callers });
}

/**
 * @AuthSharedSecret(key) - constant-time compare of an inbound header against the secret bound for
 * `key`. `key` is a LOOKUP KEY (not an env var): the server looks up its accepted {@link SharedSecrets}
 * by this key, and each client looks up the value it sends by the SAME key (see {@link Secrets}).
 * For internal callers that cannot mint OIDC tokens.
 */
export function AuthSharedSecret(key: string): ClassDecorator & MethodDecorator {
    return defineAuthMode({ kind: 'shared-secret', secretKey: key });
}

// ============================================================
// Helper functions
// ============================================================

/**
 * Get the base path from @ApiPath decorator.
 */
export function getApiPath(apiClass: Function): string | undefined {
    return Reflect.getMetadata(METADATA_KEYS.API_PATH, apiClass);
}

/**
 * Get all endpoints from @Endpoint decorators.
 * Returns a record of methodName -> endpoint path.
 */
export function getEndpoints(apiClass: Function): Record<string, string> | undefined {
    return Reflect.getMetadata(METADATA_KEYS.ENDPOINTS, apiClass);
}

/**
 * Every method's declared trigger kind, as `methodName -> kind`. Parallel to {@link getEndpoints}.
 * Empty for a class carrying no @Endpoint at all.
 */
// webpieces-disable no-function-outside-class -- reflect-metadata reader, sibling of getEndpoints
export function getEndpointKinds(apiClass: Function): Record<string, EndpointKind> {
    return Reflect.getMetadata(METADATA_KEYS.ENDPOINT_KIND, apiClass) || {};
}

/**
 * What triggers ONE method, or undefined when the method carries no @Endpoint.
 *
 * Defaults to nothing rather than to 'rpc': `kind` is a required argument, so a missing entry means
 * "this is not an endpoint", never "an endpoint that forgot to say". Silently defaulting here would
 * put an undeclared cron or webhook back into the graph as a normal rpc call — the exact blindness
 * the required argument exists to remove.
 */
// webpieces-disable no-function-outside-class -- reflect-metadata reader, sibling of getEndpoints
export function getEndpointKind(apiClass: Function, methodName: string): EndpointKind | undefined {
    return getEndpointKinds(apiClass)[methodName];
}

/**
 * Get the @Endpoint options for one method (empty object if the method had no options).
 */
// webpieces-disable no-function-outside-class -- reflect-metadata reader, sibling of getEndpoints
export function getEndpointOptions(apiClass: Function, methodName: string): EndpointOptions {
    const opts: Record<string, EndpointOptions> =
        Reflect.getMetadata(METADATA_KEYS.ENDPOINT_OPTIONS, apiClass) || {};
    return opts[methodName] ?? {};
}

/**
 * Fail-fast at wiring time when an `external` endpoint declared no caller. The {@link Endpoint}
 * overloads already make that a COMPILE error; this is the backstop for the ways TS is bypassed —
 * a JS caller, an `as any` options object, a hand-rolled Reflect.defineMetadata.
 * @throws Error naming the first external endpoint with no `calledBy`.
 */
// webpieces-disable no-function-outside-class -- wiring-time assert, sibling of assertEveryEndpointHasAuthMode
export function assertEveryExternalEndpointDeclaresCaller(apiClass: Function): void {
    const kinds = getEndpointKinds(apiClass);
    for (const methodName of Object.keys(kinds)) {
        if (kinds[methodName] !== 'external' || getEndpointCaller(apiClass, methodName) !== undefined) continue;
        throw new Error(
            `External endpoint '${methodName}' in ${apiClass.name || 'Unknown'} declares no caller. Say WHO ` +
            `posts to it: @Endpoint(path, 'external', { calledBy: '<vendor>' }) — the runtime architecture ` +
            `graph cannot name an inbound caller it was never told about.`,
        );
    }
}

/**
 * True when the method's @Endpoint declared `{ formPost: true }` — its body is
 * application/x-www-form-urlencoded (flat), not JSON.
 */
// webpieces-disable no-function-outside-class -- reflect-metadata reader, sibling of getEndpoints
export function isFormPost(apiClass: Function, methodName: string): boolean {
    return getEndpointOptions(apiClass, methodName).formPost === true;
}

/**
 * Check if a class has @ApiPath decorator.
 */
export function isApiPath(apiClass: Function): boolean {
    return Reflect.hasMetadata(METADATA_KEYS.API_PATH, apiClass);
}

/**
 * Get auth metadata for a specific method, falling back to class-level auth.
 * Method-level auth takes precedence over class-level auth.
 */
export function getAuthMeta(apiClass: Function, methodName?: string): AuthMeta | undefined {
    // Check method-level first
    if (methodName) {
        const methodAuth = Reflect.getMetadata(METADATA_KEYS.AUTH_META, apiClass, methodName);
        if (methodAuth) {
            return methodAuth;
        }
    }

    // Fall back to class-level
    return Reflect.getMetadata(METADATA_KEYS.AUTH_META, apiClass);
}

/**
 * Get the auth mode for a method (falling back to class-level), or undefined.
 * Convenience wrapper over getAuthMeta for callers that only want the mode.
 */
export function getAuthMode(apiClass: Function, methodName?: string): AuthMode | undefined {
    return getAuthMeta(apiClass, methodName)?.mode;
}

/**
 * The ONE prescription for "this endpoint declares no auth". Exported and shared because there are
 * two places that raise it — here and http-routing's ApiRoutingFactory — and they had drifted into
 * teaching two different menus, one of which omitted @AuthJwtAllRolesAllowed() and @Auth({...}). A
 * message that teaches an incomplete API is the same defect as an API with two spellings: whichever
 * menu the caller happens to hit becomes the API they believe exists.
 *
 * It leads with the ROLE-GATED member on purpose. The safe-by-default reading order matters more than
 * alphabetical: the first thing offered should not be the widest grant.
 */
export const MISSING_AUTH_DECORATOR_FIX =
    'Add one of @AuthJwt(...roles) / @AuthJwtAllRolesAllowed() / @Auth({...}) / @Public() / ' +
    '@AuthOidc(...callers) / @AuthSharedSecret(key) to the class or method.';

/**
 * Fail-fast at wiring time if any endpoint lacks an auth mode. Both the server
 * (ApiRoutingFactory) and the task/rpc clients call this so a missing auth
 * decorator is a startup error, never a silent open endpoint.
 * @throws Error naming the first endpoint with no auth decorator, via {@link MISSING_AUTH_DECORATOR_FIX}.
 */
export function assertEveryEndpointHasAuthMode(apiClass: Function): void {
    const apiName = apiClass.name || 'Unknown';
    const endpoints = getEndpoints(apiClass) || {};
    for (const methodName of Object.keys(endpoints)) {
        if (!getAuthMeta(apiClass, methodName)) {
            throw new Error(
                `Endpoint '${methodName}' in ${apiName} has no auth decorator. ` +
                MISSING_AUTH_DECORATOR_FIX,
            );
        }
    }
}

// ============================================================
// API kind (RPC vs PubSub/Cloud Tasks) + queue naming
// ============================================================

/**
 * API kind. 'rpc' = synchronous request/response (http-client ↔ ApiRoutingFactory).
 * 'pubsub' = fire-and-forget cloud task; the enqueue client (cloudtasks-client)
 * schedules a Cloud Task that is later delivered to the SAME controller endpoint.
 */
export type ApiKind = 'rpc' | 'pubsub';

/**
 * @Rpc() - marks an API class as synchronous request/response (the default kind).
 * Present mostly for symmetry/readability; an undecorated API is treated as 'rpc'.
 */
export function Rpc(): ClassDecorator {
    // webpieces-disable no-any-unknown -- reflect-metadata decorator API requires any
    return (target: any) => {
        Reflect.defineMetadata(METADATA_KEYS.API_KIND, 'rpc' as ApiKind, target);
    };
}

/**
 * @PubSub() - marks an API class as fire-and-forget over Cloud Tasks. Every method
 * MUST return Promise<void> (a compile-time contract on the abstract API). The
 * enqueue client and the controller share this one class, exactly like RPC.
 */
export function PubSub(): ClassDecorator {
    // webpieces-disable no-any-unknown -- reflect-metadata decorator API requires any
    return (target: any) => {
        Reflect.defineMetadata(METADATA_KEYS.API_KIND, 'pubsub' as ApiKind, target);
    };
}

/**
 * @Queue(name) - override the Cloud Tasks queue name for a @PubSub method. Default
 * (no decorator) is `${ApiClassName}-${methodName}`, matched 1:1 by Terraform.
 */
export function Queue(name: string): MethodDecorator {
    // webpieces-disable no-any-unknown -- reflect-metadata decorator API requires any
    return (target: any, propertyKey: string | symbol, _descriptor: PropertyDescriptor) => {
        const metadataTarget = typeof target === 'function' ? target : target.constructor;
        const overrides: Record<string, string> =
            Reflect.getMetadata(METADATA_KEYS.QUEUE_OVERRIDE, metadataTarget) || {};
        overrides[propertyKey as string] = name;
        Reflect.defineMetadata(METADATA_KEYS.QUEUE_OVERRIDE, overrides, metadataTarget);
    };
}

/**
 * Get the API kind. Defaults to 'rpc' when neither @Rpc nor @PubSub is present.
 */
export function getApiKind(apiClass: Function): ApiKind {
    return (Reflect.getMetadata(METADATA_KEYS.API_KIND, apiClass) as ApiKind) ?? 'rpc';
}

/**
 * Assert the API class is of the expected kind (used by the clients: the RPC
 * client rejects a @PubSub api and vice-versa).
 * @throws Error if the kind doesn't match.
 */
export function assertApiKind(apiClass: Function, expected: ApiKind): void {
    const actual = getApiKind(apiClass);
    if (actual !== expected) {
        const apiName = apiClass.name || 'Unknown';
        throw new Error(
            `API ${apiName} is @${actual === 'pubsub' ? 'PubSub' : 'Rpc'} but a ` +
            `${expected === 'pubsub' ? '@PubSub (cloud task)' : '@Rpc'} API was required here.`,
        );
    }
}

/**
 * Which {@link EndpointKind}s each {@link ApiKind} may declare. A @PubSub contract is delivered
 * asynchronously by definition, so `rpc` is meaningless on it; an @Rpc contract has no queue, so
 * `cloudtasks`/`cron` on it would name a queue/schedule nothing could ever deliver to. `external`
 * is legal on both — a webhook posts synchronously, a push subscription does not.
 *
 * Shared so the wiring-time assert below and the build-time architecture scan enforce ONE rule.
 */
export const ENDPOINT_KINDS_BY_API_KIND: Record<ApiKind, readonly EndpointKind[]> = {
    rpc: ['rpc', 'external'],
    pubsub: ['cloudtasks', 'cron', 'external'],
};

/**
 * Validate @PubSub conventions at wiring time: the class must be @ApiPath + @PubSub, declare at
 * least one endpoint, and every endpoint must declare a kind this api kind can actually deliver.
 * (Return-type is Promise<void>, a compile-time contract — TS erases types at runtime so it cannot
 * be re-checked here.)
 * @throws Error if conventions are violated.
 */
export function assertPubSubConventions(apiClass: Function): void {
    assertApiKind(apiClass, 'pubsub');
    const apiName = apiClass.name || 'Unknown';
    if (!isApiPath(apiClass)) {
        throw new Error(`@PubSub API ${apiName} must also be decorated with @ApiPath()`);
    }
    const endpoints = getEndpoints(apiClass) || {};
    if (Object.keys(endpoints).length === 0) {
        throw new Error(`@PubSub API ${apiName} declares no @Endpoint methods`);
    }
    const allowed = ENDPOINT_KINDS_BY_API_KIND.pubsub;
    const kinds = getEndpointKinds(apiClass);
    for (const methodName of Object.keys(endpoints)) {
        const kind = kinds[methodName];
        if (kind !== undefined && allowed.includes(kind)) continue;
        throw new Error(
            `@PubSub API ${apiName}.${methodName} declares @Endpoint(..., '${kind ?? 'missing'}') — a ` +
            `@PubSub contract is delivered through a queue, so it must be one of: ${allowed.join(' | ')}.`,
        );
    }
}

/**
 * Resolve the Cloud Tasks queue name for a @PubSub method: the @Queue override if
 * present, else `${ApiClassName}-${methodName}`.
 */
export function getQueueName(apiClass: Function, methodName: string): string {
    const overrides: Record<string, string> =
        Reflect.getMetadata(METADATA_KEYS.QUEUE_OVERRIDE, apiClass) || {};
    return overrides[methodName] ?? `${apiClass.name || 'Unknown'}-${methodName}`;
}

/**
 * Validate that a class/method doesn't have conflicting auth decorators.
 * @throws Error if multiple auth decorators are found on the same target.
 */
export function validateNoConflictingDecorators(apiClass: Function, methodName: string | undefined): void {
    const existing = methodName
        ? Reflect.getMetadata(METADATA_KEYS.AUTH_META, apiClass, methodName)
        : Reflect.getMetadata(METADATA_KEYS.AUTH_META, apiClass);

    if (existing) {
        const targetName = apiClass.name || 'Unknown';
        const location = methodName ? `method '${methodName}' of ${targetName}` : `class ${targetName}`;
        throw new Error(
            `Conflicting auth decorator on ${location}. ` +
            `Only one of @Public() / @AuthJwt(...) / @AuthJwtAllRolesAllowed() / @Auth({...}) / ` +
            `@AuthOidc(...) / @AuthSharedSecret(...) is allowed per target.`
        );
    }
}
