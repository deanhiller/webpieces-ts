/**
 * API Relations model
 *
 * The typed classification of a compile-time dependency edge P -> apiLib in
 * architecture/dependencies.json. Where the flat `dependsOn` only says "P depends
 * on apiLib", `apiRelations[apiLib]` says WHY: which API contracts P IMPLEMENTS
 * (serves, `class Ctrl extends XxxApi`) and which it USES (calls as a client,
 * `factory.createRpcClient(XxxApi, ...)` / `createPubSubClient(...)`), each tagged
 * with its transport.
 *
 * Interfaces + object literals here mirror the sibling runtime-graph.ts model —
 * these are serialization DTOs written verbatim into the committed JSON, and
 * `implements`/`uses` are legal interface property names (they are reserved words
 * only as binding identifiers, not as member names).
 */

/**
 * Transport of an API contract:
 *  - `rpc`      — synchronous request/response over HTTP
 *  - `pubsub`   — fire-and-forget, delivered later through a Cloud Tasks queue
 *  - `external` — a contract for a system OUTSIDE this repo (firestore, gmail, ...). Nothing in-repo
 *                 implements it, so it never becomes a service→service edge; it terminates the graph
 *                 at a dashed vendor node. Detected from `runtime-architecture.externalApiPaths`
 *                 rather than from a decorator, because a vendor contract is a plain interface bound
 *                 to a Symbol token, not an `abstract class` carrying @ApiPath.
 */
export type ApiTransport = 'rpc' | 'pubsub' | 'external';

/**
 * The kinds an external system can be DECLARED as. Each draws its own shape in the runtime viz, so
 * a datastore stops looking like an HTTP service.
 *
 * Lives here rather than beside the runtime graph model because that model already imports from this
 * file; putting it there and importing back would close a module cycle.
 */
export const EXTERNAL_SYSTEM_KINDS = [
    'database',
    'cache',
    'queue',
    'storage',
    'saas',
    'system',
    /**
     * A destination whose ADDRESS is supplied at runtime — a URL a partner registered, an OAuth
     * callback, a per-tenant host. Unlike every other kind it does not name one vendor: it names the
     * PLACE in our own system where somebody else's address is dialled, which is the fact a security
     * review is looking for.
     *
     * Declared like every other kind, on the CONTRACT: `@externalSystem runtime partner-webhooks`.
     * On the contract rather than at a `createRpcClient` call site deliberately — "the far end of
     * this contract is outside our estate" is a property of the CONTRACT, true for every caller of
     * it, so putting it there means one declaration however many services deliver over it, and
     * nothing to keep in step when a second one appears. It also means this kind rides the exact
     * same declare → resolve → draw pipeline `saas` and `database` already ride, rather than a
     * second mechanism that reads construction sites and can disagree with the first.
     */
    'runtime',
] as const;

export type ExternalSystemKind = (typeof EXTERNAL_SYSTEM_KINDS)[number];

/** True for a string that names one of {@link EXTERNAL_SYSTEM_KINDS}. */
// webpieces-disable no-function-outside-class -- type guard beside the type it guards, matching this file's DTO style
export function isExternalSystemKind(value: string): value is ExternalSystemKind {
    return (EXTERNAL_SYSTEM_KINDS as readonly string[]).includes(value);
}

/**
 * ONE declared external system, keyed in {@link ExternalSystemDecls} by its IDENTITY.
 *
 * Identity, not display text: two projects each tagged `external:database:postgres` name the same
 * `postgres` node and converge on it with one arrow apiece, instead of drawing a database each.
 *
 * The two arrays are the two declaration sites, and a system may legitimately have both — a repo can
 * wrap a datastore behind a contract in one service and open it directly in another.
 */
export interface ExternalSystemDecl {
    kind: ExternalSystemKind;
    label: string;
    /** Contracts declaring it with an `@externalSystem` JSDoc tag; every user of one gets an arrow. */
    apis: string[];
    /** Projects declaring it with an `external:<kind>:<identity>` nx tag; each gets its OWN arrow. */
    projects: string[];
}

