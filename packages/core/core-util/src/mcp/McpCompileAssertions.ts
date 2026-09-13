import { WpMcpTool } from './McpMetadata';
import { WpDtoFieldOptions } from './DtoSchema';

// @ts-expect-error enumValues must contain at least one allowed string
const invalidEmptyEnum = new WpDtoFieldOptions(
    'invalid enum',
    true,
    undefined,
    false,
    undefined,
    undefined,
    [],
);

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
void invalidEmptyEnum;
