import 'reflect-metadata';
import { MaskSpec, MaskMode } from './LogFieldMask';
import {
    DEFAULT_CALLER_KIND,
    ENDPOINT_CALLER_KEY,
    ExternalCaller,
    getEndpointCaller,
} from './external-caller';
// The TYPE layer these decorators attach — split out for file size only (see auth-mode.ts).
import { ApiKeyCredentials, AuthMeta, AuthMode, JwtRequirement } from './auth-mode';
import {
    EndpointOperation,
    EndpointOptions,
    ExternalEndpointOptions,
    READ,
    WRITE_IDEMPOTENT,
    WRITE,
} from './HttpEndpointOptions';
import { GET, HttpMethod, POST } from './HttpContract';
import { HTTP_PARAMETERS_METADATA_KEY } from './http-parameter-decorators';

export type { EndpointOptions, ExternalEndpointOptions } from './HttpEndpointOptions';
export type { EndpointOperation } from './HttpEndpointOptions';
export { READ, WRITE_IDEMPOTENT, WRITE } from './HttpEndpointOptions';
export type { HttpMethod } from './HttpContract';
export { GET, POST } from './HttpContract';
export { PathParam, QueryParam, getHttpParameterDeclarations } from './http-parameter-decorators';

/**
 * Metadata keys for storing API routing information.
 * These keys are used by both server-side (routing) and client-side (client generation).
 */
export const METADATA_KEYS = {
    API_PATH: 'webpieces:api-path',
    ENDPOINTS: 'webpieces:endpoints',
    AUTH_META: 'webpieces:auth-meta',
    /** Method names carrying one of the canonical authorization decorators. */
    AUTH_METHODS: 'webpieces:auth-methods',
    /** 'rpc' (default, sync request/response) vs 'pubsub' (fire-and-forget cloud task). */
    API_KIND: 'webpieces:api-kind',
    /** Per-method Cloud Tasks queue-name override (set via @Queue). */
    QUEUE_OVERRIDE: 'webpieces:queue-override',
    /** Per-method @Endpoint options (e.g. formPost), parallel to ENDPOINTS. */
    ENDPOINT_OPTIONS: 'webpieces:endpoint-options',
    /** Per-method required HTTP method, parallel to ENDPOINTS. */
    ENDPOINT_HTTP_METHOD: 'webpieces:endpoint-http-method',
    /** Per-method required read/write semantics, parallel to ENDPOINTS. */
    ENDPOINT_OPERATION: 'webpieces:endpoint-operation',
    /** Per-method @Endpoint trigger kind (rpc | cloudtasks | cron | external), parallel to ENDPOINTS. */
    ENDPOINT_KIND: 'webpieces:endpoint-kind',
    /** Per-method declared external CALLER (only for kind 'external'), parallel to ENDPOINTS. */
    ENDPOINT_CALLER: ENDPOINT_CALLER_KEY,
    /** Per-method @MaskLog spec (which DTO fields the LogApiCall path masks). */
    MASK_LOG: 'webpieces:mask-log',
    /** Per-method opt-in metadata for publishing an RPC endpoint as an MCP tool. */
    MCP_TOOLS: 'webpieces:mcp-tools',
    /** Per-method PERMANENT exclusion from MCP, with the reason — see @InvalidEndpointForMcp. */
    MCP_INVALID: 'webpieces:mcp-invalid',
    /** Per-method request/response event metadata for a typed streaming endpoint. */
    STREAM_ENDPOINTS: 'webpieces:stream-endpoints',
    /** Per-method MCP-user authorization, intentionally separate from HTTP hop auth. */
    MCP_AUTH_JWT: 'webpieces:mcp-auth-jwt',
    /** Per-method explicit path/query parameter declarations, keyed by parameter index. */
    HTTP_PARAMETERS: HTTP_PARAMETERS_METADATA_KEY,
};

/** Nominal backing keeps raw string literals out of endpoint declarations. */
enum EndpointKindValue {
    RPC = 'rpc',
    CLOUDTASKS = 'cloudtasks',
    CRON = 'cron',
    EXTERNAL = 'external',
}

