import 'reflect-metadata';
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
    ) {}
}

/**
 * Explicitly publishes an existing `@Endpoint(POST, path, WRITE, RPC)` method as an MCP tool, under
 * the STABLE protocol name given here.
 *
 * The name is the whole argument, and deliberately the only one. It is independent of the method
 * name because renaming a method must not break a saved agent workflow, and nothing else about a
 * tool is unsayable in the source:
 *
 * | fact | where it comes from |
 * |---|---|
 * | `description` | the method's JSDoc body, or its `@mcp` tag — the same words the partner reads |
 * | `readOnlyHint` / `destructiveHint` / `idempotentHint` | `@Endpoint`'s `operation`, via {@link mcpHintsForOperation} |
 * | `openWorldHint` | `@Endpoint`'s `openWorld` option |
 * | `inputSchema` / `outputSchema` | the declared request and response types |
 *
 * ```typescript
 * @WpMcpTool('search_stores')
 * ```
 *
 * Until #984 it also took a `description`, duplicating the JSDoc. Two authored copies of one
 * paragraph drift the first time somebody edits one, and nothing catches it — the partner reads the
 * OpenAPI text and the agent reads the decorator text. With `description` gone the options object
 * held one field, so it is a plain string and `WpMcpToolOptions` is deleted with it.
 */
// webpieces-disable no-function-outside-class -- decorator factories are inherently module-scope
export function WpMcpTool(name: string): WpMcpMethodDecorator {
    if (name.trim() === '') throw new Error('@WpMcpTool requires a non-empty stable name.');
    return <TMethod extends AsyncObjectMethod>(
        target: object,
        propertyKey: string | symbol,
        _descriptor: ExactOneMethodDescriptor<TMethod>,
    ): void => {
        const apiClass = target.constructor;
        const tools: Record<string, WpMcpToolMetadata> =
            Reflect.getMetadata(METADATA_KEYS.MCP_TOOLS, apiClass) ?? {};
        const methodName = String(propertyKey);
        tools[methodName] = new WpMcpToolMetadata(methodName, name);
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

/** The one mapping from endpoint side effects to MCP advisory annotations. */
// webpieces-disable no-function-outside-class -- pure metadata mapping shared by MCP registration
export function mcpHintsForOperation(
    operation: EndpointOperation,
    openWorldHint: boolean,
): WpMcpToolHints {
    switch (operation) {
        case READ:
            return new WpMcpToolHints(true, false, true, openWorldHint);
        case WRITE_IDEMPOTENT:
            return new WpMcpToolHints(false, true, true, openWorldHint);
        case WRITE:
            return new WpMcpToolHints(false, true, false, openWorldHint);
    }
}

/** Returns only methods explicitly opted in through {@link WpMcpTool}. */
// webpieces-disable no-function-outside-class -- metadata reader paired with the decorator
export function getWpMcpTools(apiClass: Function): WpMcpToolMetadata[] {
    const tools: Record<string, WpMcpToolMetadata> =
        Reflect.getMetadata(METADATA_KEYS.MCP_TOOLS, apiClass) ?? {};
    return Object.values(tools);
}