/** identity -> its declaration. Serialized as the `externalSystems` key of dependencies.json. */
export type ExternalSystemDecls = Record<string, ExternalSystemDecl>;

/**
 * How a project relates to ONE api-lib it depends on:
 *  - `implements`       — it serves the api (a controller extends it)
 *  - `uses`             — it calls the api (generates a client)
 *  - `uses-implements`  — it does BOTH (implements some of the api-lib's contracts,
 *                          uses others)
 */
export type ApiRelationKind = 'implements' | 'uses' | 'uses-implements';

/** One API class a project implements or uses, with its transport. */
export interface ApiRef {
    api: string;
    type: ApiTransport;
    /**
     * ONLY on a `uses` ref: the service the call site aims at, read from the client config literal
     * (`createRpcClient(XxxApi, new ClientConfig('helper-fsdb'))` → `helper-fsdb`). It is matched
     * against a project's DECLARED `serviceName` to pick the ONE runtime edge target, instead of
     * fanning the edge out to every implementer of the api — which is catastrophically wrong for a
     * company-wide contract registered in a shared library and therefore implemented by every server.
     *
     * Absent when the config argument is not a `new <Xxx>ClientConfig('<literal>')` (a variable, a
     * computed name, ...). Absent means "unknown target", NOT "no target" — the runtime graph then
     * falls back to the old fan-out and says so out loud.
     */
    targetService?: string;
    /**
     * ONLY on a `pubsub` uses ref. True means "this producer was attributed to EVERY cloudtasks
     * method of the contract, not to the methods it actually enqueues".
     *
     * A producer builds one client for the whole contract (`createPubSubClient(EmailTaskApi, cfg)`)
     * and enqueues through a proxy (`emailTasks.send(req)`) somewhere else entirely — often after
     * the client has been stored in a DI binding — so WHICH methods it enqueues is not statically
     * recoverable. The consumer side IS exact (addRoutes + the contract's method table). Recording
     * the difference keeps a producer-side queue from being read as proof that queue is used.
     */
    methodsInferred?: boolean;
}

/**
 * Identity of a ref for de-duplication: an api used twice against DIFFERENT services is two distinct
 * relations (two distinct runtime edges), so the api name alone is not the key.
 */
// webpieces-disable no-function-outside-class -- pure data helper for these serialization DTOs
export function apiRefKey(ref: ApiRef): string {
    return `${ref.api} ${ref.targetService ?? ''}`;
}

/**
 * A project's relationship to ONE api-lib it depends on. Serialized verbatim into
 * architecture/dependencies.json under `apiRelations[apiLibProjectName]`.
 */
export interface ApiRelation {
    kind: ApiRelationKind;
    implements: ApiRef[];
    uses: ApiRef[];
}

/** apiLibProjectName -> relation. Attached to a GraphEntry as `apiRelations`. */
export type ProjectApiRelations = Record<string, ApiRelation>;

/**
 * What triggers ONE endpoint, mirroring core-util's `EndpointKind`. Duplicated as a string union
 * rather than imported: nx-webpieces-rules is build tooling and must not take a runtime dependency
 * on the framework it inspects (it reads decorators as TEXT, from projects that may be on a
 * different @webpieces version than the tooling itself).
 */
export type EndpointKind = 'rpc' | 'cloudtasks' | 'cron' | 'external';

/**
 * One method on an API contract, as written in source: what triggers it, where it is mounted, and
 * (for a queued method) which Cloud Tasks queue delivers it.
 */