/** Short, statically importable decorator arguments. */
export const RPC = EndpointKindValue.RPC;
export const CLOUDTASKS = EndpointKindValue.CLOUDTASKS;
export const CRON = EndpointKindValue.CRON;
export const EXTERNAL = EndpointKindValue.EXTERNAL;

/** Runtime trigger/delivery owner used by validation, architecture, and infrastructure tooling. */
export type EndpointKind = typeof RPC | typeof CLOUDTASKS | typeof CRON | typeof EXTERNAL;

/** Class decorator that sets the shared base path for all endpoints. */
export function ApiPath(basePath: string): ClassDecorator {
    return (target: Function) => {
        if (Reflect.hasMetadata('webpieces:ipc-api-id', target)) {
            throw new Error(
                `Class ${target.name || 'Unknown'} cannot combine @ApiPath with @WpInternal.`,
            );
        }
        Reflect.defineMetadata(METADATA_KEYS.API_PATH, basePath, target);

        // Initialize endpoints map if not exists
        if (!Reflect.hasMetadata(METADATA_KEYS.ENDPOINTS, target)) {
            Reflect.defineMetadata(METADATA_KEYS.ENDPOINTS, {}, target);
        }
    };
}

/**
 * Registers `@Endpoint(POST, path, WRITE, RPC)`. Method, operation, and trigger are required enum
 * values. Operation is independent of the HTTP verb. EXTERNAL additionally requires `calledBy`.
 * Each classification rides a parallel metadata map while ENDPOINTS remains method-name -> path.
 */
// webpieces-disable no-function-outside-class -- decorator factory; decorators are inherently module-scope
export function Endpoint(
    httpMethod: HttpMethod,
    path: string,
    operation: EndpointOperation,
    kind: typeof EXTERNAL,
    options: ExternalEndpointOptions,
): MethodDecorator;
// webpieces-disable no-function-outside-class -- decorator factory; decorators are inherently module-scope
export function Endpoint(
    httpMethod: HttpMethod,
    path: string,
    operation: EndpointOperation,
    kind: Exclude<EndpointKind, typeof EXTERNAL>,
    options?: EndpointOptions,
): MethodDecorator;
// webpieces-disable no-function-outside-class -- decorator factory; decorators are inherently module-scope
export function Endpoint(
    httpMethod: HttpMethod,
    path: string,
    operation: EndpointOperation,
    kind: EndpointKind,
    options: EndpointOptions = {},
): MethodDecorator {
    validateEndpointClassification(httpMethod, operation, kind);
    // webpieces-disable no-any-unknown -- reflect-metadata decorator API requires any
    return (target: any, propertyKey: string | symbol, _descriptor: PropertyDescriptor) => {
        const metadataTarget = typeof target === 'function' ? target : target.constructor;
        recordEndpointMetadata(
            metadataTarget,
            propertyKey as string,
            httpMethod,
            path,
            operation,
            kind,
            options,
        );
    };
}

// webpieces-disable no-function-outside-class -- runtime validation backs up nominal TS enums
function validateEndpointClassification(
    httpMethod: HttpMethod,
    operation: EndpointOperation,
    kind: EndpointKind,
): void {
    if (!isHttpMethod(httpMethod)) {
        throw new Error(
            `@Endpoint httpMethod must be GET or POST, received '${String(httpMethod)}'.`,
        );
    }
    if (!isEndpointOperation(operation)) {
        throw new Error(
            `@Endpoint operation must be READ, WRITE_IDEMPOTENT, or WRITE, received '${String(operation)}'.`,
        );
    }
    if (!isEndpointKind(kind)) {
        throw new Error(
            `@Endpoint trigger must be RPC, CLOUDTASKS, CRON, or EXTERNAL, received '${String(kind)}'.`,
        );
    }
}

