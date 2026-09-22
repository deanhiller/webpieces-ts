import 'reflect-metadata';
import { METADATA_KEYS } from '../http/decorators';
import {
    EndpointOperation,
    READ,
    WRITE_IDEMPOTENT,
    WRITE,
} from '../http/HttpEndpointOptions';

/** The immutable hints MCP clients use when deciding whether and how to call a tool. */
export class WpMcpToolHints {
    constructor(
        public readonly readOnlyHint: boolean,
        public readonly destructiveHint: boolean,
        public readonly idempotentHint: boolean,
        public readonly openWorldHint: boolean,
    ) {}
}

type CommonToolOptions = {
    /** Stable protocol name. Renaming this breaks saved agent workflows. */
    name: string;
    /** Tool-level documentation published verbatim by tools/list. */
    description: string;
    openWorldHint: boolean;
};

/** Tool-specific declarations. Side-effect hints come only from the endpoint operation. */
export type WpMcpToolOptions = CommonToolOptions;

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
        public readonly description: string,
        public readonly openWorldHint: boolean,
    ) {}
}

/**
 * Explicitly publishes an existing `@Endpoint(POST, path, WRITE, RPC)` method as an MCP tool.
 *
 * This annotation owns tool-level documentation only. Input/output field documentation and JSON
 * Schema come from the request/response DTO metadata. The endpoint's `@WpAuth*` annotation remains
 * the sole runtime authorization policy.
 */
// webpieces-disable no-function-outside-class -- decorator factories are inherently module-scope
export function WpMcpTool(options: WpMcpToolOptions): WpMcpMethodDecorator {
    if (options.name.trim() === '') throw new Error('@WpMcpTool requires a non-empty stable name.');
    if (options.description.trim() === '') {
        throw new Error('@WpMcpTool requires non-empty tool documentation.');
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
        tools[methodName] = new WpMcpToolMetadata(
            methodName,
            options.name,
            options.description,
            options.openWorldHint,
        );
        Reflect.defineMetadata(METADATA_KEYS.MCP_TOOLS, tools, apiClass);
    };
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
