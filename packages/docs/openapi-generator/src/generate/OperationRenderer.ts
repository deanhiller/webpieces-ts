import { DocumentedEndpoint, TypeRef } from '@webpieces/api-doc-model';
import {
    CLOUDTASKS,
    CRON,
    EXTERNAL,
    mcpHintsForOperation,
    POST,
    READ,
    RPC,
    WpAuthPublic,
    WRITE,
    WRITE_IDEMPOTENT,
} from '@webpieces/core-util';
import { JsonObject, JsonValue } from '../json/JsonObject';
import { SchemaRenderer } from './SchemaRenderer';

/** What a webhook's `void` return means on the wire, said once. */
const ACKNOWLEDGE = 'Return any 2xx to acknowledge delivery. The body is ignored.';

/** `Promise<void>` on the wire, said once. */

/** The response document, and the responses a document-wide failure contract adds to it. */
export class ResponseContract {
    constructor(
        /** Status -> description, from the manifest's `errors.responses`, in declared order. */
        readonly errors: ReadonlyMap<string, string>,
        /** `$ref` at the error body schema, when the manifest declared one. */
        readonly errorSchemaRef: JsonObject | undefined,
        /** Header name -> its `components.headers` `$ref`, on every success response. */
        readonly headers: JsonObject | undefined,
    ) {}
}

/**
 * ONE {@link DocumentedEndpoint} -> one OpenAPI Operation Object.
 *
 * ## `summary` is the operation NAME, never a sentence
 *
 * A docs theme titles the endpoint's page from `summary` and puts `description` in the body. Writing
 * the first sentence of the prose into `summary` therefore produces a sidebar of sentences and a page
 * whose heading repeats its own first line. The method name is what a reader is looking for, and it
 * is also what the generated client calls the method, so the two agree by construction.
 *
 * ## The MCP extensions ride HERE, on the operation
 *
 * `x-mcp-tool`, `x-mcp-hints`, `x-mcp-description` and `x-mcp-auth` are stamped on every operation
 * carrying the tool decorator, hidden or not: an internal endpoint that is an agent tool is a
 * legitimate agent tool, and requiring it to be published to partners in order to be one would be
 * exactly the wrong coupling.
 *
 * They are stamped on the BASE, which every published document is derived from, and
 * {@link DocumentDeriver} STRIPS them from the customer document. Stamping-then-stripping rather than
 * rendering the customer document without them is the same choice the whole deriver rests on: one
 * render of one operation, so two documents holding it cannot disagree about anything else in it.
 */
export class OperationRenderer {
    constructor(
        private readonly schemas: SchemaRenderer,
        /** True only for the MCP document — see {@link withMcp}. */
        private readonly includeMcp: boolean,
        /** True only for the private document — see {@link triggerSentence}. */
        private readonly includeTrigger: boolean,
    ) {}

    /** An ordinary served route. */
    operation(
        endpoint: DocumentedEndpoint,
        contractName: string,
        tag: string,
        contract: ResponseContract,
        security: readonly JsonValue[] | undefined,
    ): JsonObject {
        const operation = this.common(endpoint, contractName, tag, contract);
        // An endpoint that authenticates NOBODY says so explicitly: `security: []` is OpenAPI's
        // spelling of "no credential required", and leaving the key off instead means "inherit the
        // document's", which is a different statement that happens to coincide today.
        const explicit = this.isPublic(endpoint) ? [] : security;
        operation.set('security', explicit === undefined ? undefined : explicit.slice());
        return this.withMcp(operation, endpoint);
    }

    /**
     * A call WE make to a PARTNER's server.
     *
     * It carries `x-webpieces-webhook: true`, which is the one fact about it a document cannot state
     * any other way. It gets no trigger sentence and no security at all, because neither is true of
     * it: nothing of ours triggers it and nothing of ours authenticates it — our api key must never
     * be published as a guard on somebody else's endpoint.
     */
    webhook(
        endpoint: DocumentedEndpoint,
        contractName: string,
        tag: string,
        contract: ResponseContract,
    ): JsonObject {
        const operation = this.common(endpoint, contractName, tag, contract);
        return this.withMcp(operation.set('x-webpieces-webhook', true), endpoint);
    }

