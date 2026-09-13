import 'reflect-metadata';
import { METADATA_KEYS } from '../http/decorators';

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
    idempotentHint: boolean;
    openWorldHint: boolean;
};

type ReadOnlyToolOptions = CommonToolOptions & {
    readOnlyHint: true;
    destructiveHint?: never;
};

type MutatingToolOptions = CommonToolOptions & {
    readOnlyHint: false;
    destructiveHint: boolean;
};

/** Compiler-enforced exposure: a read-only tool cannot also claim to be destructive. */
export type WpMcpToolOptions = ReadOnlyToolOptions | MutatingToolOptions;

/** Runtime metadata for one explicitly exposed endpoint. */
export class WpMcpToolMetadata {
    constructor(
        public readonly methodName: string,
        public readonly name: string,
        public readonly description: string,
        public readonly hints: WpMcpToolHints,
    ) {}
}

/**
 * Explicitly publishes an existing `@Endpoint(..., 'rpc')` method as an MCP tool.
 *
 * This annotation owns tool-level documentation only. Input/output field documentation and JSON
 * Schema come from the request/response DTO metadata. The endpoint's `@WpAuth*` annotation remains
 * the sole runtime authorization policy.
 */
// webpieces-disable no-function-outside-class -- decorator factories are inherently module-scope
export function WpMcpTool(options: WpMcpToolOptions): MethodDecorator {
    if (options.name.trim() === '') throw new Error('@WpMcpTool requires a non-empty stable name.');
    if (options.description.trim() === '') {
        throw new Error('@WpMcpTool requires non-empty tool documentation.');
    }
    return (target: object, propertyKey: string | symbol): void => {
        const apiClass = target.constructor;
        const tools: Record<string, WpMcpToolMetadata> =
            Reflect.getMetadata(METADATA_KEYS.MCP_TOOLS, apiClass) ?? {};
        const methodName = String(propertyKey);
        tools[methodName] = new WpMcpToolMetadata(
            methodName,
            options.name,
            options.description,
            new WpMcpToolHints(
                options.readOnlyHint,
                options.readOnlyHint ? false : options.destructiveHint,
                options.idempotentHint,
                options.openWorldHint,
            ),
        );
        Reflect.defineMetadata(METADATA_KEYS.MCP_TOOLS, tools, apiClass);
    };
}

/** Returns only methods explicitly opted in through {@link WpMcpTool}. */
// webpieces-disable no-function-outside-class -- metadata reader paired with the decorator
export function getWpMcpTools(apiClass: Function): WpMcpToolMetadata[] {
    const tools: Record<string, WpMcpToolMetadata> =
        Reflect.getMetadata(METADATA_KEYS.MCP_TOOLS, apiClass) ?? {};
    return Object.values(tools);
}
