import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { DtoSchemaBuilder, WpDto, WpDtoField, WpDtoFieldOptions, WpResponseDto } from './DtoSchema';
import { getWpMcpTools, WpMcpTool } from './McpMetadata';

@WpDto()
class AddressDto {
    @WpDtoField(new WpDtoFieldOptions('Postal city', true))
    city!: string;
}

@WpDto()
class SearchRequest {
    @WpDtoField(
        new WpDtoFieldOptions(
            'Words to find',
            true,
            undefined,
            false,
            undefined,
            undefined,
            undefined,
            'query',
        ),
    )
    query!: string;

    @WpDtoField(new WpDtoFieldOptions('Maximum results', false, undefined, true, 1, 20))
    limit?: number;

    @WpDtoField(new WpDtoFieldOptions('Allowed categories', true, 'string'))
    categories!: string[];

    @WpDtoField(new WpDtoFieldOptions('Shipping address', true))
    address!: AddressDto;
}

@WpDto()
class SearchResponse {
    @WpDtoField(new WpDtoFieldOptions('Matched titles', true, 'string'))
    titles!: string[];
}

abstract class SearchApi {
    @WpMcpTool({
        name: 'search',
        description: 'Search the signed-in user account.',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
    })
    @WpResponseDto(() => SearchResponse)
    search(_request: SearchRequest): Promise<SearchResponse> {
        throw new Error('contract only');
    }
}

describe('DTO JSON Schema metadata', () => {
    const builder = new DtoSchemaBuilder();

    it('combines reflected DTO types with field documentation and constraints', () => {
        const requestClass = builder.requestClassOf(SearchApi, 'search');
        const schema = builder.build(requestClass);

        expect(schema).toMatchObject({
            type: 'object',
            additionalProperties: false,
            required: ['query', 'categories', 'address'],
            properties: {
                query: { type: 'string', description: 'Words to find', 'x-mcp-header': 'query' },
                limit: { type: 'integer', minimum: 1, maximum: 20 },
                categories: { type: 'array', items: { type: 'string' } },
                address: {
                    type: 'object',
                    required: ['city'],
                    properties: { city: { type: 'string', description: 'Postal city' } },
                },
            },
        });
        expect(builder.responseClassOf(SearchApi, 'search')).toBe(SearchResponse);
    });

    it('rejects unknown, missing, wrongly typed, and out-of-range values', () => {
        expect(builder.validate(SearchRequest, { query: 'x' })?.message).toContain('categories');
        expect(
            builder.validate(SearchRequest, {
                query: 'x',
                categories: [],
                address: { city: 'Kyiv' },
                forged: 'user-2',
            })?.message,
        ).toContain('forged');
        expect(
            builder.validate(SearchRequest, {
                query: 'x',
                limit: 30,
                categories: [],
                address: { city: 'Kyiv' },
            })?.message,
        ).toContain('<= 20');
    });

    it('keeps tool documentation separate from DTO field documentation', () => {
        expect(getWpMcpTools(SearchApi)).toEqual([
            expect.objectContaining({
                name: 'search',
                description: 'Search the signed-in user account.',
            }),
        ]);
    });

    it('fails startup rather than emitting misleading schemas for erased or contradictory facts', () => {
        @WpDto()
        class MissingArrayItems {
            @WpDtoField(new WpDtoFieldOptions('Values', true))
            values!: string[];
        }

        @WpDto()
        class ContradictoryField {
            @WpDtoField(new WpDtoFieldOptions('Name', true, undefined, true))
            name!: string;
        }

        expect(() => builder.build(MissingArrayItems)).toThrow(/must declare arrayItems/);
        expect(() => builder.build(ContradictoryField)).toThrow(
            /numeric constraints.*not a number/,
        );

        @WpDto()
        class InvalidMcpHeader {
            @WpDtoField(
                new WpDtoFieldOptions(
                    'Name',
                    true,
                    undefined,
                    false,
                    undefined,
                    undefined,
                    undefined,
                    'bad header',
                ),
            )
            name!: string;
        }

        expect(() => builder.build(InvalidMcpHeader)).toThrow(/RFC 9110 token/);

        @WpDto()
        class DuplicateMcpHeader {
            @WpDtoField(
                new WpDtoFieldOptions(
                    'First',
                    true,
                    undefined,
                    false,
                    undefined,
                    undefined,
                    undefined,
                    'tenant',
                ),
            )
            first!: string;

            @WpDtoField(
                new WpDtoFieldOptions(
                    'Second',
                    true,
                    undefined,
                    false,
                    undefined,
                    undefined,
                    undefined,
                    'TENANT',
                ),
            )
            second!: string;
        }

        expect(() => builder.build(DuplicateMcpHeader)).toThrow(/duplicates.*case-insensitively/);
    });
});