    private common(
        endpoint: DocumentedEndpoint,
        contractName: string,
        tag: string,
        contract: ResponseContract,
    ): JsonObject {
        return new JsonObject()
            .set('operationId', `${contractName}_${endpoint.methodName}`)
            .set('summary', endpoint.methodName)
            .set('description', this.describe(endpoint))
            .set('tags', [tag])
            .set('requestBody', this.requestBody(endpoint, contractName))
            .set('responses', this.responses(endpoint, contractName, contract));
    }

    /**
     * The JSDoc body, plus the sentences that are DERIVED rather than written.
     *
     * The retry sentence comes from the endpoint's declared `operation`, which every integration
     * wants to know and most APIs state nowhere. It is a SENTENCE and not a vendor extension because
     * Swagger UI and most themes do not render `x-` extensions and no standard generator reads
     * `x-webpieces-*`: an extension would be invisible to the human and unread by the machine. The
     * mapping it is derived from is published once, in `info.description`, so the rule is stated and
     * not only its consequences.
     */
    private describe(endpoint: DocumentedEndpoint): string | undefined {
        const parts: string[] = [];
        const body = this.prose(endpoint.description);
        if (body !== undefined) {
            parts.push(body);
        }
        parts.push(this.retrySentence(endpoint));
        if (this.includeTrigger) {
            parts.push(this.triggerSentence(endpoint));
        }
        if (endpoint.openWorld) {
            parts.push(
                'Reaches beyond this service: it may act on an external system, so its effects ' +
                    'are not all visible here.',
            );
        }
        return parts.join('\n\n');
    }

    /**
     * WHAT FIRES this endpoint, in the private document only.
     *
     * A customer calls what they are given a url for; whether ours runs off a queue or a clock is our
     * business and would only invite a question they cannot act on. It is a SENTENCE and not
     * `x-webpieces-trigger` for the same reason the retry sentence is: Swagger UI and most themes do
     * not render `x-` extensions, and no standard generator reads `x-webpieces-*`, so an extension is
     * invisible to the human and unread by the machine.
     */
    private triggerSentence(endpoint: DocumentedEndpoint): string {
        if (endpoint.kind === CLOUDTASKS) {
            return 'Triggered by a queued task, delivered asynchronously.';
        }
        if (endpoint.kind === CRON) {
            return 'Triggered on a schedule, not by a caller.';
        }
        if (endpoint.kind === EXTERNAL) {
            const caller = endpoint.options.calledBy;
            return caller === undefined
                ? 'Triggered by an outside system.'
                : `Triggered by an outside system: ${caller}.`;
        }
        return endpoint.kind === RPC
            ? 'Triggered by a direct call.'
            : `Triggered by: ${endpoint.kind}.`;
    }

    /** An endpoint whose declared credential is "none", said out loud rather than left absent. */
    private isPublic(endpoint: DocumentedEndpoint): boolean {
        return endpoint.auth?.decorator === WpAuthPublic.name;
    }

    private retrySentence(endpoint: DocumentedEndpoint): string {
        if (endpoint.operation === READ) {
            return 'Safe to retry: this operation is read-only and idempotent.';
        }
        if (endpoint.operation === WRITE_IDEMPOTENT) {
            return 'Safe to retry: this operation changes state but is idempotent.';
        }
        return 'NOT safe to retry: this operation changes state and is not idempotent.';
    }

