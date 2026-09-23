import {
    ApiJsonSchema,
    AuthMeta,
    assertApiTypeMatchesMcpTools,
    getAuthMeta,
    getEndpointKind,
    getEndpointOperation,
    getEndpoints,
    getWpMcpTools,
    getWpMcpAuthJwt,
    rolesRequired,
    EndpointOperation,
    McpToolCatalogError,
    McpToolCatalogFile,
    McpToolDefinition,
    WpMcpJwtAuthMetadata,
    WpMcpToolHints,
    WpMcpToolMetadata,
} from '@webpieces/core-util';
import { ClassType } from '@webpieces/http-routing';
import { McpApiBinding } from './McpApiBinding';
import { McpToolCatalog } from './McpToolCatalog';

/** Fully resolved contract metadata for one MCP tool. */
export class RegisteredMcpTool {
    constructor(
        public readonly apiClass: ClassType,
        public readonly methodName: string,
        public readonly name: string,
        public readonly description: string,
        public readonly annotations: WpMcpToolHints,
        public readonly operation: EndpointOperation,
        public readonly authMeta: AuthMeta,
        public readonly mcpAuth: WpMcpJwtAuthMetadata,
        public readonly binding: McpApiBinding,
        public readonly inputSchema: ApiJsonSchema,
        public readonly outputSchema: ApiJsonSchema,
    ) {}

    /** Listing is advisory; MCP authorization is rechecked before the endpoint auth boundary. */
    isVisibleTo(listingRoles: readonly string[]): boolean {
        const required = rolesRequired(this.mcpAuth.requirement);
        return (
            required.length === 0 || required.some((role: string) => listingRoles.includes(role))
        );
    }
}

/**
 * Fail-fast registry: the CONTRACT says which methods are tools and how they are authorized, and the
 * build's generated catalog OF THAT CONTRACT says what each tool's documentation and schemas are.
 *
 * ## Why the schemas come from the catalog and not from here
 *
 * They used to be built at boot by `DtoSchemaBuilder` walking reflect-metadata. That made the
 * document a partner reads and the schema a server accepts two independent derivations of one
 * contract, free to disagree; and it could not see a field's declared TYPE at all, so every fact
 * about a field had to be restated in a `@WpDtoField` argument. #983 measured the compiler against
 * it and found the compiler reproduces all of it, so #984 deleted the decorator and this registry
 * now READS the same catalogs the documents were rendered beside.
 *
 * ## One catalog per bound contract, exactly (#1021)
 *
 * `wp-openapi` writes one `mcp-<ContractClass>-tools.json` per contract, and this registry pairs every
 * `McpApiBinding` with the file of its own contract. Three mismatches refuse the boot, all reported at
 * once, each naming every directory the catalogs were read from:
 *
 * - a bound contract with no catalog — its tools were never given a schema by the build;
 * - a catalog whose contract is not bound — the server was handed tools it does not serve;
 * - a tool name declared twice — the protocol namespace is flat.
 *
 * A registered `@WpMcpTool` the catalog does not name is likewise a HARD FAILURE, not a fallback: a
 * tool the build never saw is a tool whose schema nobody checked.
 */
export class McpToolRegistry {
    readonly tools: readonly RegisteredMcpTool[];

    constructor(bindings: readonly McpApiBinding[], catalogs: readonly McpToolCatalog[]) {
        const pairing = new McpCatalogPairing(catalogs);
        const registered: RegisteredMcpTool[] = [];
        const names = new Set<string>();
        for (const binding of bindings) {
            const apiClass = binding.api;
            // MCP membership is declared twice — on @ApiType and on the methods — and this is the
            // one call that makes the two disagree impossible. It existed before #984 and nothing
            // reached it, so a contract could carry tools nobody published to agents.
            assertApiTypeMatchesMcpTools(apiClass);
            const declared = getWpMcpTools(apiClass);
            const catalog = pairing.claim(apiClass, declared.length);
            for (const metadata of declared) {
                if (names.has(metadata.name)) {
                    pairing.problem(
                        `Duplicate @WpMcpTool name '${metadata.name}' (again on ${apiClass.name}). Tool ` +
                            'names are the protocol identity and must be globally unique — rename one.',
                    );
                    continue;
                }
                names.add(metadata.name);
                const tool = this.resolve(apiClass, metadata, binding, catalog, pairing);
                if (tool !== undefined) registered.push(tool);
            }
        }
        pairing.assertComplete();
        this.tools = registered;
    }

    find(name: string): RegisteredMcpTool | undefined {
        return this.tools.find((tool: RegisteredMcpTool) => tool.name === name);
    }