// webpieces-disable no-function-outside-class -- one metadata write shared by the decorator overloads
function recordEndpointMetadata(
    metadataTarget: Function,
    propertyKey: string,
    httpMethod: HttpMethod,
    path: string,
    operation: EndpointOperation,
    kind: EndpointKind,
    options: EndpointOptions,
): void {
    const endpoints: Record<string, string> =
        Reflect.getMetadata(METADATA_KEYS.ENDPOINTS, metadataTarget) || {};

    endpoints[propertyKey] = path;

    Reflect.defineMetadata(METADATA_KEYS.ENDPOINTS, endpoints, metadataTarget);

    const methods: Record<string, HttpMethod> =
        Reflect.getMetadata(METADATA_KEYS.ENDPOINT_HTTP_METHOD, metadataTarget) || {};
    methods[propertyKey] = httpMethod;
    Reflect.defineMetadata(METADATA_KEYS.ENDPOINT_HTTP_METHOD, methods, metadataTarget);

    const operations: Record<string, EndpointOperation> =
        Reflect.getMetadata(METADATA_KEYS.ENDPOINT_OPERATION, metadataTarget) || {};
    operations[propertyKey] = operation;
    Reflect.defineMetadata(METADATA_KEYS.ENDPOINT_OPERATION, operations, metadataTarget);

    const kinds: Record<string, EndpointKind> =
        Reflect.getMetadata(METADATA_KEYS.ENDPOINT_KIND, metadataTarget) || {};
    kinds[propertyKey] = kind;
    Reflect.defineMetadata(METADATA_KEYS.ENDPOINT_KIND, kinds, metadataTarget);

    const opts: Record<string, EndpointOptions> =
        Reflect.getMetadata(METADATA_KEYS.ENDPOINT_OPTIONS, metadataTarget) || {};
    opts[propertyKey] = options;
    Reflect.defineMetadata(METADATA_KEYS.ENDPOINT_OPTIONS, opts, metadataTarget);

    const declared = options as ExternalEndpointOptions;
    if (
        kind !== EXTERNAL ||
        typeof declared.calledBy !== 'string' ||
        declared.calledBy === ''
    )
        return;
    const callers: Record<string, ExternalCaller> =
        Reflect.getMetadata(METADATA_KEYS.ENDPOINT_CALLER, metadataTarget) || {};
    callers[propertyKey] = new ExternalCaller(
        declared.callerKind ?? DEFAULT_CALLER_KIND,
        declared.calledBy,
    );
    Reflect.defineMetadata(METADATA_KEYS.ENDPOINT_CALLER, callers, metadataTarget);
}

/** Declares request/response DTO field names that API logging must mask at any depth. */
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
 * Shared implementation for every auth decorator. Authorization is deliberately
 * method-only: a class-level default is too easy to miss when reviewing one endpoint.
 */
// webpieces-disable no-function-outside-class -- decorator factory; decorators are inherently module-scope
function defineAuthMode(mode: AuthMode): MethodDecorator {
    const authMeta = new AuthMeta(mode);

    // webpieces-disable no-any-unknown -- reflect-metadata decorator API requires any
    return (target: any, propertyKey?: string | symbol, _descriptor?: PropertyDescriptor) => {
        if (propertyKey === undefined) {
            throw new Error(
                'Authorization decorators are method-only; annotate every @Endpoint explicitly.',
            );
        }
        const metadataTarget = typeof target === 'function' ? target : target.constructor;
        if (Reflect.hasMetadata('webpieces:ipc-api-id', metadataTarget)) {
            throw new Error(
                `Internal API ${metadataTarget.name || 'Unknown'} cannot use HTTP authorization decorators.`,
            );
        }
        validateNoConflictingDecorators(metadataTarget, propertyKey as string);
        Reflect.defineMetadata(METADATA_KEYS.AUTH_META, authMeta, metadataTarget, propertyKey);
        const methods = new Set<string>(
            Reflect.getMetadata(METADATA_KEYS.AUTH_METHODS, metadataTarget) || [],
        );
        methods.add(propertyKey as string);
        Reflect.defineMetadata(METADATA_KEYS.AUTH_METHODS, [...methods], metadataTarget);
    };
}

/**
 * @WpAuthPublic(reason) - endpoint intentionally requires no authentication.
 * The non-empty reason makes anonymous exposure an explicit review decision.
 */
// webpieces-disable no-function-outside-class -- decorator factory; decorators are inherently module-scope
export function WpAuthPublic(reason: string): MethodDecorator {
    if (typeof reason !== 'string' || reason.trim() === '') {
        throw new Error(
            '@WpAuthPublic requires a non-empty reason explaining why anonymous access is required.',
        );
    }
    return defineAuthMode({ kind: 'public' });
}