    /**
     * The MCP extensions, stamped only on the document that has an agent for a reader.
     *
     * ## The three side-effect hints are COMPUTED, never declared
     *
     * `mcpHintsForOperation` in `@webpieces/core-util` is the one place the mapping from
     * `READ | WRITE_IDEMPOTENT | WRITE` to `readOnlyHint` / `destructiveHint` / `idempotentHint`
     * lives, and this calls it rather than reimplementing it. The endpoint's `operation` already
     * states whether repeating the call is safe; a hand-declared hint would be a second answer to a
     * question the contract has answered, and the two could disagree. `openWorldHint` is the only one
     * a human declares, because it is a judgement about the world rather than a consequence of the
     * operation.
     *
     * ## There is no separate MCP description
     *
     * The agent reads the operation's `description` — the method's JSDoc — byte-identical to what the
     * partner reads. `x-mcp-description` appears ONLY when the author wrote an explicit `@mcp` JSDoc
     * tag, which is a deliberate act rather than a second copy of the same paragraph.
     */
    private withMcp(operation: JsonObject, endpoint: DocumentedEndpoint): JsonObject {
        if (!this.includeMcp || endpoint.mcpTool === undefined) {
            return operation;
        }
        const hints = mcpHintsForOperation(this.operationOf(endpoint), endpoint.openWorld);
        return operation
            .set('x-mcp-tool', endpoint.mcpTool.name)
            .set(
                'x-mcp-hints',
                new JsonObject()
                    .set('readOnlyHint', hints.readOnlyHint)
                    .set('destructiveHint', hints.destructiveHint)
                    .set('idempotentHint', hints.idempotentHint)
                    .set('openWorldHint', hints.openWorldHint),
            )
            .set('x-mcp-description', this.prose(endpoint.mcpDescription))
            .set('x-mcp-auth', endpoint.mcpAuthText);
    }

    /**
     * The endpoint's operation as the REAL exported constant.
     *
     * The model carries it as a string, verbatim from the source, because the model invents no
     * taxonomy. Matching it back to the constant here — rather than casting — is what makes a rename
     * of `WRITE_IDEMPOTENT` in `core-util` a compile error in this file.
     */
    private operationOf(
        endpoint: DocumentedEndpoint,
    ): typeof READ | typeof WRITE_IDEMPOTENT | typeof WRITE {
        if (endpoint.operation === READ) {
            return READ;
        }
        return endpoint.operation === WRITE_IDEMPOTENT ? WRITE_IDEMPOTENT : WRITE;
    }

    /**
     * The request DTO as a body. Only for `POST`: OpenAPI gives a `GET` body no defined semantics and
     * most tooling drops it, so publishing one would document a request no generated client sends.
     */
    private requestBody(
        endpoint: DocumentedEndpoint,
        contractName: string,
    ): JsonObject | undefined {
        if (endpoint.httpMethod !== 'POST' || endpoint.request === undefined) {
            return undefined;
        }
        const pointer = `#/paths/${contractName}_${endpoint.methodName}/requestBody`;
        const media = endpoint.options.formPost
            ? 'application/x-www-form-urlencoded'
            : 'application/json';
        return new JsonObject()
            .set('required', true)
            .set(
                'content',
                new JsonObject().set(
                    media,
                    new JsonObject().set('schema', this.schemas.type(endpoint.request, pointer)),
                ),
            );
    }

    private responses(
        endpoint: DocumentedEndpoint,
        contractName: string,
        contract: ResponseContract,
    ): JsonObject {
        const responses = new JsonObject();
        responses.set('200', this.success(endpoint, contractName, contract));
        for (const status of Array.from(contract.errors.keys())) {
            responses.set(status, this.failure(contract.errors.get(status)!, contract));
        }
        return responses;
    }

    private success(
        endpoint: DocumentedEndpoint,
        contractName: string,
        contract: ResponseContract,
    ): JsonObject {
        const response = new JsonObject()
            .set('description', this.isVoid(endpoint.response) ? ACKNOWLEDGE : 'Success.')
            .set('headers', contract.headers);
        if (this.isVoid(endpoint.response)) {
            return response;
        }
        const pointer = `#/paths/${contractName}_${endpoint.methodName}/responses/200`;
        return response.set(
            'content',
            new JsonObject().set(
                'application/json',
                new JsonObject().set('schema', this.schemas.type(endpoint.response!, pointer)),
            ),
        );
    }

    private failure(description: string, contract: ResponseContract): JsonObject {
        const response = new JsonObject().set('description', description);
        if (contract.errorSchemaRef === undefined) {
            return response;
        }
        return response.set(
            'content',
            new JsonObject().set(
                'application/json',
                new JsonObject().set('schema', contract.errorSchemaRef),
            ),
        );
    }

    /** `Promise<void>` reaches the model as the `unknown` primitive — there is no body to document. */
    private isVoid(response: TypeRef | undefined): boolean {
        return (
            response === undefined ||
            (response.kind === 'primitive' && response.primitive === 'unknown')
        );
    }

    private prose(text: string | undefined): string | undefined {
        return text === undefined || text.trim() === '' ? undefined : text;
    }
}