    /**
     * The contract checks THROW at once — they are about the contract source, not the build. A tool
     * missing from its catalog is RECORDED on `pairing`, so one boot names every catalog mismatch.
     */
    private resolve(
        apiClass: ClassType,
        metadata: WpMcpToolMetadata,
        binding: McpApiBinding,
        catalog: McpToolCatalog | undefined,
        pairing: McpCatalogPairing,
    ): RegisteredMcpTool | undefined {
        const endpoints = getEndpoints(apiClass) ?? {};
        if (!endpoints[metadata.methodName]) {
            throw new Error(
                `@WpMcpTool ${apiClass.name}.${metadata.methodName} must also be an @Endpoint.`,
            );
        }
        if (getEndpointKind(apiClass, metadata.methodName) !== 'rpc') {
            throw new Error(
                `@WpMcpTool ${apiClass.name}.${metadata.methodName} must be an RPC endpoint.`,
            );
        }
        const authMeta = getAuthMeta(apiClass, metadata.methodName);
        if (!authMeta)
            throw new Error(`@WpMcpTool ${apiClass.name}.${metadata.methodName} has no HTTP auth.`);
        const mcpAuth = getWpMcpAuthJwt(apiClass, metadata.methodName);
        if (!mcpAuth) {
            throw new Error(
                `@WpMcpTool ${apiClass.name}.${metadata.methodName} must declare @WpMcpAuthJwt(...).`,
            );
        }
        binding.validateMethod(metadata.methodName);
        if (catalog === undefined) return undefined;
        const published = this.published(apiClass, metadata, catalog, pairing);
        if (published === undefined) return undefined;
        return new RegisteredMcpTool(
            apiClass,
            metadata.methodName,
            metadata.name,
            published.description,
            published.hints,
            getEndpointOperation(apiClass, metadata.methodName),
            authMeta,
            mcpAuth,
            binding,
            published.inputSchema,
            published.outputSchema,
        );
    }

    /** The generated entry for this tool, or a recorded refusal naming what the build DID publish. */
    private published(
        apiClass: ClassType,
        metadata: WpMcpToolMetadata,
        catalog: McpToolCatalog,
        pairing: McpCatalogPairing,
    ): McpToolDefinition | undefined {
        const published = catalog.find(metadata.name);
        if (published === undefined) {
            pairing.problem(
                `@WpMcpTool ${apiClass.name}.${metadata.methodName} publishes '${metadata.name}', which ` +
                    `${catalog.file.fileName} (${catalog.directory}) does not contain. It has: ` +
                    `${catalog.names().join(', ') || '(nothing)'}. The catalog is older than the contract — ` +
                    'rebuild the api library; a tool the build never saw is a tool whose schema nobody checked.',
            );
        }
        return published;
    }
}

/**
 * Pairs each bound contract with the catalog of exactly that contract, and collects every mismatch so
 * the boot refusal lists them all at once instead of one per restart.
 */
class McpCatalogPairing {
    private readonly byContract = new Map<string, McpToolCatalog>();
    private readonly claimed = new Set<string>();
    private readonly problems: string[] = [];

    constructor(private readonly catalogs: readonly McpToolCatalog[]) {
        for (const catalog of catalogs) {
            const earlier = this.byContract.get(catalog.contractName);
            if (earlier !== undefined) {
                this.problem(
                    `Two MCP tool catalogs for ${catalog.contractName}: ${earlier.directory} and ` +
                        `${catalog.directory}. Name each api library in fromPackages(...) once, and bind ` +
                        'each contract from exactly one of them.',
                );
                continue;
            }
            this.byContract.set(catalog.contractName, catalog);
        }
    }

    /** The catalog of `apiClass`, recording a problem when there is none. */
    claim(apiClass: ClassType, declaredTools: number): McpToolCatalog | undefined {
        const catalog = this.byContract.get(apiClass.name);
        this.claimed.add(apiClass.name);
        if (catalog !== undefined) return catalog;
        this.problem(
            declaredTools === 0
                ? `The server binds ${apiClass.name}, which declares no @WpMcpTool method, so the build ` +
                      `wrote no ${McpToolCatalogFile.fileNameFor(apiClass.name)} for it. Delete its ` +
                      'McpApiBinding — it publishes nothing.'
                : `The server binds ${apiClass.name}, and no ${McpToolCatalogFile.fileNameFor(apiClass.name)} ` +
                      "was handed to it. Add the api library that declares it to McpToolCatalog.fromPackages([...]) " +
                      'and rebuild that library (its openapi-generate target writes the file).',
        );
        return undefined;
    }

    problem(text: string): void {
        this.problems.push(text);
    }

    /** Refuse the boot on any mismatch, naming every problem and every directory searched. */
    assertComplete(): void {
        for (const catalog of this.byContract.values()) {
            if (this.claimed.has(catalog.contractName)) continue;
            this.problem(
                `${catalog.file.fileName} (${catalog.directory}) is the catalog of ${catalog.contractName}, ` +
                    `which the server does not bind. Bind it with McpApiBinding.local(${catalog.contractName}, ...) ` +
                    'or .remote(...), or leave it out of toolCatalogs, e.g. ' +
                    `catalogs.filter((catalog: McpToolCatalog) => catalog.contractName !== '${catalog.contractName}').`,
            );
        }
        if (this.problems.length === 0) return;
        const directories = [...new Set(this.catalogs.map((catalog: McpToolCatalog) => catalog.directory))];
        throw new McpToolCatalogError(
            'The MCP tool catalogs do not match the bound contracts:\n' +
                this.problems.map((text: string) => `  - ${text}`).join('\n') +
                '\nDirectories searched for mcp-<ContractClass>-tools.json:\n' +
                (directories.length === 0
                    ? '  (none — toolCatalogs is empty)'
                    : directories.map((dir: string) => `  ${dir}`).join('\n')) +
                '\n',
            'Each bound contract needs exactly the one catalog its api library build writes, and nothing else.',
        );
    }
}
