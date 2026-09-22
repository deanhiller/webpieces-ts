import { WpMcpTool } from './McpMetadata';
import { WpDtoFieldOptions, WpDtoMapFieldOptions } from './DtoSchema';

const invalidEmptyEnum = new WpDtoFieldOptions(
    'invalid enum',
    true,
    undefined,
    false,
    undefined,
    undefined,
    // @ts-expect-error enumValues must contain at least one allowed string
    [],
);

// @ts-expect-error a map's value type must be a scalar name or a DtoClass
const invalidMapValue = new WpDtoMapFieldOptions('invalid map', true, 'date');

// @ts-expect-error a map value type is mandatory: it is the whole point of WpDtoMapFieldOptions
const missingMapValue = new WpDtoMapFieldOptions('invalid map', true);

const noEighthFieldArgument = new WpDtoFieldOptions(
    'maps are not a WpDtoFieldOptions argument',
    false,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    // @ts-expect-error maps use WpDtoMapFieldOptions; the 8th argument is only a WpMcpHeader
    'string',
);

abstract class InvalidMcpContract {
    @WpMcpTool({
        name: 'invalid',
        description: 'This declaration must never compile.',
        // @ts-expect-error side-effect claims belong on @Endpoint.operation, never @WpMcpTool
        readOnlyHint: true,
        openWorldHint: false,
    })
    invalid(_request: object): Promise<object> {
        throw new Error('contract only');
    }
}

abstract class InvalidMcpArities {
    // @ts-expect-error MCP tools require exactly one request DTO
    @WpMcpTool({
        name: 'zero-arity',
        description: 'This declaration must never compile.',
        openWorldHint: false,
    })
    zero(): Promise<object> {
        throw new Error('contract only');
    }

    // @ts-expect-error MCP tools require exactly one request DTO
    @WpMcpTool({
        name: 'multi-arity',
        description: 'This declaration must never compile.',
        openWorldHint: false,
    })
    multi(_first: object, _second: object): Promise<object> {
        throw new Error('contract only');
    }
}

void InvalidMcpContract;
void InvalidMcpArities;
void invalidEmptyEnum;
void invalidMapValue;
void missingMapValue;
void noEighthFieldArgument;
