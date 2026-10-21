import { DocumentedEndpoint, DocumentedType, TypeRef } from '@webpieces/api-doc-model';
import { verbCarriesBody } from '@webpieces/core-util';
import { ContractModel } from './GenerationInputs';
import { SuccessBody } from './SuccessBody';

/**
 * WHICH request/response wrappers an operation defines INLINE instead of in `components.schemas`
 * (#1303).
 *
 * A `…Request` body or `…Response` reply belongs to its one method: it changes when that method
 * changes, and nothing else may refer to it without tying two methods together. As a component it got
 * a schema page of its own on the docs site that nothing linked to. So a wrapper is inlined at its
 * operation — keeping `title: "<PublishedName>"`, which is what client generators (openapi-generator,
 * NSwag, Kiota) name an inline model from — when ALL of these hold:
 *
 * - it is the TOP-LEVEL type of exactly ONE request body or ONE success response, counted over every
 *   operation of every contract in the manifest (routes and webhooks, every document — not per
 *   document: a wrapper two operations share is shared, whichever documents each lands in);
 * - no named type in the model refers to it — as a field, an array item, a map value or a union
 *   branch — and it is not the manifest's error body;
 * - it is an OBJECT (an enum or a union alias is a shared noun, not a wrapper);
 * - it is declared in the document's OWN package. A type another package declares is defined by that
 *   package's `components.openapi.json` and referenced from here (#1058's one-owner rule); inlining it
 *   would define one schema in two documents.
 *
 * Everything else — a wrapper two operations share, one nested in another schema, every shared noun —
 * stays a component exactly as before.
 */
export class InlinedWrappers {
    private constructor(private readonly keys: ReadonlySet<string>) {}

    /** No wrapper is inlined — the MCP projection and a DTO library's components document. */
    // webpieces-disable no-function-outside-class -- static factory of this class
    static none(): InlinedWrappers {
        return new InlinedWrappers(new Set<string>());
    }

    /** The wrappers of a manifest, by model key (`DocumentedType.keyOf`). */
    // webpieces-disable no-function-outside-class -- static factory of this class
    static of(
        contracts: readonly ContractModel[],
        types: ReadonlyMap<string, DocumentedType>,
        homePackage: string | undefined,
        errorTypeKey: string | undefined,
    ): InlinedWrappers {
        const counter = new WrapperUseCounter(types);
        counter.countOperations(contracts);
        counter.countSchemas();
        if (errorTypeKey !== undefined) {
            counter.markNested(errorTypeKey);
        }
        return new InlinedWrappers(counter.singleUse(homePackage));
    }

    has(key: string): boolean {
        return this.keys.has(key);
    }
}

/** The tally {@link InlinedWrappers.of} decides from: top-level uses per key, and every nested one. */
class WrapperUseCounter {
    private readonly topLevel = new Map<string, number>();
    private readonly nested = new Set<string>();
    private readonly body = new SuccessBody();

    constructor(private readonly types: ReadonlyMap<string, DocumentedType>) {}

    /**
     * Every body an operation of any document can render: a POST/PUT/PATCH request (the verbs a body is
     * published for — `verbCarriesBody`, see `OperationRenderer.requestBody`) and a non-void success
     * response. A URL parameter's type is a NESTED use: a parameter schema is never an inlined wrapper. A
     * `@WpLocalOnly` endpoint is in no document, so it uses nothing.
     */
    countOperations(contracts: readonly ContractModel[]): void {
        for (const contract of contracts) {
            for (const endpoint of contract.model.endpoints) {
                this.countEndpoint(endpoint);
            }
        }
    }

    /** Every reference one named type makes to another — which makes the target a shared noun. */
    countSchemas(): void {
        for (const type of Array.from(this.types.values())) {
            for (const field of type.fields) {
                this.walk(field.type);
            }
            if (type.indexSignatureValue !== undefined) {
                this.walk(type.indexSignatureValue);
            }
            for (const branch of type.unionRefNames) {
                this.markNested(branch);
            }
        }
    }

    markNested(key: string): void {
        this.nested.add(key);
    }

    singleUse(homePackage: string | undefined): ReadonlySet<string> {
        const keys = new Set<string>();
        for (const key of Array.from(this.topLevel.keys())) {
            const type = this.types.get(key);
            if (
                this.topLevel.get(key) === 1 &&
                !this.nested.has(key) &&
                type !== undefined &&
                type.packageName === homePackage &&
                type.enumValues.length === 0 &&
                type.unionRefNames.length === 0
            ) {
                keys.add(key);
            }
        }
        return keys;
    }

    private countEndpoint(endpoint: DocumentedEndpoint): void {
        if (endpoint.localOnly) {
            return;
        }
        if (verbCarriesBody(endpoint.httpMethod) && endpoint.request !== undefined) {
            this.countBody(endpoint.request);
        }
        for (const parameter of endpoint.parameters) {
            if (parameter.type !== undefined) {
                this.walk(parameter.type);
            }
        }
        if (!this.body.isVoid(endpoint.response)) {
            this.countBody(endpoint.response!);
        }
    }

    /** A body that IS a named type is a top-level use; anything else (`X[]`, a map) nests it. */
    private countBody(ref: TypeRef): void {
        if (ref.kind === 'ref') {
            const key = ref.refName!;
            this.topLevel.set(key, (this.topLevel.get(key) ?? 0) + 1);
            return;
        }
        this.walk(ref);
    }

    private walk(ref: TypeRef): void {
        switch (ref.kind) {
            case 'ref':
                this.markNested(ref.refName!);
                return;
            case 'array':
                this.walk(ref.items!);
                return;
            case 'openMap':
                this.walk(ref.values!);
                return;
            case 'union':
                for (const branch of ref.unionRefNames) {
                    this.markNested(branch);
                }
                return;
            default:
                return;
        }
    }
}
