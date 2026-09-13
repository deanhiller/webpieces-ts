import { WpMcpTool } from './McpMetadata';

abstract class InvalidMcpContract {
    // @ts-expect-error read-only tools cannot also claim to be destructive
    @WpMcpTool({
        name: 'invalid',
        description: 'This declaration must never compile.',
        readOnlyHint: true,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
    })
    invalid(): Promise<void> {
        throw new Error('contract only');
    }
}

void InvalidMcpContract;
