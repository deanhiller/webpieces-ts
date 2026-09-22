import {
    ApiDocModel,
    DocumentedApiKey,
    DocumentedEndpoint,
    DocumentedField,
    DocumentedType,
    TypeRef,
} from '@webpieces/api-doc-model';
import { JsonObject, JsonValue } from '../json/JsonObject';
import { OpenApiGenerationError } from '../OpenApiGenerationError';
import { ServerEntry } from '../manifest/OpenApiManifest';
import {
    ContractModel,
    GeneratedDocument,
    GeneratedDocuments,
    GenerationInputs,
} from './GenerationInputs';
import { DocumentSelection } from './DocumentSelection';
import { OperationRenderer, ResponseContract } from './OperationRenderer';
import { SchemaRenderer, UnmappedField } from './SchemaRenderer';
import { SecurityDeriver } from './SecurityDeriver';

/** The OpenAPI version this generator writes. See the class doc for why 3.1 and not 3.0. */
const OPENAPI_VERSION = '3.1.0';

/**
 * {@link GenerationInputs} -> one OpenAPI 3.1.0 document per `@ApiType` some contract declares.
 *
 * ## 3.1, because it is what the model can state HONESTLY
 *
 * `type: [T, "null"]` instead of a `nullable` keyword; a `description` legal beside a `$ref`; a
 * top-level `webhooks:` block. Each of those is a fact the model holds that 3.0 would have forced
 * this renderer to drop or to lie about. 3.1's schema dialect is also JSON Schema 2020-12, which is
 * what MCP `tools/list` speaks.
 *
 * ## ONE render function, called once per document
 *
 * ```
 * ApiDocModel --> render(selection) --+--> full-private-openapi.json  SVC_TO_SVC contracts
 *                                     +--> public-openapi.json        EXTERNAL_CUSTOMER contracts, minus hidden methods
 *                                     +--> mcp-openapi.json           MCP contracts
 * ```
 *
 * `components.schemas` is built by walking OUTWARD from the operations the selection accepted, so an
 * unselected operation's DTOs are never constructed. See {@link DocumentSelection} for why that
 * asymmetry — a bug emits nothing, rather than shipping an unreleased feature's schemas with only
 * its URL removed — decides the whole design.
 *
 * ## It REFUSES to write an unmapped field
 *
 * An unmapped type renders as an empty schema, which in JSON Schema means "anything". Publishing one
 * is a green build handing a partner a field with no shape, so the guard names the JSON pointer of
 * every one and exits non-zero. There is deliberately NO flag to switch it off: the cure is at the
 * contract, by naming the type.
 */
export class OpenApiGenerator {
    private readonly security = new SecurityDeriver();

    /**
     * ONE document per `@ApiType` some contract declares, and no others.
     *
     * A document nobody asked for is not written empty — it is not written. That is the ONE
     * conditional in the whole pipeline, and it lives here rather than in three places: no contract
     * declaring `MCP` means no `mcp-openapi.json`, with no second "is it empty?" rule to keep in step
     * with the first.
     */
    generate(inputs: GenerationInputs): GeneratedDocuments {
        const documents: GeneratedDocument[] = [];
        for (const selection of DocumentSelection.all()) {
            const contracts = inputs.contracts.filter((each: ContractModel) =>
                selection.acceptsContract(each.model),
            );
            if (contracts.length === 0) {
                continue;
            }
            documents.push(
                new GeneratedDocument(
                    selection.fileName,
                    this.render(inputs, contracts, selection),
                ),
            );
        }
        return new GeneratedDocuments(documents);
    }

