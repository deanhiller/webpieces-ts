import 'reflect-metadata';
import { Mcp, McpToolProfilesOptions } from './Mcp';
import { McpToolName } from './McpToolName';
import { METADATA_KEYS } from '../http/decorators';
import { EndpointOperation, READ, WRITE_IDEMPOTENT, WRITE } from '../http/HttpEndpointOptions';

/** The immutable hints MCP clients use when deciding whether and how to call a tool. */
export class WpMcpToolHints {
    constructor(
        public readonly readOnlyHint: boolean,
        public readonly destructiveHint: boolean,
        public readonly idempotentHint: boolean,
        public readonly openWorldHint: boolean,
    ) {}
}

type AsyncObjectMethod = (...args: never[]) => Promise<object>;
type ExactOneParameter<TMethod extends AsyncObjectMethod> = Parameters<TMethod>['length'] extends 1
    ? object
    : never;
type ExactOneMethodDescriptor<TMethod extends AsyncObjectMethod> =
    TypedPropertyDescriptor<TMethod> & ExactOneParameter<TMethod>;

/** Method decorator restricted to one request DTO and one async response DTO. */
export type WpMcpMethodDecorator = <TMethod extends AsyncObjectMethod>(
    target: object,
    propertyKey: string | symbol,
    descriptor: ExactOneMethodDescriptor<TMethod>,
) => void;

/** Runtime metadata for one explicitly exposed endpoint. */
export class WpMcpToolMetadata {
    constructor(
        public readonly methodName: string,
        public readonly name: string,
        public readonly profiles: readonly string[],
    ) {}
}

/**
 * Explicitly publishes an existing `@Endpoint(POST, path, WRITE, RPC)` method as an MCP tool, under
 * the STABLE protocol name given here.
 *
 * ```typescript
 * /**
 *  * Every passage the learner can open, newest first.
 *  *
 *  * @summary Get your passages
 *  * @returns The learner's passages, newest first.
 *  *\/
 * @WpMcpTool('learner_get_passages')
 * ```
 *
 * The optional second argument selects profiles; omission selects only Mcp.DEFAULT. The name is the
 * one fact the source cannot otherwise state:
 *
 * | fact | where it comes from |
 * |---|---|
 * | `name` | this decorator — the stable protocol identity, independent of the method name because renaming a method must not break a saved agent workflow. 1-64 characters of `[A-Za-z0-9_-]` ({@link McpToolName}) |
 * | `title` | the method's REQUIRED `@summary` JSDoc tag — the same line OpenAPI publishes as the operation's `summary`; published as BOTH `Tool.title` and `annotations.title` |
 * | `description` | the method's JSDoc body, or its `@mcp` tag — the same words the partner reads |
 * | `readOnlyHint` / `idempotentHint` | `@Endpoint`'s `operation`, via {@link mcpHintsForOperation} |
 * | `destructiveHint` | `@Endpoint`'s `operation` and its `additive` option (a write is destructive unless `additive: true`), via {@link mcpHintsForOperation} |
 * | `openWorldHint` | `@Endpoint`'s `openWorld` option |
 * | `inputSchema` / `outputSchema` | the declared request and response types |
 *
 * ## Why the title is NOT an argument here (#1296)
 *
 * It used to be the second argument (#1180). That was a second place to write an endpoint's short
 * title: it never reached OpenAPI, whose operation `summary` was the bare method name, and the two
 * drifted. The title now has ONE source, the `@summary` JSDoc tag, which `wp-openapi` REQUIRES on every
 * published operation and publishes as OpenAPI `summary`, MCP `title` and MCP `annotations.title`.
 * Passing a title here is a compile error; the second parameter is the profiles object.
 *
 * Until #984 the decorator also took a `description`, duplicating the JSDoc, and was cut for the same
 * reason: two authored copies of one fact drift the first time somebody edits one.
 */
