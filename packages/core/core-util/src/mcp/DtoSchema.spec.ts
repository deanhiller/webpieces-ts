import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
    ApiJsonSchema,
    DtoSchemaBuilder,
    WpDto,
    WpDtoField,
    WpDtoFieldOptions,
    WpDtoMapFieldOptions,
    WpResponseDto,
} from './DtoSchema';
import { getWpMcpTools, WpMcpTool } from './McpMetadata';

@WpDto()
class AddressDto {
    @WpDtoField(new WpDtoFieldOptions('Postal city', true))
    city!: string;
}

@WpDto()
class SearchRequest {
    @WpDtoField(new WpDtoFieldOptions('Words to find', true))
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
                query: { type: 'string', description: 'Words to find' },
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
        expect(() => builder.build(ContradictoryField)).toThrow(/numeric constraints.*not a number/);
    });

    describe('typed maps', () => {
        @WpDto()
        class SentenceItem {
            @WpDtoField(new WpDtoFieldOptions('Sentence text', true))
            text!: string;
        }

        @WpDto()
        class PassageDto {
            @WpDtoField(new WpDtoMapFieldOptions('ISO 639-1 -> sentence', false, 'string'))
            translations?: Record<string, string>;

            @WpDtoField(new WpDtoMapFieldOptions('Sentences by locale', true, SentenceItem))
            sentencesByLocale!: Record<string, SentenceItem>;

            @WpDtoField(new WpDtoMapFieldOptions('Word counts by locale', false, 'integer'))
            counts?: Record<string, number>;
        }

        it('emits additionalProperties as the value schema, recursing into DTO values', () => {
            const schema = builder.build(PassageDto);
            expect(schema.additionalProperties).toBe(false);
            expect(schema.required).toEqual(['sentencesByLocale']);
            expect(schema.properties).toEqual({
                translations: {
                    type: 'object',
                    description: 'ISO 639-1 -> sentence',
                    additionalProperties: { type: 'string' },
                },
                sentencesByLocale: {
                    type: 'object',
                    description: 'Sentences by locale',
                    additionalProperties: {
                        type: 'object',
                        properties: { text: { type: 'string', description: 'Sentence text' } },
                        additionalProperties: false,
                        required: ['text'],
                    },
                },
                counts: {
                    type: 'object',
                    description: 'Word counts by locale',
                    additionalProperties: { type: 'integer' },
                },
            });
        });

        it('accepts well-typed maps, including empty ones', () => {
            expect(
                builder.validate(PassageDto, {
                    translations: { es: 'hola', fr: 'bonjour' },
                    sentencesByLocale: { es: { text: 'hola' } },
                    counts: { es: 3 },
                }),
            ).toBeUndefined();
            expect(builder.validate(PassageDto, { sentencesByLocale: {} })).toBeUndefined();
        });

        it('rejects wrongly typed map values with a keyed path', () => {
            const base = { sentencesByLocale: {} };
            expect(builder.validate(PassageDto, { ...base, translations: { es: 3 } })?.message).toBe(
                '$.translations.es must be string',
            );
            expect(builder.validate(PassageDto, { ...base, counts: { es: 1.5 } })?.message).toBe(
                '$.counts.es must be integer',
            );
            expect(
                builder.validate(PassageDto, { sentencesByLocale: { es: { text: 'x', extra: 1 } } })?.message,
            ).toBe('$.sentencesByLocale.es.extra is not allowed');
            expect(builder.validate(PassageDto, { sentencesByLocale: { es: 'x' } })?.message).toBe(
                '$.sentencesByLocale.es must be an object',
            );
            expect(builder.validate(PassageDto, {})?.message).toBe('$.sentencesByLocale is required');
        });

        it('rejects map values that are not plain objects', () => {
            expect(builder.validate(PassageDto, { sentencesByLocale: [] })?.message).toBe(
                '$.sentencesByLocale must be an object map',
            );
            expect(builder.validate(PassageDto, { sentencesByLocale: null })?.message).toBe(
                '$.sentencesByLocale must be an object map',
            );
            expect(builder.validate(PassageDto, { sentencesByLocale: 'x' })?.message).toBe(
                '$.sentencesByLocale must be an object map',
            );
            expect(builder.validate(PassageDto, { sentencesByLocale: new Map() })?.message).toBe(
                '$.sentencesByLocale must be a plain object map',
            );
        });

        it('still applies the recursion guard to DTO map values', () => {
            @WpDto()
            class TreeNode {
                @WpDtoField(new WpDtoMapFieldOptions('Children by name', true, TreeNode))
                children!: Record<string, TreeNode>;
            }
            expect(() => builder.build(TreeNode)).toThrow('Recursive DTO TreeNode cannot use an inline MCP schema.');
        });

        it('rejects map options on a field that is not a map', () => {
            @WpDto()
            class NotAMap {
                @WpDtoField(new WpDtoMapFieldOptions('Name', true, 'string'))
                name!: string;
            }
            expect(() => builder.build(NotAMap)).toThrow(
                'NotAMap.name declares mapValues but is not a map (Record<string, V>).',
            );
        });

        it('explains that an Object-typed field needs map options or a real DTO class', () => {
            interface Shape {
                name: string;
            }
            @WpDto()
            class InterfaceField {
                @WpDtoField(new WpDtoFieldOptions('Some shape', true))
                shape!: Shape;
            }
            @WpDto()
            class UndeclaredMap {
                @WpDtoField(new WpDtoFieldOptions('Some map', true))
                values!: Record<string, string>;
            }
            expect(() => builder.build(InterfaceField)).toThrow(
                'InterfaceField.shape has type Object: an interface or Record can never be a @WpDto. ' +
                    'For a map, use WpDtoMapFieldOptions.',
            );
            expect(() => builder.build(UndeclaredMap)).toThrow(
                'UndeclaredMap.values has type Object: an interface or Record can never be a @WpDto. ' +
                    'For a map, use WpDtoMapFieldOptions.',
            );
        });
    });

    describe('ApiJsonSchema.isClosedSchema', () => {
        it('accepts a closed object and a typed map', () => {
            const closed = new ApiJsonSchema('object');
            closed.additionalProperties = false;
            const typedMap = new ApiJsonSchema('object');
            typedMap.additionalProperties = new ApiJsonSchema('string');
            expect(ApiJsonSchema.isClosedSchema(closed)).toBe(true);
            expect(ApiJsonSchema.isClosedSchema(typedMap)).toBe(true);
            expect(ApiJsonSchema.isClosedSchema(builder.build(SearchRequest))).toBe(true);
        });

        it('rejects a schema with no closure and an explicitly open object', () => {
            const open = new ApiJsonSchema('object');
            open.additionalProperties = true;
            expect(ApiJsonSchema.isClosedSchema(new ApiJsonSchema())).toBe(false);
            expect(ApiJsonSchema.isClosedSchema(new ApiJsonSchema('object'))).toBe(false);
            expect(ApiJsonSchema.isClosedSchema(open)).toBe(false);
        });
    });
});
