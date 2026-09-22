import { ApiDocModel, DocumentedEndpoint } from '@webpieces/api-doc-model';
import {
    ApiTypeKind,
    EXTERNAL_CUSTOMER,
    MCP,
    SVC_TO_SVC,
    WpAuthLocalOnly,
} from '@webpieces/core-util';

/** The one line that says a document is not the customer contract. It appears in exactly one. */
export const INTERNAL_ONLY_LINE =
    'INTERNAL — service-to-service use only. This document lists every endpoint these services serve, including ones no customer is meant to see. It is not the customer contract and must never be handed to one.';

/**
 * The retry contract, published ONCE per document rather than as booleans stamped on every operation.
 *
 * Each operation's own `description` ends with one derived sentence saying whether it is safe to
 * retry; this table says where that sentence comes from. Three vendor-extension booleans per
 * operation would have been invisible to a human — Swagger UI and most themes do not render `x-`
 * extensions, and no standard generator reads `x-webpieces-*` — and would have tripled golden churn
 * the day the mapping changed.
 */
export const OPERATION_SEMANTICS = [
    "Every operation states whether it is safe to retry, derived from the endpoint's declared",
    'side-effect contract:',
    '',
    '| declared operation | read-only | destructive | idempotent |',
    '|---|---|---|---|',
    '| read | yes | no | yes |',
    '| write-idempotent | no | yes | yes |',
    '| write | no | yes | no |',
].join('\n');

/**
 * WHICH contracts and operations a document contains, and what prose it stamps. The ONLY thing that
 * differs between the three generated documents.
 *
 * ## Two orthogonal decisions, at two levels
 *
 * - `@ApiType(SVC_TO_SVC, EXTERNAL_CUSTOMER)` on the CONTRACT selects which FILES it feeds. A document
 *   is written at all only when some contract declares its type, so no contract declaring `MCP` means
 *   no `mcp-openapi.json` — there is no second emptiness rule to keep in step with that one.
 * - `{ hidden: true }` on ONE `@Endpoint` subtracts that method from the CUSTOMER document only. It
 *   stays in the private document, and in the MCP document when it is a tool.
 *
 * The per-method case is real and cannot be said at class level: a NEW endpoint on an
 * already-published API, built on main before it is announced. The per-contract case is the one that
 * must not default to permissive, and at class level naming it costs one token per contract.
 *
 * ## Select, then render — never render, then filter
 *
 * One render function takes one of these and is called once per document. It builds
 * `components.schemas` by walking OUTWARD from the operations this selection accepted, so an
 * unselected operation's DTOs are never constructed at all.
 *
 * That asymmetry is about what a BUG does. Build-then-filter puts an unreleased feature's full
 * request and response schemas into the document and then relies on a removal pass to take them out
 * again — so a defect in the visibility logic SHIPS them, named and fully shaped, with only the URL
 * missing, to customers who were told the feature was withheld. Select-then-render cannot do that:
 * no code path can emit a schema that was never built.
 *
 * The usual objection to rendering more than once — that the passes drift in how each renders the
 * same endpoint — applies to separate code paths. This is ONE function, so same code, same input,
 * same output.
 *
 * ## The thing that bites: map ordering
 *
 * Collecting schemas during a walk makes the key order of `components.schemas` depend on which
 * operations were walked, so two documents would list identical schemas in different orders and the
 * goldens would churn on unrelated changes. The renderer SORTS the schema keys before emitting.
 * Orders that carry MEANING are left alone and said so where they are built: `apis[]` order is the
 * published sidebar, and the security-scheme order is the order the credentials are declared in.
 */
export class DocumentSelection {
    private constructor(
        /** The file name this document is written to, and the name a failure uses for it. */
        readonly fileName: string,
        /** The `@ApiType` a contract must declare to appear in this document. */
        readonly apiType: ApiTypeKind,
        /** Drop methods marked `{ hidden: true }`. True for the customer document alone. */
        readonly dropHidden: boolean,
        /** Stamp `x-mcp-tool` and its siblings. Only the MCP document has a reader for them. */
        readonly includeMcpExtensions: boolean,
        /**
         * Prepend {@link INTERNAL_ONLY_LINE} to `info.description`, and say what TRIGGERS each
         * operation. Both are internal facts: a customer calls what they are given a url for, and
         * whether ours fires on a clock or off a queue is our business.
         */
        readonly internalNotice: boolean,
    ) {}

    /** Every contract declaring `SVC_TO_SVC` — which, by the fail-closed default, is every contract. */
    // webpieces-disable no-function-outside-class -- static factory; the private constructor is what stops a fourth, unnamed selection being invented at a call site
    static internal(): DocumentSelection {
        return new DocumentSelection('full-private-openapi', SVC_TO_SVC, false, false, true);
    }

    /** Every contract declaring `EXTERNAL_CUSTOMER`, minus its hidden methods. */
    // webpieces-disable no-function-outside-class -- static factory of this class
    static customer(): DocumentSelection {
        return new DocumentSelection('public-openapi', EXTERNAL_CUSTOMER, true, false, false);
    }

    /**
     * Every contract declaring `MCP`. A HIDDEN method is kept — an internal endpoint that is an agent
     * tool is still a tool, and requiring it to be published to customers in order to be one would be
     * exactly the wrong coupling.
     */
    // webpieces-disable no-function-outside-class -- static factory of this class
    static mcp(): DocumentSelection {
        return new DocumentSelection('mcp-openapi', MCP, false, true, false);
    }

    /** Every document this generator knows how to write, in the order it writes them. */
    // webpieces-disable no-function-outside-class -- static factory of this class
    static all(): readonly DocumentSelection[] {
        return [
            DocumentSelection.internal(),
            DocumentSelection.customer(),
            DocumentSelection.mcp(),
        ];
    }

    acceptsContract(model: ApiDocModel): boolean {
        return model.apiTypes.includes(this.apiType);
    }

    /**
     * `{ hidden: true }` subtracts a method from the CUSTOMER document, and `@WpAuthLocalOnly`
     * subtracts it from ALL of them.
     *
     * A local-only endpoint is not registered as a route at all once the process is deployed, so it
     * exists nowhere any reader of any of these documents could call it. Publishing it even in the
     * private one would document a route that does not exist in any deployed environment — worse
     * than omitting it, because a reader would reasonably try to call it.
     */
    acceptsEndpoint(endpoint: DocumentedEndpoint): boolean {
        if (endpoint.auth?.decorator === WpAuthLocalOnly.name) {
            return false;
        }
        return !this.dropHidden || !endpoint.hidden;
    }

    /** `info.description`: the manifest's prose, plus whatever this document adds to it. */
    description(manifestDescription: string | undefined): string | undefined {
        const parts: string[] = [];
        if (this.internalNotice) {
            parts.push(INTERNAL_ONLY_LINE);
        }
        if (manifestDescription !== undefined) {
            parts.push(manifestDescription);
        }
        parts.push(OPERATION_SEMANTICS);
        return parts.join('\n\n');
    }
}
