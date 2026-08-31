import 'reflect-metadata';
import { MaskSpec, MaskMode } from './LogFieldMask';
import { DEFAULT_CALLER_KIND, ENDPOINT_CALLER_KEY, ExternalCaller, ExternalSystemKind, getEndpointCaller } from './external-caller';
// The TYPE layer these decorators attach — split out for file size only (see auth-mode.ts).
import { ApiKeyCredentials, AuthMeta, AuthMode, JwtRequirement } from './auth-mode';

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

    /**
     * RETAIN the verbatim request bytes + the absolute url the sender addressed, so an
     * {@link AuthWebhook} hook can verify a vendor signature over them (see `RawRequest`).
     *
     * Opt-in PER ENDPOINT, sitting beside `formPost` and for the same reason: the cost lands on the
     * handful of webhook routes rather than on every request in the process. It is retention, not
     * new buffering — the express adapter already accumulates the whole body, it simply threw it
     * away once it had parsed a DTO.
     *
     * REQUIRED by `@AuthWebhook`, checked at wiring time (see
     * {@link assertEveryWebhookEndpointRetainsRawBody}) rather than left to fail as a 401 in
     * production: a hook with nothing to verify is a misconfiguration, not a bad request.
     *
     * Combines with `formPost` — `{ formPost: true, rawBody: true }` is the Twilio case, where the
     * hook needs the bytes and the url while the controller still wants the flat parsed DTO.
     */
    rawBody?: boolean;
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
 * @ApiPath(basePath) - Class decorator that marks a class as an API definition
 * and sets the base path for all endpoints.
 *
 * Usage:
 * ```typescript
 * @AuthJwt({ roles: ['admin'] })
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
 * {@link LogApiCallImpl} logging path must mask, so a secret riding on a DTO (an OAuth refresh token, an
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
 * @AuthJwt(requirement) - THE user-facing JWT decorator, covering the whole user-JWT axis: the
 * compiler-enforced role decision ({@link JwtRoles}) plus app-defined fields ({@link JwtRequirement}).
 *
 * ```typescript
 * @AuthJwt({ roles: ['admin', 'editor'] })          // any-of
 * @AuthJwt({ allRolesAllowed: true, inOrg: true })  // wide + an app rule enforced by authorizeJwt
 * ```
 *
 * It absorbed the former `@Auth(requirement)` — same argument, same AuthMode, so two spellings of one
 * decision. One decorator per credential kind now: `@Public` / `@AuthJwt` / `@AuthOidc` /
 * `@AuthSharedSecret` / `@AuthLocalOnly`.
 */
// webpieces-disable no-function-outside-class -- decorator factory; decorators are inherently module-scope
export function AuthJwt(requirement: JwtRequirement): ClassDecorator & MethodDecorator {
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

/**
 * @AuthWebhook(name) - an OUTSIDE vendor signed this request in its OWN scheme; the app's bound
 * `WebhookAuthCallback` proves it. THE mode for every signed inbound webhook — Sentry, GitHub, Stripe, Slack,
 * Twilio — none of which fits the other kinds: no vendor mints Google OIDC tokens, and none sends its
 * secret (they all send a DERIVATION over the request), so `@Public` was the only reachable posture
 * and `calledBy: 'sentry'` stayed a claim rather than a fact.
 *
 * ```typescript
 * @AuthWebhook('sentry')
 * @Endpoint('/hook/sentry/issue', 'external', { calledBy: 'sentry', rawBody: true })
 * abstract notify(request: SentryIssueHook): Promise<HookAck>;
 * ```
 *
 * `name` is a bare STRING resolved through DI in the server's container, exactly as
 * `@AuthOidc('gmail-push')` already is — never a function reference. An api contract is level 0: a
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
 * FAILS CLOSED: with no `WebhookAuthCallback` bound, every `@AuthWebhook` endpoint 401s, matching `JwtHook`.
 * Silently allowing an unverified webhook is the one default that must not exist.
 */
// webpieces-disable no-function-outside-class -- decorator factory; decorators are inherently module-scope
export function AuthWebhook(name: string): ClassDecorator & MethodDecorator {
    return defineAuthMode({ kind: 'webhook', name });
}

/**
 * @AuthApiKey(regime, credentials) - a CUSTOMER holds the credential. The app's bound `ApiKeyHook`
 * authenticates the inbound request against its own datastore and returns the `ContextTuple` entries
 * the framework seeds into `RequestContext`. THE mode for a partner-facing contract consumed by other
 * companies' codebases (POS vendors, back-office platforms, ETL pipelines).
 *
 * ```typescript
 * @AuthApiKey('onetablet-partner', [
 *     { in: 'header', name: 'x-api-key', description: 'The key issued to your integration.' },
 *     { in: 'header', name: 'x-organization-id', description: 'Which of your organizations to act on.' },
 * ])
 * @ApiPath('/management/v1')
 * abstract class ManagementApi { ... }
 * ```
 *
 * `regime` is a bare STRING selecting WHICH key regime this route belongs to, exactly as
 * `@AuthSharedSecret(key)` and `@AuthWebhook(vendor)` already are — one hook serves several regimes,
 * and an api contract is level 0, so it never references a verifier directly.
 *
 * `credentials` DECLARES where the credential rides ({@link ApiKeyCredential}), so a spec generator
 * reading route auth metadata can emit `components.securitySchemes` instead of a human hand-writing
 * them into a manifest. It is a NON-EMPTY, ORDERED list rather than one credential because a real
 * regime authenticates a PAIR — the key names a customer, a second header names which of that
 * customer's organizations the request acts on, and a mismatch is a 401. Its OpenAPI form is two
 * schemes plus ONE security-requirement object holding BOTH keys (an AND); a LIST of two objects
 * would mean "either alone suffices", which is a load-bearing difference a single-credential shape
 * cannot even express. ORDER IS SIGNIFICANT and preserved: it is the order the credentials are
 * presented in the published document.
 *
 * The list can never be EMPTY — a contract that declares a key regime and then names no credential
 * would generate a document with no security block, which is the exact silent failure this argument
 * exists to remove. That is a compile error, not a runtime throw (see {@link JwtRoles}'s non-empty
 * tuple, the same device for the same reason).
 *
 * WHY IT IS NOT `@AuthSharedSecret`. Shared-secret declares that AN INTERNAL SERVICE is on the other
 * end, so the framework BELIEVES the trusted context headers that caller forwarded (see
 * `DestinationTrust.forAuthMode` and `AuthFilter.verifiesCaller`). A customer is not an internal
 * service: declaring a partner endpoint `@AuthSharedSecret` would let that partner assert someone
 * else's org id on the wire and have it admitted — a privilege escalation. `apikey` therefore sits
 * with `jwt` on the caller-NOT-verified side, where an inbound trusted header is admitted only when
 * the hook independently derived the SAME value.
 *
 * WHY THE HOOK SEES THE REQUEST, NOT ONE TOKEN. A real key regime checks the key TOGETHER WITH a
 * second header (the organization it is acting for), and `JwtHook.parseJwt` — handed one pre-extracted
 * token from one header — physically cannot. `ApiKeyHook.verifyApiKey(regime, request)` gets the whole
 * inbound request instead, so the app owns which headers carry the credential and validates them as a
 * PAIR. `credentials` does NOT change that: the framework reads no header from it and performs no
 * extraction. It is DECLARATION for readers of the contract, and enforcement stays entirely the hook's.
 *
 * FAILS CLOSED: with no `ApiKeyHook` bound, every `@AuthApiKey` endpoint 401s, matching `JwtHook` and
 * `WebhookAuthCallback`.
 */
// webpieces-disable no-function-outside-class -- decorator factory; decorators are inherently module-scope
export function AuthApiKey(regime: string, credentials: ApiKeyCredentials): ClassDecorator & MethodDecorator {
    return defineAuthMode({ kind: 'apikey', regime, credentials });
}

/**
 * @AuthLocalOnly() - this endpoint exists ONLY on a developer's machine. Off-local it is not
 * registered as a route at all, and if it is somehow reached it 404s. Class- or method-level.
 *
 * ```typescript
 * @AuthLocalOnly()
 * @Endpoint('/logs', 'rpc')
 * sendBatch(request: SendLogBatchRequest): Promise<SendLogBatchResponse> { ... }
 * ```
 *
 * WHY IT IS AN AUTH MODE AND NOT A ROUTE-MODULE `if`. Apps hand-rolled this in TWO places kept in
 * sync by a comment: a route module that registered the route only locally, PLUS a
 * `if (env !== 'local') throw new HttpForbiddenError(...)` at the top of the handler. Neither half
 * was visible on the CONTRACT, so nothing reading the api — a human, a generated client, or an
 * agent — could tell this endpoint from a `@Public` one. Both halves are the framework's job now,
 * driven by this ONE declaration on the contract, which is where every other "who may call this"
 * fact already lives.
 *
 * It is DELIBERATELY a peer of @Public / @AuthJwt / @AuthOidc / @AuthSharedSecret / @AuthApiKey rather than an
 * option on one of them: one decorator per credential kind, and "local-only" is a different kind of
 * gate — it authenticates nobody, it excludes an entire environment.
 *
 * HOW "local" IS DECIDED: {@link RuntimeLocality}, declared once at startup (a REQUIRED input to
 * `RuntimeSetupOptions`). Undeclared means DEPLOYED, so a forgotten wiring call refuses the endpoint
 * rather than exposing it.
 */
// webpieces-disable no-function-outside-class -- decorator factory; decorators are inherently module-scope
export function AuthLocalOnly(): ClassDecorator & MethodDecorator {
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
 * True when the method's @Endpoint declared `{ rawBody: true }` — the transport must retain the
 * verbatim bytes + absolute url for an {@link AuthWebhook} hook to verify.
 */
// webpieces-disable no-function-outside-class -- reflect-metadata reader, sibling of isFormPost
export function isRawBody(apiClass: Function, methodName: string): boolean {
    return getEndpointOptions(apiClass, methodName).rawBody === true;
}

/**
 * Fail-fast at wiring time when an `@AuthWebhook` endpoint did not ask the transport to keep the
 * bytes it is supposed to verify. A hook with nothing to verify is a MISCONFIGURATION, and it must
 * surface at startup, naming the fix — not as a 401 in production on exactly the traffic the endpoint
 * exists for.
 *
 * This pairing is a runtime assert rather than a type because the two halves live on DIFFERENT
 * decorators (`@AuthWebhook` and `@Endpoint`), and no union over one decorator's argument can say
 * anything about the other's.
 *
 * @throws Error naming the first `@AuthWebhook` endpoint missing `{ rawBody: true }`.
 */
// webpieces-disable no-function-outside-class -- wiring-time assert, sibling of assertEveryEndpointHasAuthMode
export function assertEveryWebhookEndpointRetainsRawBody(apiClass: Function): void {
    const endpoints = getEndpoints(apiClass) || {};
    for (const methodName of Object.keys(endpoints)) {
        if (getAuthMode(apiClass, methodName)?.kind !== 'webhook' || isRawBody(apiClass, methodName)) continue;
        throw new Error(
            `Endpoint '${methodName}' in ${apiClass.name || 'Unknown'} is @AuthWebhook but its @Endpoint ` +
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
 * The ONE prescription for "this endpoint declares no auth", shared by the two places that raise it
 * (here and http-routing's ApiRoutingFactory) because they had drifted into teaching different menus.
 * A message teaching an incomplete API is the same defect as an API with two spellings: whichever menu
 * the caller hits becomes the API they believe exists. It leads with the ROLE-GATED member on purpose —
 * the first thing offered should not be the widest grant.
 */
export const MISSING_AUTH_DECORATOR_FIX =
    "Add one of @AuthJwt({roles: ['admin']}) / @AuthJwt({allRolesAllowed: true}) / @Public() / " +
    '@AuthOidc(...callers) / @AuthSharedSecret(key) / ' +
    "@AuthWebhook('vendor') / @AuthApiKey('regime', [{in: 'header', name: 'x-api-key'}]) / " +
    '@AuthLocalOnly() to ' +
    'the class or method.';

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
export function validateNoConflictingDecorators(apiClass: Function, methodName: string | undefined): void {
    const existing = methodName
        ? Reflect.getMetadata(METADATA_KEYS.AUTH_META, apiClass, methodName)
        : Reflect.getMetadata(METADATA_KEYS.AUTH_META, apiClass);

    if (existing) {
        const targetName = apiClass.name || 'Unknown';
        const location = methodName ? `method '${methodName}' of ${targetName}` : `class ${targetName}`;
        throw new Error(
            `Conflicting auth decorator on ${location}. ` +
            `Only one of @Public() / @AuthJwt({...}) / @AuthOidc(...) / @AuthSharedSecret(...) / ` +
            `@AuthWebhook(...) / @AuthApiKey(...) / @AuthLocalOnly() is allowed per target.`
        );
    }
}