    /** ONE document, from the operations this selection accepts and nothing else. */
    private render(
        inputs: GenerationInputs,
        contracts: readonly ContractModel[],
        selection: DocumentSelection,
    ): JsonObject {
        const types = this.mergedTypes(inputs);
        const schemas = new SchemaRenderer(types);
        const operations = new OperationRenderer(
            schemas,
            selection.includeMcpExtensions,
            selection.internalNotice,
        );
        const apiKey = this.singleApiKey(inputs, contracts, selection);
        const schemeNames = inputs.manifest.securitySchemeNames;
        const hoisted =
            apiKey !== undefined && this.everyOperationIsCovered(contracts, selection)
                ? this.security.requirement(schemeNames)
                : undefined;

        const contract = new ResponseContract(
            this.errorResponses(inputs),
            this.errorSchemaRef(inputs, schemas),
            this.headerRefs(inputs),
        );

        const paths = new JsonObject();
        const webhooks = new JsonObject();
        const tags = new JsonObject();
        for (const contractModel of contracts) {
            this.renderContract(
                contractModel,
                selection,
                operations,
                contract,
                this.webhookContract(),
                hoisted === undefined ? this.security.requirement(schemeNames) : undefined,
                paths,
                webhooks,
                tags,
            );
        }

        // The schemas are built HERE, after the operations, because building them is what walks a
        // DTO's fields — and an unmapped field can only be found by that walk. A guard that ran
        // before it would see only the top-level request and response refs and miss every one.
        const renderedSchemas = schemas.components().orUndefined();
        this.refuseUnmappedFields(schemas.unmapped(), inputs, selection);

        const components = new JsonObject()
            .set('schemas', renderedSchemas)
            .set(
                'securitySchemes',
                apiKey === undefined
                    ? undefined
                    : this.security.schemes(apiKey, schemeNames, inputs.manifestPath),
            )
            .set('headers', this.headers(inputs));

        return new JsonObject()
            .set('openapi', OPENAPI_VERSION)
            .set('info', this.info(inputs, selection))
            .set('servers', this.servers(inputs))
            .set('tags', this.tagList(tags))
            .set('security', hoisted === undefined ? undefined : hoisted.slice())
            .set('paths', paths)
            .set('webhooks', webhooks.orUndefined())
            .set('components', components.orUndefined());
    }

    /**
     * A webhook is served by the PARTNER, so neither our failure envelope nor the header we stamp on
     * our own responses is true of it. Publishing either would document their server, not ours.
     */
    private webhookContract(): ResponseContract {
        return new ResponseContract(new Map<string, string>(), undefined, undefined);
    }

    /** One contract's ACCEPTED endpoints, into `paths` or into `webhooks`. */
    private renderContract(
        contractModel: ContractModel,
        selection: DocumentSelection,
        operations: OperationRenderer,
        contract: ResponseContract,
        webhookContract: ResponseContract,
        perOperationSecurity: readonly JsonValue[] | undefined,
        paths: JsonObject,
        webhooks: JsonObject,
        tags: JsonObject,
    ): void {
        const model = contractModel.model;
        const tag = contractModel.entry.tag;
        for (const endpoint of model.endpoints) {
            if (!selection.acceptsEndpoint(endpoint)) {
                continue;
            }
            // A tag is added only by an operation that survived, so a document never advertises a
            // section of its sidebar that turns out to be empty.
            tags.set(tag, this.tagProse(model) ?? '');
            if (contractModel.entry.isWebhook()) {
                webhooks.set(
                    this.eventName(endpoint),
                    new JsonObject().set(
                        'post',
                        operations.webhook(endpoint, model.contractName, tag, webhookContract),
                    ),
                );
                continue;
            }
            const url = `${model.basePath}${endpoint.path}`;
            const existing = paths.get(url);
            const item = existing instanceof JsonObject ? existing : new JsonObject();
            item.set(
                endpoint.httpMethod.toLowerCase(),
                operations.operation(
                    endpoint,
                    model.contractName,
                    tag,
                    contract,
                    endpoint.auth?.apiKey === undefined ? undefined : perOperationSecurity,
                ),
            );
            paths.set(url, item);
        }
    }

    /**
     * A webhook is keyed by the EVENT NAME, with the `@ApiPath` base deliberately NOT prepended.
     *
     * There is no url of ours here — the partner hosts the endpoint, at whatever path they choose —
     * so publishing `/our-base/delivered` would document a route that exists nowhere. What we are
     * naming is the event we will send.
     */
    private eventName(endpoint: DocumentedEndpoint): string {
        return endpoint.path.replace(/^\/+/, '');
    }