// webpieces-disable no-function-outside-class -- decorator factories are inherently module-scope
export function WpMcpTool(name: string, options?: McpToolProfilesOptions): WpMcpMethodDecorator {
    if (
        options !== undefined &&
        (typeof options !== 'object' ||
            options === null ||
            Array.isArray(options) ||
            Object.keys(options).some((key: string) => key !== 'profiles'))
    ) {
        throw new Error(
            '@WpMcpTool options must be an object containing only profiles. The tool title is the ' +
                "method's @summary JSDoc tag, never a decorator argument.",
        );
    }
    const profiles = Mcp.profiles(
        options !== undefined && 'profiles' in options ? options.profiles! : [Mcp.DEFAULT],
        '@WpMcpTool',
    );
    const problem = McpToolName.problemWith(name);
    if (problem !== undefined) {
        throw new Error(`@WpMcpTool('${name}'): the tool name ${problem}. ${McpToolName.cure()}`);
    }
    return <TMethod extends AsyncObjectMethod>(
        target: object,
        propertyKey: string | symbol,
        _descriptor: ExactOneMethodDescriptor<TMethod>,
    ): void => {
        const apiClass = target.constructor;
        const tools: Record<string, WpMcpToolMetadata> =
            Reflect.getMetadata(METADATA_KEYS.MCP_TOOLS, apiClass) ?? {};
        const methodName = String(propertyKey);
        tools[methodName] = new WpMcpToolMetadata(methodName, name, profiles);
        Reflect.defineMetadata(METADATA_KEYS.MCP_TOOLS, tools, apiClass);
    };
}

/** Runtime metadata for one endpoint declared PERMANENTLY outside MCP. */
export class InvalidEndpointForMcpMetadata {
    constructor(
        public readonly methodName: string,
        /** WHY it can never be a tool. Non-empty, enforced at decoration time. */
        public readonly reason: string,
    ) {}
}

/**
 * Declares that this endpoint is PERMANENTLY outside MCP, and says why.
 *
 * ## It is not a suppression, and that distinction is the whole feature
 *
 * `// webpieces-disable api-rules-for-mcp -- <reason>` says "stop complaining". This says "this is
 * structurally impossible, forever", and the two have different futures: a suppression is something
 * somebody should eventually come back to, and this is something nobody should. Both measured cases
 * are types that are CORRECT and must not be "fixed" —
 *
 *  - a webhook TRANSPORT envelope, whose `data` is owned by each event's own published contract;
 *    typing it here would fork that ownership and make adding an event type a change to the
 *    transport contract rather than a registration, and
 *  - a freeform-SQL escape hatch, whose result columns depend on the model-authored `SELECT`.
 *
 * The second one is worth stating rather than burying: it is the most obviously useful tool in that
 * repo, and it is excluded by a type that is right.
 *
 * ## Absence already says "not a tool YET"
 *
 * A method with no `@WpMcpTool` is simply not published. This decorator is the NEVER, and the reason
 * is what makes `grep -rn InvalidEndpointForMcp` a list of permanent exclusions with their arguments
 * rather than a list of names. `api-rules-for-mcp` restates that list on every run, so an exclusion
 * stays visible instead of being announced once and forgotten.
 *
 * ## It contradicts `@WpMcpTool`
 *
 * Both on one method is an ERROR, asserted by {@link assertApiTypeMatchesMcpTools}. "Publish this as
 * a tool" and "this can never be a tool" are two spellings of one decision, which is exactly the
 * defect `.claude/rules/no-backwards-compat.md` shim shape #1 rejects.
 *
 * ```typescript
 * @InvalidEndpointForMcp('a transport envelope body is opaque by design; the published partner ' +
 *     'contract for each event type owns its shape')
 * ```
 */
// webpieces-disable no-function-outside-class -- decorator factories are inherently module-scope
export function InvalidEndpointForMcp(reason: string): MethodDecorator {
    if (reason.trim() === '') {
        throw new Error(
            '@InvalidEndpointForMcp requires a non-empty reason. The reason IS the declaration — ' +
                'without it this is a suppression with a longer name.',
        );
    }
    return (target: object, propertyKey: string | symbol): void => {
        const apiClass = target.constructor;
        const excluded: Record<string, InvalidEndpointForMcpMetadata> =
            Reflect.getMetadata(METADATA_KEYS.MCP_INVALID, apiClass) ?? {};
        const methodName = String(propertyKey);
        excluded[methodName] = new InvalidEndpointForMcpMetadata(methodName, reason);
        Reflect.defineMetadata(METADATA_KEYS.MCP_INVALID, excluded, apiClass);
    };
}

/** Every method declared permanently outside MCP by {@link InvalidEndpointForMcp}. */
// webpieces-disable no-function-outside-class -- metadata reader paired with the decorator
export function getInvalidEndpointsForMcp(apiClass: Function): InvalidEndpointForMcpMetadata[] {
    const excluded: Record<string, InvalidEndpointForMcpMetadata> =
        Reflect.getMetadata(METADATA_KEYS.MCP_INVALID, apiClass) ?? {};
    return Object.values(excluded);
}

