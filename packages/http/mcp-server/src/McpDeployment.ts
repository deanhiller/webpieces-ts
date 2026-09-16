import { InMemoryServerEventBus, ServerEventBus } from '@modelcontextprotocol/server';

export type McpDeploymentMode = 'single-process' | 'distributed';

/** Makes process topology and bounded list-cache behavior explicit at construction. */
export class McpDeployment {
    private constructor(
        public readonly mode: McpDeploymentMode,
        public readonly bus: ServerEventBus,
        public readonly ttlMs: number,
    ) {
        if (!Number.isFinite(ttlMs) || ttlMs <= 0)
            throw new Error('MCP list cache ttlMs must be positive.');
    }

    // webpieces-disable no-function-outside-class -- explicit deployment factory
    static singleProcess(ttlMs = 30_000): McpDeployment {
        return new McpDeployment('single-process', new InMemoryServerEventBus(), ttlMs);
    }

    // webpieces-disable no-function-outside-class -- explicit deployment factory
    static distributed(bus: ServerEventBus, ttlMs = 30_000): McpDeployment {
        if (!bus) throw new Error('Distributed MCP deployment requires a shared ServerEventBus.');
        if (bus instanceof InMemoryServerEventBus) {
            throw new Error(
                'Distributed MCP deployment cannot use InMemoryServerEventBus; supply a cross-instance bus.',
            );
        }
        return new McpDeployment('distributed', bus, ttlMs);
    }
}
