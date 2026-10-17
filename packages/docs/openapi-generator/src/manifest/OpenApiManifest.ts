/**
 * `openapi.manifest.json`, as CLASSES.
 *
 * ## What is allowed in here, and what is not
 *
 * The manifest carries exactly what is **not a property of the code**, and nothing else. Every field
 * below is a product decision, a deployment fact, or a NAME pointing at something the code owns:
 *
 * - `title`, `summary`, `version` — product decisions. `summary` is the API's one-line pitch (#1296),
 *   published as `info.summary`; REQUIRED, one line, at most 200 characters — the Claude Connectors
 *   Directory's one-liner limit, so the same text can be pasted there.
 * - `servers[]` — a deployment fact.
 * - `descriptionFile` — a teaching decision.
 * - `apis[]` — which contracts, in the order the published sidebar shows them.
 * - `securitySchemeNames[]` — the published scheme KEYS only. Everything else about the schemes, and
 *   the AND-ed `security` requirement, is DERIVED from the contract's own `apiKey(...)`. A
 *   `components.securitySchemes` block here would be a second copy of header names the running
 *   server never reads, and nothing could contradict it.
 * - `errors` — the document-wide failure contract, with the BODY read from a real TS type so the
 *   published shape cannot drift from the one on the wire.
 * - `responseHeaders[]` — declared by `contextKey` naming an exported ContextKey, never by a literal.
 * - `operationIds` — the published operationId spelling (#1270); optional, `contract_method` when omitted (#1283).
 *
 * Anything a renderer could read off the source instead belongs in the source.
 *
 * ## The ORDER of `apis[]` is published navigation
 *
 * It is rendered into `tags[]` in that order, and a docs theme builds its sidebar from `tags[]`.
 * Alphabetising this array is not a cleanup; it reorders partner-facing navigation.
 */
import { OperationIdStyle, SchemaNameEntry } from '@webpieces/api-doc-model';

/**
 * The longest manifest `summary` (#1296): the Claude Connectors Directory's limit for a server's
 * one-line description, so the line published as `info.summary` can be pasted there unchanged.
 */
export const MANIFEST_SUMMARY_MAX_LENGTH = 200;

export class ServerEntry {
    constructor(
        readonly url: string,
        readonly description: string | undefined,
    ) {}
}

/** One contract file the generator reads. */
export class ApiEntry {
    constructor(
        /** Path to the contract `.ts`, relative to the manifest's own directory. */
        readonly entry: string,
        /** The tag every operation of this contract carries — and one `tags[]` entry, in order. */
        readonly tag: string,
        /**
         * `webhook` moves the contract into the top-level `webhooks:` block: these are calls WE
         * make to a partner's server, not routes on ours.
         *
         * DECLARED, never sniffed from a `*WebhookApi` filename. A name convention would hide a
         * partner-visible decision inside a rename, and a rename is the one edit nobody reviews for
         * contract impact.
         */
        readonly kind: string | undefined,
    ) {}

    isWebhook(): boolean {
        return this.kind === 'webhook';
    }
}

/** One status code of the document-wide failure contract. */
export class ErrorResponseEntry {
    constructor(
        readonly status: string,
        readonly description: string,
        /**
         * `true`: this failure can only happen to an AUTHENTICATED operation (a 401 for a bad
         * credential), so it is left OFF every operation whose resolved auth is public
         * (`@WpAuthPublic`) — a public endpoint cannot fail authentication. Omitted means `false`:
         * the response is listed on every operation.
         */
        readonly requiresAuth: boolean,
    ) {}
}

/**
 * The document-wide failure contract.
 *
 * Document-wide and not per-operation on purpose: per-operation codes would be a second hand-written
 * list to keep in step with the handlers, and stating them once tells a partner the truth — any
 * operation can fail these ways.
 */
export class ErrorsEntry {
    constructor(
        /** The `.ts` file declaring the error body, relative to the manifest. */
        readonly entry: string,
        /** The exported TYPE name of the body. Read with the compiler, so it cannot drift. */
        readonly type: string,
        readonly responses: readonly ErrorResponseEntry[],
    ) {}
}

/**
 * One response header every operation carries — on its success response AND on every failure the
 * document declares for it (#1270): a correlation id matters most on the response that FAILED, and
 * the server stamps it on every response, so declaring it on the 200 alone under-documents the wire.
 *
 * `contextKey` names an exported `ContextKey` in `entry` — the export's name, or a dotted path into
 * one (`OneTabletKey.TX_ID`) — and the generator reads the header name off that key's own
 * `ContextKey.trusted(...)` / `ContextKey.untrusted(...)` definition: its `responseHeader`, which is
 * what the server's response choke point actually writes (#1249). A literal here would be a copy of
 * the header name that a rename leaves silently stale — and JSON cannot import, so naming the key is
 * the only way for this file to point at the one definition. Failing to resolve it is a HARD
 * FAILURE for the same reason.
 */
export class ResponseHeaderEntry {
    constructor(
        readonly entry: string,
        readonly contextKey: string,
        readonly description: string | undefined,
        /**
         * Rendered verbatim as the OpenAPI header object's `required`. Omitted means the document
         * does not state it, which OpenAPI reads as `false`.
         */
        readonly required: boolean | undefined,
    ) {}
}

export class OpenApiManifest {
    constructor(
        readonly title: string,
        /**
         * The API's one-line summary (#1296) — OpenAPI 3.1 `info.summary`. REQUIRED: one line, at most
         * {@link MANIFEST_SUMMARY_MAX_LENGTH} characters.
         */
        readonly summary: string,
        readonly version: string,
        readonly servers: readonly ServerEntry[],
        /** A markdown preamble, relative to the manifest. Rendered into `info.description`. */
        readonly descriptionFile: string | undefined,
        readonly apis: readonly ApiEntry[],
        readonly securitySchemeNames: readonly string[],
        readonly errors: ErrorsEntry | undefined,
        readonly responseHeaders: readonly ResponseHeaderEntry[],
        readonly schemaNames: readonly SchemaNameEntry[],
        readonly operationIds: OperationIdStyle,
    ) {}
}

/**
 * A DTO library's `openapi.manifest.json` — `"kind": "components"` (#1058).
 *
 * It names the library's ENTRY FILES instead of contracts: the document it produces is
 * components-only — `openapi`, `info` and `components.schemas`, no paths — holding every type the
 * library exports and declares, which contract documents `$ref` instead of copying. There is no
 * `version` here: a library document's `info.version` IS the package version, read from its
 * `package.json`, so the two cannot disagree.
 */
export class ComponentsManifest {
    constructor(
        readonly title: string,
        /** The library's entry files (usually `src/index.ts`), relative to the manifest's directory. */
        readonly entries: readonly string[],
        readonly schemaNames: readonly SchemaNameEntry[],
    ) {}
}
