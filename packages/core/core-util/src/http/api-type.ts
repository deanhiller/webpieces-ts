import 'reflect-metadata';
import { METADATA_KEYS } from './decorators';
import {
    InvalidEndpointForMcpMetadata,
    getInvalidEndpointsForMcp,
    getWpMcpTools,
    WpMcpToolMetadata,
} from '../mcp/McpMetadata';

/** Nominal backing keeps raw string literals out of contract declarations. */
enum ApiTypeValue {
    SVC_TO_SVC = 'svc-to-svc',
    EXTERNAL_CUSTOMER = 'external-customer',
    MCP = 'mcp',
}

/** Short, statically importable decorator arguments. */
export const SVC_TO_SVC = ApiTypeValue.SVC_TO_SVC;
export const EXTERNAL_CUSTOMER = ApiTypeValue.EXTERNAL_CUSTOMER;
export const MCP = ApiTypeValue.MCP;

/** WHICH generated documents a contract feeds. One value per document. */
export type ApiTypeKind = typeof SVC_TO_SVC | typeof EXTERNAL_CUSTOMER | typeof MCP;

/** Metadata key for the contract-level declaration, parallel to {@link METADATA_KEYS}. */
export const API_TYPE_METADATA_KEY = 'webpieces:api-type';

/** The fail-closed default: a contract that says nothing feeds only the internal document. */
export const DEFAULT_API_TYPES: readonly ApiTypeKind[] = [SVC_TO_SVC];

/**
 * WHICH generated documents this CONTRACT feeds.
 *
 * ```typescript
 * @ApiPath('/stores')
 * @ApiType(SVC_TO_SVC, EXTERNAL_CUSTOMER)   // private + customer documents
 * export abstract class StoreApi { ... }
 * ```
 *
 * | value | document |
 * |---|---|
 * | `SVC_TO_SVC` | `full-private-openapi.json` |
 * | `EXTERNAL_CUSTOMER` | `public-openapi.json` |
 * | `MCP` | `mcp-openapi.json` |
 *
 * A document is WRITTEN when at least one contract declares its type, and it contains the contracts
 * that declared it and no others. No contract declaring `MCP` therefore means no `mcp-openapi.json`
 * at all — there is no separate emptiness rule to keep in step with this one.
 *
 * ## Absent means `SVC_TO_SVC` only, and the level is why that is affordable
 *
 * `.claude/rules/no-backwards-compat.md` shim shape #5 rejects "a widening that is an ABSENCE rather
 * than a token": a default that publishes to customers would mean you reach them having typed
 * nothing, so the safe state requires an edit and the widest grant is free. Naming the type inverts
 * that — `grep -rn EXTERNAL_CUSTOMER` is the entire customer-facing surface on one screen.
 *
 * It is a CLASS-level declaration because that costs one token per contract rather than one per
 * method. A per-method audience list was the earlier design and was rejected on exactly that
 * ergonomic ground; the per-METHOD case that remains — a new endpoint on an already-published API —
 * is served by `{ hidden: true }` in `EndpointOptions`, which subtracts one method from the customer
 * document and leaves it in the other two. The two are orthogonal: this one selects FILES, that one
 * subtracts a METHOD from one file.
 *
 * ## `MCP` and `@WpMcpTool` are ONE decision
 *
 * `MCP` on a contract with no `@WpMcpTool` method is an error, and a `@WpMcpTool` method on a
 * contract that does not declare `MCP` is an error. Both directions are asserted by
 * {@link assertApiTypeMatchesMcpTools}; without that, membership is declared in two places and they
 * can disagree, which is the defect this whole documentation epic exists to remove.
 *
 * `@InvalidEndpointForMcp` sits OUTSIDE that biconditional: a method declared permanently unusable
 * as a tool is neither required to carry `@WpMcpTool` nor permitted to. A contract on which EVERY
 * endpoint is so declared must not declare `MCP` at all, and that too is asserted there.
 */
// webpieces-disable no-function-outside-class -- decorator factory; decorators are inherently module-scope
export function ApiType(first: ApiTypeKind, ...rest: readonly ApiTypeKind[]): ClassDecorator {
    const types = [first, ...rest];
    return (target: Function) => {
        Reflect.defineMetadata(API_TYPE_METADATA_KEY, types, target);
    };
}