/**
 * @WpAuthJwt(requirement) - THE user-facing JWT decorator, covering the whole user-JWT axis: the
 * compiler-enforced role decision ({@link JwtRoles}) plus app-defined fields ({@link JwtRequirement}).
 *
 * ```typescript
 * @WpAuthJwt({ roles: ['admin', 'editor'] })          // any-of
 * @WpAuthJwt({ allRolesAllowed: true, inOrg: true })  // wide + an app rule enforced by authorizeJwt
 * ```
 *
 * It absorbed the former `@Auth(requirement)` — same argument, same AuthMode, so two spellings of one
 * decision. One decorator per credential kind now: `@WpAuthPublic` / `@WpAuthJwt` / `@WpAuthOidc` /
 * `@WpAuthSharedSecret` / `@WpAuthLocalOnly`.
 */
// webpieces-disable no-function-outside-class -- decorator factory; decorators are inherently module-scope
export function WpAuthJwt(requirement: JwtRequirement): MethodDecorator {
    return defineAuthMode({ kind: 'jwt', requirement });
}

/**
 * The roles an endpoint accepts, or [] when it accepts every authenticated user. The ONE reader of
 * the {@link JwtRoles} union, so no caller has to re-derive "does absent mean wide?" — a question
 * whose two plausible answers is how the widest grant kept hiding behind an absent field.
 */
// webpieces-disable no-function-outside-class -- reflect-metadata reader, sibling of getAuthMode
export function rolesRequired(requirement: JwtRequirement): readonly string[] {
    return requirement.allRolesAllowed === true ? [] : requirement.roles;
}

/**
 * @WpAuthOidc(...callers) - Google OIDC service-to-service auth (Cloud Tasks delivery / cross-service
 * RPC). `callers` is an OPTIONAL app-level allow-list of caller service accounts.
 *
 * NO args = TRUST THE EDGE: accept any genuine Google-signed OIDC caller, because a PRIVATE Cloud
 * Run service's edge already gates WHO via `run.invoker` IAM (managed in terraform — one source of
 * truth, no hand-synced list in code). If the service is actually PUBLIC, the verifier logs a loud
 * warning (it can't be the gate then). Pass explicit SAs (`@WpAuthOidc('svc-a')`) only when you want
 * an additional app-level allow-list as defense-in-depth.
 */
// webpieces-disable no-function-outside-class -- decorator factory; decorators are inherently module-scope
export function WpAuthOidc(...callers: string[]): MethodDecorator {
    return defineAuthMode({ kind: 'oidc', callers });
}

/**
 * @WpAuthSharedSecret(key) - constant-time compare of an inbound header against the secret bound for
 * `key`. `key` is a LOOKUP KEY (not an env var): the server looks up its accepted {@link SharedSecrets}
 * by this key, and each client looks up the value it sends by the SAME key (see {@link Secrets}).
 * For internal callers that cannot mint OIDC tokens.
 */
// webpieces-disable no-function-outside-class -- decorator factory; decorators are inherently module-scope
export function WpAuthSharedSecret(key: string): MethodDecorator {
    return defineAuthMode({ kind: 'shared-secret', secretKey: key });
}

