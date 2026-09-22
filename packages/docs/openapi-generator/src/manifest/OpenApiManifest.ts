/**
 * `openapi.manifest.json`, as CLASSES.
 *
 * ## What is allowed in here, and what is not
 *
 * The manifest carries exactly what is **not a property of the code**, and nothing else. Every field
 * below is a product decision, a deployment fact, or a NAME pointing at something the code owns:
 *
 * - `title`, `version` — product decisions.
 * - `servers[]` — a deployment fact.
 * - `descriptionFile` — a teaching decision.
 * - `apis[]` — which contracts, in the order the published sidebar shows them.
 * - `securitySchemeNames[]` — the published scheme KEYS only. Everything else about the schemes, and
 *   the AND-ed `security` requirement, is DERIVED from the contract's own `@WpAuthApiKey`. A
 *   `components.securitySchemes` block here would be a second copy of header names the running
 *   server never reads, and nothing could contradict it.
 * - `errors` — the document-wide failure contract, with the BODY read from a real TS type so the
 *   published shape cannot drift from the one on the wire.
 * - `responseHeaders[]` — declared by `nameConstant` naming an exported const, never by a literal.
 *
 * Anything a renderer could read off the source instead belongs in the source.
 *
 * ## The ORDER of `apis[]` is published navigation
 *
 * It is rendered into `tags[]` in that order, and a docs theme builds its sidebar from `tags[]`.
 * Alphabetising this array is not a cleanup; it reorders partner-facing navigation.
 */
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
 * One response header every operation carries.
 *
 * `nameConstant` names an exported `const` in `entry`, and the generator FOLDS it. A literal here
 * would be a copy of the header name that a rename leaves silently stale — and JSON cannot import,
 * so naming the constant is the only way for this file to point at the one the server actually
 * writes. Failing to fold it is a HARD FAILURE for the same reason.
 */
export class ResponseHeaderEntry {
    constructor(
        readonly entry: string,
        readonly nameConstant: string,
        readonly description: string | undefined,
    ) {}
}

export class OpenApiManifest {
    constructor(
        readonly title: string,
        readonly version: string,
        readonly servers: readonly ServerEntry[],
        /** A markdown preamble, relative to the manifest. Rendered into `info.description`. */
        readonly descriptionFile: string | undefined,
        readonly apis: readonly ApiEntry[],
        readonly securitySchemeNames: readonly string[],
        readonly errors: ErrorsEntry | undefined,
        readonly responseHeaders: readonly ResponseHeaderEntry[],
    ) {}
}