export interface ApiMethodMeta {
    name: string;
    /** The @Endpoint path, relative to the class's @ApiPath basePath. */
    path: string;
    kind: EndpointKind;
    /**
     * `@Queue(...)` override, else `${ApiClassName}-${methodName}`.
     *
     * ONLY on a `cloudtasks` or `cron` method — those are the kinds actually delivered through a
     * named queue or schedule, and Terraform matches on this string. A synchronous `rpc` (or an
     * inbound `external`) endpoint has no queue and needs none; emitting a plausible-looking name for
     * one put every synchronous endpoint one naive `methods.map(m => m.queueName)` away from being
     * provisioned as a queue.
     */
    queueName?: string;
    /**
     * WHO outside this repo drives this endpoint, from `@Endpoint(p, 'external', { calledBy })`.
     *
     * ONLY on an `external` method, the same way `queueName` is only on the kinds that HAVE a queue.
     *
     * Deliberately the SAME {@link ExternalSystemDeclaration} the OUTBOUND `@externalSystem` tag
     * resolves to, not a parallel inbound-only type: an inbound `saas twilio` and an outbound
     * `saas twilio` are the same vendor, so sharing the type makes them share an IDENTITY and
     * converge on ONE node instead of drawing twilio twice facing opposite directions.
     *
     * Optional in the TYPE only for graphs generated before the caller was required — generation
     * FAILS on an `external` method whose caller cannot be read (UndeclaredExternalCallerError).
     */
    caller?: ExternalSystemDeclaration;
}

/**
 * A discovered API contract class: its name, the api-lib project that owns it, its transport, and
 * its per-method trigger table.
 */
export interface ApiClassInfo {
    api: string;
    owner: string;
    type: ApiTransport;
    /** The class's @ApiPath basePath; absent for an external (vendor) contract, which has no route. */
    basePath?: string;
    /**
     * Every @Endpoint method, in declaration order. Empty for an external contract (a vendor
     * interface has no endpoints — it is called through a vendor SDK, not mounted).
     */
    methods: ApiMethodMeta[];
    /**
     * Set when the contract carries an `@externalSystem <kind> [label]` JSDoc tag — a vendor seam
     * declaring WHAT it is a seam to. JSDoc rather than a decorator because these seams are plain TS
     * `interface`s, which cannot carry one.
     */
    externalSystem?: ExternalSystemDeclaration;
}

/** The `(kind, label)` pair a single declaration resolves to. */
export interface ExternalSystemDeclaration {
    kind: ExternalSystemKind;
    label: string;
}

/**
 * The committed, per-contract view written to `architecture/dependencies.json` under `apiContracts`.
 *
 * The runtime graph is derived SOLELY from dependencies.json so generate and validate can never
 * diverge — which means anything the runtime graph needs must be COMMITTED there, not re-scanned.
 * Per-method trigger kinds and queue names are exactly that: without this table the derivation
 * cannot tell a queued endpoint from a cron sweep, and cannot name the queue between two services.
 */
export interface ApiContract {
    owner: string;
    /** 'rpc' | 'pubsub' for an in-repo contract, 'external' for a vendor seam. */
    apiKind: ApiTransport;
    /**
     * REQUIRED. Every routed contract carries `@ApiPath`, so every entry in this table must carry the
     * base path its methods hang off. Optional was worse than absent: a consumer joining
     * `basePath + path` for the ONE entry that lost it computed `/test` where the real route was
     * `/whatsapp/test`, and had no reason to suspect it — every other entry had the field. Generation
     * now FAILS instead of shipping an entry that computes a confidently wrong URL.
     */
    basePath: string;
    methods: ApiMethodMeta[];
}

/** apiClassName -> its committed contract. Serialized as the `apiContracts` key. */
export type ApiContracts = Record<string, ApiContract>;

/**
 * ONE decorator argument the scan saw but could not reduce to a string — `@ApiPath(SOME_CONST)`
 * where SOME_CONST is imported from another module, a computed expression, an enum member, ...
 *
 * Recorded rather than dropped. Before this existed, an unresolvable argument cost the contract its
 * basePath, or a method, or (when EVERY method's path was one) the whole class — with nothing
 * printed anywhere. Same-module constants now resolve, so what remains here is the genuinely
 * unresolvable, which the author can fix by inlining the literal or moving the constant in-module.
 */