/**
 * @WpAuthWebhook(name) - an OUTSIDE vendor signed this request in its OWN scheme; the app's bound
 * `WebhookAuthCallback` proves it. THE mode for every signed inbound webhook — Sentry, GitHub, Stripe, Slack,
 * Twilio — none of which fits the other kinds: no vendor mints Google OIDC tokens, and none sends its
 * secret (they all send a DERIVATION over the request), so `@WpAuthPublic` was the only reachable posture
 * and `calledBy: 'sentry'` stayed a claim rather than a fact.
 *
 * ```typescript
 * @WpAuthWebhook('sentry')
 * @Endpoint(POST, '/hook/sentry/issue', WRITE, EXTERNAL, { calledBy: 'sentry', rawBody: true })
 * abstract notify(request: SentryIssueHook): Promise<HookAck>;
 * ```
 *
 * `name` is a bare STRING resolved through DI in the server's container, exactly as
 * `@WpAuthOidc('gmail-push')` already is — never a function reference. An api contract is level 0: a
 * direct reference to a verifier would invert the dependency graph and drag a vendor SDK into the
 * browser bundle that imports the same contract.
 *
 * THE FRAMEWORK IMPLEMENTS NO VENDOR CRYPTO, deliberately. Every vendor ships an official validator
 * (`twilio.validateRequest`, `stripe.webhooks.constructEvent`, `@octokit/webhooks-methods`) and every
 * vendor revises its scheme (Twilio added `bodySHA256` for JSON bodies; Stripe versions its header).
 * Reimplementing five of those is signing up to track five security changelogs forever and to be
 * wrong at the moment being wrong matters. The framework hands the hook enough of the raw request to
 * call the vendor's own library — hence the REQUIRED `{ rawBody: true }` (see
 * {@link EndpointOptions.rawBody}), which is checked at wiring time.
 *
 * FAILS CLOSED: with no `WebhookAuthCallback` bound, every `@WpAuthWebhook` endpoint 401s, matching `JwtHook`.
 * Silently allowing an unverified webhook is the one default that must not exist.
 */
// webpieces-disable no-function-outside-class -- decorator factory; decorators are inherently module-scope
export function WpAuthWebhook(name: string): MethodDecorator {
    return defineAuthMode({ kind: 'webhook', name });
}

/**
 * Declares a customer-held API-key regime and its non-empty ordered credential locations. The app's
 * `ApiKeyHook` validates the whole request and supplies trusted context; the declaration only drives
 * contract/spec metadata. Unlike shared-secret auth, partner callers cannot assert trusted context.
 * Missing hooks fail closed with 401.
 */
// webpieces-disable no-function-outside-class -- decorator factory; decorators are inherently module-scope
export function WpAuthApiKey(regime: string, credentials: ApiKeyCredentials): MethodDecorator {
    return defineAuthMode({ kind: 'apikey', regime, credentials });
}

/**
 * @WpAuthLocalOnly() - this endpoint exists ONLY on a developer's machine. Off-local it is not
 * registered as a route at all, and if it is somehow reached it 404s. Method-only, like every
 * authorization decorator, so every endpoint's posture is visible at the method.
 *
 * ```typescript
 * @WpAuthLocalOnly()
 * @Endpoint(POST, '/logs', WRITE, RPC)
 * sendBatch(request: SendLogBatchRequest): Promise<SendLogBatchResponse> { ... }
 * ```
 *
 * WHY IT IS AN AUTH MODE AND NOT A ROUTE-MODULE `if`. Apps hand-rolled this in TWO places kept in
 * sync by a comment: a route module that registered the route only locally, PLUS a
 * `if (env !== 'local') throw new ApiForbiddenError(...)` at the top of the handler. Neither half
 * was visible on the CONTRACT, so nothing reading the api — a human, a generated client, or an
 * agent — could tell this endpoint from a `@WpAuthPublic` one. Both halves are the framework's job now,
 * driven by this ONE declaration on the contract, which is where every other "who may call this"
 * fact already lives.
 *
 * It is DELIBERATELY a peer of @WpAuthPublic / @WpAuthJwt / @WpAuthOidc / @WpAuthSharedSecret / @WpAuthApiKey rather than an
 * option on one of them: one decorator per credential kind, and "local-only" is a different kind of
 * gate — it authenticates nobody, it excludes an entire environment.
 *
 * HOW "local" IS DECIDED: {@link RuntimeLocality}, declared once at startup (a REQUIRED input to
 * `RuntimeSetupOptions`). Undeclared means DEPLOYED, so a forgotten wiring call refuses the endpoint
 * rather than exposing it.
 */