/**
 * The one mapping from endpoint side effects to MCP advisory annotations, and {@link operationForMcpHints}
 * beside it is the one mapping back. The two are tested against each other.
 *
 * | `@Endpoint` operation | `additive` | readOnly | destructive | idempotent |
 * |---|---|---|---|---|
 * | READ | (cannot be stated) | true | false | true |
 * | WRITE_IDEMPOTENT | absent | false | true | true |
 * | WRITE_IDEMPOTENT | `true` | false | **false** | true |
 * | WRITE | absent | false | true | false |
 * | WRITE | `true` | false | **false** | false |
 *
 * `openWorldHint` is `@Endpoint`'s `openWorld` option, verbatim. `destructiveHint: true` is the MCP
 * specification's safe default for a write; only an author who declared `additive: true` lowers it
 * (#1422). `@Endpoint` refuses `additive` on a READ at compile time; this function throws for it too,
 * because a generator reads the options from SOURCE and must not publish a hint the type forbade.
 */
// webpieces-disable no-function-outside-class -- pure metadata mapping shared by MCP registration
export function mcpHintsForOperation(
    operation: EndpointOperation,
    openWorldHint: boolean,
    additive: boolean,
): WpMcpToolHints {
    switch (operation) {
        case READ:
            if (additive) {
                throw new Error(
                    '`additive: true` is meaningful only on a WRITE or WRITE_IDEMPOTENT endpoint; a ' +
                        'READ changes nothing. Remove `additive` from the READ endpoint.',
                );
            }
            return new WpMcpToolHints(true, false, true, openWorldHint);
        case WRITE_IDEMPOTENT:
            return new WpMcpToolHints(false, !additive, true, openWorldHint);
        case WRITE:
            return new WpMcpToolHints(false, !additive, false, openWorldHint);
    }
}

/** Nominal backing for {@link UNKNOWN_OPERATION}. */
enum McpUnknownOperationValue {
    UNKNOWN = 'unknown',
}

/**
 * The operation of a tool whose server sent no annotations, or that the server does not list — the
 * fourth answer {@link operationForMcpHints} can give besides READ, WRITE and WRITE_IDEMPOTENT.
 */
export const UNKNOWN_OPERATION = McpUnknownOperationValue.UNKNOWN;

/** What a remote tool is known to do: an `@Endpoint` operation, or {@link UNKNOWN_OPERATION}. */
export type McpToolOperation = EndpointOperation | typeof UNKNOWN_OPERATION;

/**
 * The two annotations {@link operationForMcpHints} reads. A structural view, never constructed:
 * both {@link WpMcpToolHints} and the MCP SDK's `ToolAnnotations` (as a server sent them, every field
 * optional) satisfy it, so the reverse mapping needs no dependency on the SDK.
 */
export interface McpOperationHints {
    readonly readOnlyHint?: boolean;
    readonly idempotentHint?: boolean;
}

/**
 * The reverse of {@link mcpHintsForOperation}: which `@Endpoint` operation produced these hints.
 *
 * | `readOnlyHint` | `idempotentHint` | operation |
 * |---|---|---|
 * | true | any | READ |
 * | false | true | WRITE_IDEMPOTENT |
 * | false | false / absent | WRITE |
 * | absent (or no annotations at all) | | {@link UNKNOWN_OPERATION} |
 *
 * Only `readOnlyHint` and `idempotentHint` are read. `destructiveHint` is not, so an `additive`
 * write reverses to the same operation as a destructive one. An MCP host (`WpMcpRemote`'s approval
 * hook) uses this to tell a READ from a WRITE without a hard-coded list of tool names (#1422).
 */
// webpieces-disable no-function-outside-class -- pure metadata mapping paired with mcpHintsForOperation
export function operationForMcpHints(hints: McpOperationHints | undefined): McpToolOperation {
    if (hints === undefined || typeof hints.readOnlyHint !== 'boolean') return UNKNOWN_OPERATION;
    if (hints.readOnlyHint) return READ;
    return hints.idempotentHint === true ? WRITE_IDEMPOTENT : WRITE;
}

/** Returns only methods explicitly opted in through {@link WpMcpTool}. */
// webpieces-disable no-function-outside-class -- metadata reader paired with the decorator
export function getWpMcpTools(apiClass: Function): WpMcpToolMetadata[] {
    const tools: Record<string, WpMcpToolMetadata> =
        Reflect.getMetadata(METADATA_KEYS.MCP_TOOLS, apiClass) ?? {};
    return Object.values(tools);
}