export class NonLiteralDecoratorArg {
    constructor(
        /** The contract class the argument was written on. */
        public readonly api: string,
        /** `ApiPath` | `Endpoint` | `Queue`. */
        public readonly decorator: string,
        /** The method name for a member decorator, null for a class decorator. */
        public readonly method: string | null,
        /** The argument exactly as written, e.g. `WHATSAPP_API_PATH`. */
        public readonly argument: string,
        /** `path/to/file.ts:LINE`, workspace-relative. */
        public readonly at: string,
    ) {}
}

/**
 * ONE `@Endpoint(path, kind)` whose PATH argument was present but could not be reduced to a string.
 *
 * Split out of NonLiteralDecoratorArg (which stays a warning, covering @Queue and the rest) because
 * this one is FATAL. Upstream components need the URL: an http client builds its request as
 * `basePath + path`, so an unreadable path is missing ROUTING, not missing metadata — the same
 * reasoning that already makes basePath required. Skipping the method instead used to delete it, and
 * a class whose every path was a constant lost every method and vanished from `apiContracts` with
 * nothing printed anywhere.
 */
export class UnresolvedEndpointPath {
    constructor(
        /** The contract class the method is declared on. */
        public readonly api: string,
        /** The method name. */
        public readonly method: string,
        /** The path argument exactly as written, e.g. `PROCESS_PATH`. */
        public readonly argument: string,
        /** `path/to/file.ts:LINE`, workspace-relative. */
        public readonly at: string,
    ) {}
}

/**
 * ONE `external` `@Endpoint` whose CALLER could not be read from the source.
 *
 * Fatal for the same reason {@link UnresolvedEndpointPath} is. The inbound box exists to say who is
 * calling us from outside; with no caller it can only restate our own contract name, which is the
 * exact bug this diagnostic exists to make impossible to reintroduce. `@Endpoint`'s TS overloads
 * already require `calledBy`, so anything reaching here is a JS caller, an `as any`, a cross-module
 * constant the parser-only scan cannot fold, or an unknown `callerKind`.
 */
export class UndeclaredExternalCaller {
    constructor(
        /** The contract class the method is declared on. */
        public readonly api: string,
        /** The method name. */
        public readonly method: string,
        /** What was wrong, as written — `<missing>`, `SOME_CONST`, `callerKind: 'vendor'`. */
        public readonly argument: string,
        /** `path/to/file.ts:LINE`, workspace-relative. */
        public readonly at: string,
    ) {}
}

/**
 * A contract class that DECLARED `@Endpoint` methods and kept none of them.
 *
 * The backstop for the mechanism that hid an entire service: `buildApiContracts` skips a zero-method
 * class (correctly — a vendor seam has no routes), so a class gutted by unreadable decorator
 * arguments left through the same door as a legitimately routeless one. A class that declared
 * endpoints and produced none is never legitimate, so it is named instead.
 */
export class EmptiedApiContract {
    constructor(
        /** The contract class name. */
        public readonly api: string,
        /** How many `@Endpoint` decorators were written on it. */
        public readonly declared: number,
        /** `path/to/file.ts:LINE` of the class, workspace-relative. */
        public readonly at: string,
    ) {}
}

/** Derive the relation kind from the (possibly empty) implements/uses ref lists. */
// webpieces-disable no-function-outside-class -- pure data helper for these serialization DTOs
export function deriveApiRelationKind(implementsRefs: ApiRef[], usesRefs: ApiRef[]): ApiRelationKind {
    if (implementsRefs.length > 0 && usesRefs.length > 0) return 'uses-implements';
    if (implementsRefs.length > 0) return 'implements';
    return 'uses';
}

/**
 * Stable-sort a ref list by api name, then by target service, so the committed JSON is
 * deterministic even when one api is used against two different services.
 */
// webpieces-disable no-function-outside-class -- pure data helper for these serialization DTOs
export function sortApiRefs(refs: ApiRef[]): ApiRef[] {
    return [...refs].sort(
        (a: ApiRef, b: ApiRef) =>
            a.api.localeCompare(b.api) || (a.targetService ?? '').localeCompare(b.targetService ?? ''),
    );
}