// webpieces-disable no-function-outside-class -- decorator factory; decorators are inherently module-scope
export function WpAuthLocalOnly(): MethodDecorator {
    return defineAuthMode({ kind: 'local-only' });
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

/** The required HTTP method for one endpoint. */
// webpieces-disable no-function-outside-class -- reflect-metadata reader, sibling of getEndpointKind
export function getEndpointHttpMethod(apiClass: Function, methodName: string): HttpMethod {
    const methods: Record<string, HttpMethod> =
        Reflect.getMetadata(METADATA_KEYS.ENDPOINT_HTTP_METHOD, apiClass) || {};
    const method = methods[methodName];
    if (!isHttpMethod(method)) {
        throw new Error(
            `@Endpoint ${apiClass.name || 'Unknown'}.${methodName} must declare GET or POST.`,
        );
    }
    return method;
}

/**
 * Get the @Endpoint options for one method (empty object if the method had no options).
 */
// webpieces-disable no-function-outside-class -- reflect-metadata reader, sibling of getEndpoints
export function getEndpointOptions(apiClass: Function, methodName: string): EndpointOptions {
    const opts: Record<string, EndpointOptions> =
        Reflect.getMetadata(METADATA_KEYS.ENDPOINT_OPTIONS, apiClass) || {};
    const options = opts[methodName];
    if (!options && getEndpoints(apiClass)?.[methodName] === undefined) {
        // Preserve the historical helper behavior for a method that is not an endpoint at all.
        return {} as EndpointOptions;
    }
    return options ?? {};
}

/** Read one endpoint's required side-effect semantics. */
// webpieces-disable no-function-outside-class -- reflect-metadata reader, sibling of getEndpointOptions
export function getEndpointOperation(apiClass: Function, methodName: string): EndpointOperation {
    const operations: Record<string, EndpointOperation> =
        Reflect.getMetadata(METADATA_KEYS.ENDPOINT_OPERATION, apiClass) || {};
    const operation = operations[methodName];
    if (!isEndpointOperation(operation)) {
        throw new Error(
            `@Endpoint ${apiClass.name || 'Unknown'}.${methodName} must declare READ, ` +
                'WRITE_IDEMPOTENT, or WRITE.',
        );
    }
    return operation;
}

// webpieces-disable no-function-outside-class -- runtime backstop for JavaScript and `as any` callers; webpieces-disable no-any-unknown -- untrusted runtime value is narrowed to an endpoint operation
function isEndpointOperation(value: unknown): value is EndpointOperation {
    return (
        value === READ ||
        value === WRITE_IDEMPOTENT ||
        value === WRITE
    );
}

// webpieces-disable no-function-outside-class -- runtime backstop for JavaScript and `as any` callers; webpieces-disable no-any-unknown -- untrusted runtime value is narrowed to an HTTP method
function isHttpMethod(value: unknown): value is HttpMethod {
    return value === GET || value === POST;
}

// webpieces-disable no-function-outside-class -- runtime backstop for JavaScript and `as any` callers; webpieces-disable no-any-unknown -- untrusted runtime value is narrowed to an endpoint kind
function isEndpointKind(value: unknown): value is EndpointKind {
    return (
        value === RPC ||
        value === CLOUDTASKS ||
        value === CRON ||
        value === EXTERNAL
    );
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
        if (
            kinds[methodName] !== 'external' ||
            getEndpointCaller(apiClass, methodName) !== undefined
        )
            continue;
        throw new Error(
            `External endpoint '${methodName}' in ${apiClass.name || 'Unknown'} declares no caller. Say WHO ` +
                `posts to it: @Endpoint(POST, path, WRITE, EXTERNAL, { calledBy: '<vendor>' }) — the runtime architecture ` +
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
 * True when the method's @Endpoint declared `{ rawBody: true }` — the transport must retain the
 * verbatim bytes + absolute url for an {@link WpAuthWebhook} hook to verify.
 */
// webpieces-disable no-function-outside-class -- reflect-metadata reader, sibling of isFormPost
export function isRawBody(apiClass: Function, methodName: string): boolean {
    return getEndpointOptions(apiClass, methodName).rawBody === true;
}

/**
 * Fail-fast at wiring time when an `@WpAuthWebhook` endpoint did not ask the transport to keep the
 * bytes it is supposed to verify. A hook with nothing to verify is a MISCONFIGURATION, and it must
 * surface at startup, naming the fix — not as a 401 in production on exactly the traffic the endpoint
 * exists for.
 *
 * This pairing is a runtime assert rather than a type because the two halves live on DIFFERENT
 * decorators (`@WpAuthWebhook` and `@Endpoint`), and no union over one decorator's argument can say
 * anything about the other's.
 *
 * @throws Error naming the first `@WpAuthWebhook` endpoint missing `{ rawBody: true }`.
 */
// webpieces-disable no-function-outside-class -- wiring-time assert, sibling of assertEveryEndpointHasAuthMode
export function assertEveryWebhookEndpointRetainsRawBody(apiClass: Function): void {
    const endpoints = getEndpoints(apiClass) || {};
    for (const methodName of Object.keys(endpoints)) {
        if (
            getAuthMode(apiClass, methodName)?.kind !== 'webhook' ||
            isRawBody(apiClass, methodName)
        )
            continue;
        throw new Error(
            `Endpoint '${methodName}' in ${apiClass.name || 'Unknown'} is @WpAuthWebhook but its @Endpoint ` +
                `does not declare { rawBody: true }. A webhook hook verifies a signature over the bytes and ` +
                `the url the SENDER transmitted, and without that option the transport parses the body and ` +
                `throws them away — leaving the hook nothing to check.`,
        );
    }
}

/**
 * Check if a class has @ApiPath decorator.
 */
export function isApiPath(apiClass: Function): boolean {
    return Reflect.hasMetadata(METADATA_KEYS.API_PATH, apiClass);
}

/**
 * Get method-level auth metadata. Class-level authorization is forbidden.
 */
// webpieces-disable no-function-outside-class -- reflect-metadata reader paired with the decorator API
export function getAuthMeta(apiClass: Function, methodName: string): AuthMeta | undefined {
    return Reflect.getMetadata(METADATA_KEYS.AUTH_META, apiClass, methodName);
}

/**
 * Get the auth mode for a method, or undefined.
 * Convenience wrapper over getAuthMeta for callers that only want the mode.
 */
// webpieces-disable no-function-outside-class -- typed convenience reader over getAuthMeta
export function getAuthMode(apiClass: Function, methodName: string): AuthMode | undefined {
    return getAuthMeta(apiClass, methodName)?.mode;
}

/**
 * The ONE prescription for "this endpoint declares no auth", shared by the two places that raise it
 * (here and http-routing's ApiRoutingFactory) because they had drifted into teaching different menus.
 * A message teaching an incomplete API is the same defect as an API with two spellings: whichever menu
 * the caller hits becomes the API they believe exists. It leads with the ROLE-GATED member on purpose —
 * the first thing offered should not be the widest grant.
 */
export const MISSING_AUTH_DECORATOR_FIX =
    "Add one of @WpAuthJwt({roles: ['admin']}) / @WpAuthJwt({allRolesAllowed: true}) / " +
    '@WpAuthOidc(...callers) / @WpAuthSharedSecret(key) / ' +
    "@WpAuthWebhook('vendor') / @WpAuthApiKey('regime', [{in: 'header', name: 'x-api-key'}]) / " +
    "@WpAuthLocalOnly() / @WpAuthPublic('why anonymous access is required') to " +
    'the method.';

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

/**
 * Validate that a class/method doesn't have conflicting auth decorators.
 * @throws Error if multiple auth decorators are found on the same target.
 */
// webpieces-disable no-function-outside-class -- shared decorator metadata validation
export function validateNoConflictingDecorators(
    apiClass: Function,
    methodName: string | undefined,
): void {
    const existing = methodName
        ? Reflect.getMetadata(METADATA_KEYS.AUTH_META, apiClass, methodName)
        : Reflect.getMetadata(METADATA_KEYS.AUTH_META, apiClass);

    if (existing) {
        const targetName = apiClass.name || 'Unknown';
        const location = methodName
            ? `method '${methodName}' of ${targetName}`
            : `class ${targetName}`;
        throw new Error(
            `Conflicting auth decorator on ${location}. ` +
                `Only one of @WpAuthJwt({...}) / @WpAuthOidc(...) / @WpAuthSharedSecret(...) / ` +
                `@WpAuthWebhook(...) / @WpAuthApiKey(...) / @WpAuthLocalOnly() / ` +
                `@WpAuthPublic('reason') is allowed per target.`,
        );
    }
}