    /**
     * Every named type from every contract, merged.
     *
     * Two contracts declaring DIFFERENT types under one name is a hard failure, not a first-wins
     * merge: `components.schemas` is keyed by name, so one of the two would be published as the
     * other's shape, and the operation referring to it would be quietly wrong.
     */
    private mergedTypes(inputs: GenerationInputs): ReadonlyMap<string, DocumentedType> {
        const merged = new Map<string, DocumentedType>();
        const sources = inputs.contracts.map((each: ContractModel) => each.model);
        const all = inputs.errorType === undefined ? sources : sources.concat([inputs.errorType]);
        for (const model of all) {
            for (const name of Array.from(model.types.keys())) {
                const incoming = model.types.get(name)!;
                const existing = merged.get(name);
                if (
                    existing !== undefined &&
                    this.signature(existing) !== this.signature(incoming)
                ) {
                    throw new OpenApiGenerationError(
                        `two different types are both named '${name}'`,
                        `${model.contractName} (${inputs.manifestPath})`,
                        'Rename one of them. `components.schemas` is keyed by name, so one shape ' +
                            'would be published as the other.',
                    );
                }
                merged.set(name, incoming);
            }
        }
        return merged;
    }

    /** Enough of a type's shape to tell two same-named types apart without comparing prose. */
    private signature(type: DocumentedType): string {
        const fields = type.fields.map((field: DocumentedField) => field.name).join(',');
        return `${fields}|${type.enumValues.join(',')}|${type.unionRefNames.join(',')}`;
    }

    /**
     * The ONE api-key regime this document publishes.
     *
     * Two regimes in one document is a hard failure: `securitySchemeNames` is a single ordered list,
     * so there is no honest way to say which regime a given name belongs to, and a document that
     * guessed would publish one regime's header names under the other's scheme keys.
     */
    private singleApiKey(
        inputs: GenerationInputs,
        contracts: readonly ContractModel[],
        selection: DocumentSelection,
    ): DocumentedApiKey | undefined {
        let found: DocumentedApiKey | undefined;
        for (const endpoint of this.selectedEndpoints(contracts, selection)) {
            const apiKey = endpoint.auth?.apiKey;
            if (apiKey === undefined) {
                continue;
            }
            if (found !== undefined && found.regime !== apiKey.regime) {
                throw new OpenApiGenerationError(
                    `the ${selection.fileName} document mixes the api-key regimes ` +
                        `'${found.regime}' ` +
                        `and '${apiKey.regime}'`,
                    inputs.manifestPath,
                    'Publish one regime per document — split the manifest, or move the ' +
                        "other regime's contract out of `apis`.",
                );
            }
            found = apiKey;
        }
        return found;
    }

    /**
     * True when EVERY selected operation demands the credential, which is what licenses hoisting the
     * requirement to the document. A document that mixes credentialled and uncredentialled routes
     * stamps it per-operation instead — hoisting there would tell a partner that a public endpoint
     * needs a key.
     *
     * Judged per DOCUMENT, over the operations that document actually contains, because that is the
     * only question the document's own `security` block answers.
     */
    private everyOperationIsCovered(
        contracts: readonly ContractModel[],
        selection: DocumentSelection,
    ): boolean {
        const served = this.selectedEndpoints(contracts, selection);
        return (
            served.length > 0 &&
            served.every((e: DocumentedEndpoint) => e.auth?.apiKey !== undefined)
        );
    }

    /**
     * The endpoints this selection accepts that are routes on OUR server. A webhook is somebody
     * else's route, so it never counts toward our security requirement or our regime.
     */
    private selectedEndpoints(
        contracts: readonly ContractModel[],
        selection: DocumentSelection,
    ): readonly DocumentedEndpoint[] {
        const served: DocumentedEndpoint[] = [];
        for (const contract of contracts) {
            if (contract.entry.isWebhook()) {
                continue;
            }
            for (const endpoint of contract.model.endpoints) {
                if (selection.acceptsEndpoint(endpoint)) {
                    served.push(endpoint);
                }
            }
        }
        return served;
    }

