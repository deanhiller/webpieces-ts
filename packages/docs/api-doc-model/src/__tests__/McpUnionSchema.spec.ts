import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'node:path';
import * as ts from 'typescript';
import { toError } from '@webpieces/core-util';
import { ApiDocExtractor } from '../extract/ApiDocExtractor';
import {
    ApiDocModel,
    DocumentedEndpoint,
    DocumentedEndpointOptions,
    DocumentedField,
    DocumentedMcpTool,
    DocumentedType,
} from '../model/ApiDocModel';
import { TypeRef } from '../model/TypeRef';
import { McpRenderError } from '../render/McpRenderError';
import { McpSchemaRenderer, McpCatalogRender, SkippedMcpTool } from '../render/McpSchemaRenderer';

/**
 * UNIONS in an MCP tool schema (#1009), in both directions.
 *
 * `ApiJsonSchema` had no `oneOf`, and that — not the protocol — is why every contract carrying a
 * discriminated union was left out of `tools/list`. MCP tool schemas are JSON Schema 2020-12, the
 * same dialect the OpenAPI document beside them already publishes the union in.
 *
 * The two directions are not symmetric, and the asymmetry is the whole point:
 *
 *  - NESTED, inside a property: legal, and now rendered with its DERIVED discriminator.
 *  - at the ROOT of a tool's parameters: REFUSED. Both the OpenAI and the Anthropic
 *    function-calling APIs reject a top-level `oneOf`/`anyOf`/`allOf`, and a server sends its whole
 *    tool list on every request — so one offending tool 400s EVERY request and bricks the session,
 *    not just that tool.
 */
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

describe('a union in an MCP tool schema', () => {
    let rendered: McpCatalogRender;

    beforeAll(() => {
        const fixture = path.join(__dirname, 'fixtures', 'McpUnionApi.ts');
        rendered = McpSchemaRenderer.catalogOf([
            new ApiDocExtractor().extractFile(fixture, COMPILER_OPTIONS),
        ]);
    }, 60_000);

    it('renders a NESTED discriminated union as oneOf plus its derived discriminator', () => {
        const window = rendered.catalogs[0]!.find('fetch_delivery')!.outputSchema.properties!['window'];

        expect(window.oneOf?.length).toBe(2);
        expect(window.discriminator?.propertyName).toBe('kind');
        expect(window.discriminator?.mapping).toEqual({
            scheduled: 'ScheduledWindow',
            asap: 'AsapWindow',
        });
        // Each branch is INLINE and complete — a tool schema has no `$ref` to point at.
        expect(window.oneOf![0].properties!['from'].type).toBe('string');
        expect(window.oneOf![1].properties!['estimateMinutes'].type).toBe('number');
        // The FIELD's sentence wins over the union alias's, as it does for a nested DTO.
        expect(window.description).toContain('When it is meant to arrive.');
    });

    it('REFUSES a tool whose request is itself a union, naming the tool and the cure', () => {
        expect(rendered.catalogs[0]!.find('move_window')).toBe(undefined);
        const refusal = rendered.skipped.find(
            (skipped: SkippedMcpTool) => skipped.name === 'move_window',
        );

        expect(refusal?.contractName).toBe('McpUnionApi');
        expect(refusal?.reason).toContain("an MCP tool's request is itself a union");
        expect(refusal?.reason).toContain('McpUnionApi.moveWindow');
        // The CURE travels on the error's own field, which `SkippedMcpTool` does not copy — assert
        // it where it is actually written, so the sentence an author reads is pinned.
        expect(rootUnionCure()).toContain('Wrap it in a property of an object request');
        expect(rootUnionCure()).toContain('400s every request in the session');
    });

    /**
     * A union TypeScript itself cannot narrow — no property is one string literal on every branch.
     * It publishes as a BARE `oneOf`: an invented discriminator would claim a narrowing the source
     * does not have. The extractor refuses to derive one at all (it records the type as unmapped),
     * so the renderer is measured directly against a model that carries the union without one.
     */
    it('publishes an un-narrowable union WITHOUT a discriminator rather than inventing one', () => {
        const schema = new McpSchemaRenderer(unnarrowableModel()).render()[0].outputSchema;
        const either = schema.properties!['either'];

        expect(either.oneOf?.length).toBe(2);
        expect(either.discriminator).toBe(undefined);
        expect(either.oneOf![0].properties!['left'].type).toBe('string');
    });
});

/** The `cure` field of the refusal, which is where the instruction to an author lives. */
// webpieces-disable no-function-outside-class -- spec helper, beside the one test that uses it
function rootUnionCure(): string {
    const fixture = path.join(__dirname, 'fixtures', 'McpUnionApi.ts');
    const model = new ApiDocExtractor().extractFile(fixture, COMPILER_OPTIONS);
    const moving = model.endpoints.find(
        (each: DocumentedEndpoint) => each.methodName === 'moveWindow',
    )!;
    // webpieces-disable no-unmanaged-exceptions -- the throw IS the measurement, and its `cure` field is the sentence an author reads
    try {
        new McpSchemaRenderer(model).tool(moving);
    } catch (err: unknown) {
        const error = toError(err);
        if (error instanceof McpRenderError) return error.cure;
        throw error;
    }
    throw new Error('the root-union request was not refused');
}

/** A model whose union carries NO discriminator, which the extractor will never build by itself. */
// webpieces-disable no-function-outside-class -- spec fixture builder, beside the one test that uses it
function unnarrowableModel(): ApiDocModel {
    const types = new Map<string, DocumentedType>();
    types.set('Left', objectType('Left', 'left'));
    types.set('Right', objectType('Right', 'right'));
    types.set(
        'Either',
        new DocumentedType(
            'Either',
            'One or the other.',
            [],
            [],
            ['Left', 'Right'],
            undefined,
            undefined,
        ),
    );
    types.set(
        'Answer',
        new DocumentedType(
            'Answer',
            'The answer.',
            [field('either', TypeRef.union(['Left', 'Right']))],
            [],
            [],
            undefined,
            undefined,
        ),
    );
    types.set('Ask', objectType('Ask', 'question'));
    return new ApiDocModel('EitherApi', ['mcp'], '/either', 'Either.', [endpoint()], types, []);
}

// webpieces-disable no-function-outside-class -- spec fixture builder
function objectType(name: string, fieldName: string): DocumentedType {
    return new DocumentedType(
        name,
        `A ${name}.`,
        [field(fieldName, TypeRef.primitiveOf('string'))],
        [],
        [],
        undefined,
        undefined,
    );
}

// webpieces-disable no-function-outside-class -- spec fixture builder
function field(name: string, type: TypeRef): DocumentedField {
    return new DocumentedField(
        name,
        type,
        false,
        false,
        `The ${name}.`,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        `spec-fixture.ts:1:1`,
    );
}

// webpieces-disable no-function-outside-class -- spec fixture builder
function endpoint(): DocumentedEndpoint {
    return new DocumentedEndpoint(
        'ask',
        'POST',
        '/ask',
        'read',
        'rpc',
        false,
        false,
        new DocumentedEndpointOptions(false, undefined, undefined),
        undefined,
        new DocumentedMcpTool('ask_either'),
        undefined,
        undefined,
        new Map<string, string>(),
        'Asks.',
        undefined,
        TypeRef.ref('Ask'),
        TypeRef.ref('Answer'),
    );
}
