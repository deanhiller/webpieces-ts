import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'node:path';
import * as ts from 'typescript';
import { ApiJsonSchema, McpToolCatalogFile, McpToolDefinition } from '@webpieces/core-util';
import { ApiDocExtractor } from '../extract/ApiDocExtractor';
import { McpSchemaRenderer } from '../render/McpSchemaRenderer';
import { OperationIds, OperationIdStyle } from '../model/OperationIds';
import { ApiDocModel, DocumentedField, DocumentedType } from '../model/ApiDocModel';
import { TypeRef } from '../model/TypeRef';

const CORE_UTIL = path.resolve(__dirname, '..', '..', '..', '..', 'core', 'core-util');
const COMPILER_OPTIONS: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    baseUrl: CORE_UTIL,
    paths: { '@webpieces/core-util': [path.join(CORE_UTIL, 'src', 'index.ts')] },
};

const OPEN_JSON_TYPES = ['string', 'number', 'boolean', 'object', 'array', 'null'];

/**
 * `JsonValueDto` — the explicit recursive JSON marker (#1447), from SOURCE through the model to the
 * generated MCP catalog. Recognised on the DECLARATION (an import alias is still the marker), and only
 * for a TYPE ALIAS: a class that merely shares the name stays the named DTO it is.
 */
describe('the JsonValueDto marker', () => {
    let model: ApiDocModel;
    let catalog: McpToolCatalogFile;

    beforeAll(() => {
        const fixture = path.join(__dirname, 'fixtures', 'JsonMarkerApi.ts');
        model = new ApiDocExtractor().extractFile(fixture, COMPILER_OPTIONS);
        const rendered = McpSchemaRenderer.catalogOf(
            [model],
            new OperationIds(OperationIdStyle.CONTRACT_METHOD),
        );
        expect(rendered.skipped).toEqual([]);
        catalog = rendered.catalogs[0]!;
    }, 60_000);

    function field(typeName: string, name: string): DocumentedField {
        const type = model.types.get(typeName) as DocumentedType;
        return type.fields.find((f: DocumentedField) => f.name === name)!;
    }

    function inputProperty(name: string): ApiJsonSchema {
        const tool = catalog.tools.find((each: McpToolDefinition) => each.name === 'json_save')!;
        return tool.inputSchema.properties![name]!;
    }

    it('resolves the marker, even under an import alias, to the json primitive', () => {
        expect(field('SaveJsonRequest', 'data').type).toEqual(TypeRef.primitiveOf('json'));
        expect(field('SaveJsonResponse', 'echoed').type).toEqual(
            TypeRef.array(TypeRef.primitiveOf('json')),
        );
        expect(model.types.has('SettingsJson')).toBe(false);
    });

    it('keeps a CLASS named JsonValueDto an ordinary, closed DTO', () => {
        expect(field('SaveJsonRequest', 'lookalike').type.kind).toBe('ref');
        const lookalike = inputProperty('lookalike');
        expect(lookalike.type).toBe('object');
        expect(Object.keys(lookalike.properties ?? {})).toEqual(['label']);
    });

    it('renders the open JSON schema, with null listed once on a nullable field', () => {
        expect(inputProperty('data').type).toEqual(OPEN_JSON_TYPES);
        expect(inputProperty('data').additionalProperties).toBe(true);
        expect(inputProperty('maybe').type).toEqual(OPEN_JSON_TYPES);
        expect(inputProperty('maybe').additionalProperties).toBe(true);
    });
});