    /** `info`, whose `description` is the ONE piece of prose that differs between the documents. */
    private info(inputs: GenerationInputs, selection: DocumentSelection): JsonObject {
        return new JsonObject()
            .set('title', inputs.manifest.title)
            .set('version', inputs.manifest.version)
            .set('description', selection.description(inputs.description));
    }

    private servers(inputs: GenerationInputs): readonly JsonValue[] | undefined {
        if (inputs.manifest.servers.length === 0) {
            return undefined;
        }
        return inputs.manifest.servers.map((server: ServerEntry) =>
            new JsonObject().set('url', server.url).set('description', server.description),
        );
    }

    /**
     * `tags[]` in MANIFEST ORDER, because that order IS the published sidebar — one of the two
     * orders in this document that carries meaning and is therefore NOT sorted.
     */
    private tagList(tags: JsonObject): readonly JsonValue[] | undefined {
        const list: JsonValue[] = [];
        for (const name of tags.keys()) {
            const prose = tags.get(name);
            list.push(
                new JsonObject()
                    .set('name', name)
                    .set('description', prose === '' ? undefined : prose),
            );
        }
        return list.length === 0 ? undefined : list;
    }

    private tagProse(model: ApiDocModel): string | undefined {
        return model.description.trim() === '' ? undefined : model.description;
    }

    private errorResponses(inputs: GenerationInputs): ReadonlyMap<string, string> {
        const responses = new Map<string, string>();
        for (const response of inputs.manifest.errors?.responses ?? []) {
            responses.set(response.status, response.description);
        }
        return responses;
    }

    private errorSchemaRef(
        inputs: GenerationInputs,
        schemas: SchemaRenderer,
    ): JsonObject | undefined {
        const errors = inputs.manifest.errors;
        if (errors === undefined || inputs.errorType === undefined) {
            return undefined;
        }
        // Rendering the reference is what puts the error body into `components.schemas`, so the
        // published shape is the compiler's answer about that TS type and not a hand-copied one.
        return schemas.type(TypeRef.ref(errors.type), '#/components/schemas/error');
    }

    /** `components.headers`, one entry per declared response header. */
    private headers(inputs: GenerationInputs): JsonObject | undefined {
        const headers = new JsonObject();
        for (const header of inputs.responseHeaders) {
            headers.set(
                header.headerName,
                new JsonObject()
                    .set('description', header.description)
                    .set('schema', new JsonObject().set('type', 'string')),
            );
        }
        return headers.orUndefined();
    }

    /** The `$ref`s every SUCCESS response carries at those headers. */
    private headerRefs(inputs: GenerationInputs): JsonObject | undefined {
        const refs = new JsonObject();
        for (const header of inputs.responseHeaders) {
            refs.set(
                header.headerName,
                new JsonObject().set('$ref', `#/components/headers/${header.headerName}`),
            );
        }
        return refs.orUndefined();
    }

    /**
     * The guard. An unmapped field is a published partner-facing field with no shape, and there is
     * deliberately no flag to switch this off — the cure is at the contract, by naming the type.
     */
    private refuseUnmappedFields(
        unmapped: readonly UnmappedField[],
        inputs: GenerationInputs,
        selection: DocumentSelection,
    ): void {
        if (unmapped.length === 0) {
            return;
        }
        const pointers = unmapped.map(
            (field: UnmappedField) => `${field.pointer} (${field.typeText})`,
        );
        throw new OpenApiGenerationError(
            `${unmapped.length} field(s) in ${selection.fileName} have no schema it can state`,
            inputs.manifestPath,
            'Give each one a type a document can carry — a named DTO, an array of one, a ' +
                'string-literal union, or Record<string, X>. An untyped field publishes as "anything".',
            pointers,
        );
    }
}