/** The documents this contract feeds — its declaration, else {@link DEFAULT_API_TYPES}. */
// webpieces-disable no-function-outside-class -- metadata reader paired with the decorator
export function getApiTypes(apiClass: Function): readonly ApiTypeKind[] {
    const declared: ApiTypeKind[] | undefined = Reflect.getMetadata(
        API_TYPE_METADATA_KEY,
        apiClass,
    );
    return declared ?? DEFAULT_API_TYPES;
}

/**
 * MCP membership and `@WpMcpTool` must AGREE, in both directions.
 *
 * A wiring-time assert rather than a type, because the two declarations sit on different decorators
 * at different levels and TypeScript cannot relate them. It is the sibling of
 * `assertEveryEndpointHasAuthMode`, and exists for the same reason.
 */
// webpieces-disable no-function-outside-class -- wiring-time assert, sibling of assertEveryEndpointHasAuthMode
export function assertApiTypeMatchesMcpTools(apiClass: Function): void {
    const declaresMcp = getApiTypes(apiClass).includes(MCP);
    const tools = getWpMcpTools(apiClass);
    const excluded = getInvalidEndpointsForMcp(apiClass);
    assertNoToolIsAlsoExcluded(apiClass, tools, excluded);
    if (declaresMcp && tools.length === 0) {
        // The all-excluded case gets its own sentence because its cure is the opposite one: there is
        // nothing to add, and the contract should stop declaring MCP.
        if (excluded.length > 0 && excluded.length === getApiTypeEndpointNames(apiClass).length) {
            throw new Error(
                `${apiClass.name} declares @ApiType(..., MCP) but EVERY endpoint on it is ` +
                    '@InvalidEndpointForMcp. Drop MCP from the @ApiType list — a contract whose ' +
                    'every method is permanently outside MCP does not feed the MCP document.',
            );
        }
        throw new Error(
            `${apiClass.name} declares @ApiType(..., MCP) but no method carries @WpMcpTool. ` +
                "Add @WpMcpTool('<stable_tool_name>') to the methods agents may call, or drop MCP " +
                'from the @ApiType list.',
        );
    }
    if (!declaresMcp && tools.length > 0) {
        const named = tools.map((tool: WpMcpToolMetadata) => tool.methodName).join(', ');
        throw new Error(
            `${apiClass.name} has @WpMcpTool on ${named} but does not declare @ApiType(..., MCP). ` +
                'Add MCP to the @ApiType list — membership has ONE spelling, so a tool on a ' +
                'contract nobody published to agents is a contradiction, not a hint.',
        );
    }
}

/**
 * `@WpMcpTool` and `@InvalidEndpointForMcp` on ONE method is a contradiction, not a precedence rule.
 *
 * Resolving it either way would make the pair a second spelling of a decision that already has one —
 * shim shape #1 in `.claude/rules/no-backwards-compat.md` — and whichever way it resolved, half the
 * readers of that method would be wrong about what it does.
 */
// webpieces-disable no-function-outside-class -- private assert of assertApiTypeMatchesMcpTools, beside it
function assertNoToolIsAlsoExcluded(
    apiClass: Function,
    tools: readonly WpMcpToolMetadata[],
    excluded: readonly InvalidEndpointForMcpMetadata[],
): void {
    const excludedNames = new Set(
        excluded.map((one: InvalidEndpointForMcpMetadata) => one.methodName),
    );
    const both = tools
        .filter((tool: WpMcpToolMetadata) => excludedNames.has(tool.methodName))
        .map((tool: WpMcpToolMetadata) => tool.methodName);
    if (both.length === 0) return;
    throw new Error(
        `${apiClass.name} carries BOTH @WpMcpTool and @InvalidEndpointForMcp on ${both.join(', ')}. ` +
            'They contradict each other — one publishes the method to agents and the other declares ' +
            'it permanently unusable as a tool. Delete whichever one is wrong.',
    );
}

/** Reads the endpoints map so a caller can see which methods exist without importing decorators.ts. */
// webpieces-disable no-function-outside-class -- metadata reader, sibling of getApiTypes
export function getApiTypeEndpointNames(apiClass: Function): readonly string[] {
    const endpoints: Record<string, string> =
        Reflect.getMetadata(METADATA_KEYS.ENDPOINTS, apiClass) ?? {};
    return Object.keys(endpoints);
}
