import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'node:path';
import * as ts from 'typescript';
import { ApiJsonSchema, ApiJsonSchemaValidator, McpToolCatalogFile } from '@webpieces/core-util';
import { ApiDocExtractor } from '../extract/ApiDocExtractor';
import { ApiDocModel, DocumentedField, DocumentedType } from '../model/ApiDocModel';
import { TypeRef } from '../model/TypeRef';
import { McpSchemaRenderer } from '../render/McpSchemaRenderer';
import { InheritanceFixturePaths } from './fixtures/inheritance/InheritanceFixturePaths';

/**
 * INHERITED FIELDS and READONLY ARRAYS (#1055), read from `fixtures/inheritance/` through the real
 * extractor and the real MCP renderer.
 *
 * Before #1055 a DTO's document held its OWN members only. The schema is closed
 * (`additionalProperties: false`), so every real call to a tool whose request `extends` a base was
 * refused at dispatch with `$.language is not allowed`. The fixture covers every place a base can
 * live: another file, another package read as SOURCE through tsconfig paths, and a PUBLISHED
 * package read from its `.d.ts` (the ctoteachings/monorepo `MySettingsResponse extends
 * OfflineSettingsDto` case).
 */
const FIXTURES = path.join(__dirname, 'fixtures', 'inheritance');
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
    paths: {
        '@webpieces/core-util': [path.join(CORE_UTIL, 'src', 'index.ts')],
        ...InheritanceFixturePaths.paths(),
    },
};

class Fixture {
    model!: ApiDocModel;
    catalog!: McpToolCatalogFile;

    load(): void {
        this.model = new ApiDocExtractor().extractFile(
            path.join(FIXTURES, 'InheritanceApi.ts'),
            COMPILER_OPTIONS,
        );
        const rendered = McpSchemaRenderer.catalogOf([this.model]);
        expect(rendered.skipped).toEqual([]);
        this.catalog = rendered.catalogs[0]!;
    }

    type(name: string): DocumentedType {
        const found = this.model.types.get(name);
        expect(found, `no model entry for ${name}`).toBeDefined();
        return found!;
    }

    fieldNames(typeName: string): string[] {
        return this.type(typeName).fields.map((f: DocumentedField) => f.name);
    }

    field(typeName: string, fieldName: string): DocumentedField {
        const found = this.type(typeName).fields.find((f: DocumentedField) => f.name === fieldName);
        expect(found, `no field ${typeName}.${fieldName}`).toBeDefined();
        return found!;
    }

    input(tool: string): ApiJsonSchema {
        return this.catalog.find(tool)!.inputSchema;
    }

    output(tool: string): ApiJsonSchema {
        return this.catalog.find(tool)!.outputSchema;
    }
}

const fixture = new Fixture();

describe('a DTO that extends a base', () => {
    beforeAll(() => fixture.load(), 60_000);

    it('records nothing as unmapped — every base resolved, including the published .d.ts', () => {
        expect(fixture.model.unmapped).toEqual([]);
    });

    it('FLATTENS a two-level chain, bases first, the override keeping its inherited position', () => {
        expect(fixture.fieldNames('LessonRenderRequest')).toEqual([
            'language', // RequestLanguageDto — another package, read as source
            'firstLanguage', // LessonScriptRequest — another file
            'lessonNumber',
            'voice', // declared by LessonScriptRequest, REDECLARED by LessonRenderRequest
            'regenerate', // LessonAudioRequest
            'formats', // LessonRenderRequest's own
            'labels',
        ]);
    });

    it('takes required/optional from the DECLARING type, so the redeclaration wins', () => {
        expect(fixture.field('LessonAudioRequest', 'voice').optional).toBe(true);
        expect(fixture.field('LessonRenderRequest', 'voice').optional).toBe(false);
        expect(fixture.field('LessonRenderRequest', 'voice').description).toBe(
            'The voice to render with — REQUIRED here, where the base left it optional.',
        );
        expect(fixture.field('LessonRenderRequest', 'regenerate').optional).toBe(true);
    });

    it("keeps a base field's JSDoc and its numeric decorators", () => {
        expect(fixture.field('LessonRenderRequest', 'language').description).toBe(
            'The language being taught.',
        );
        const lesson = fixture.field('LessonRenderRequest', 'lessonNumber');
        expect(lesson.description).toBe('Training lesson 1-2 or numbered lesson 1-100.');
        expect(lesson.type.integer).toBe(true);
        expect([lesson.min, lesson.max]).toEqual([1, 100]);
    });

    it('does not register a base as a model entry of its own — it is flattened, not $ref-ed', () => {
        expect(fixture.model.types.has('LessonScriptRequest')).toBe(false);
        expect(fixture.model.types.has('RequestLanguageDto')).toBe(false);
    });

    it('reads a base from a PUBLISHED .d.ts, JSDoc and optionality included', () => {
        expect(fixture.fieldNames('MySettingsResponse')).toEqual([
            'offlineEnabled',
            'maxOfflineLessons',
            'connectedAiProviders',
        ]);
        expect(fixture.field('MySettingsResponse', 'offlineEnabled').description).toBe(
            'Whether lessons are downloaded for offline use.',
        );
        expect(fixture.field('MySettingsResponse', 'maxOfflineLessons').optional).toBe(true);
    });

    it('flattens an interface extending TWO bases, and its redeclaration flips optional to required', () => {
        expect(fixture.fieldNames('LearnerLookupRequest')).toEqual([
            'learnerName',
            'age',
            'includeArchived',
        ]);
        expect(fixture.field('LearnerLookupRequest', 'age').optional).toBe(false);
        expect(fixture.field('LearnerLookupRequest', 'learnerName').description).toBe(
            "The learner's display name.",
        );
    });

    it('publishes the inherited fields and the right required list in the MCP tool schema', () => {
        const input = fixture.input('render_lesson');
        expect(Object.keys(input.properties ?? {})).toEqual([
            'language',
            'firstLanguage',
            'lessonNumber',
            'voice',
            'regenerate',
            'formats',
            'labels',
        ]);
        expect(input.required).toEqual([
            'language',
            'firstLanguage',
            'lessonNumber',
            'voice',
            'formats',
        ]);
        expect(input.additionalProperties).toBe(false);
        expect(input.allOf).toBeUndefined();
        expect(fixture.input('lookup_learner').required).toEqual(['learnerName', 'age']);
        expect(fixture.output('lookup_learner').required).toEqual([
            'language',
            'firstLanguage',
            'lessonNumber',
        ]);
    });

    it('FAILS THE BUILD when a base does not resolve, rather than publishing a closed subset', () => {
        const unresolved: ts.CompilerOptions = {
            ...COMPILER_OPTIONS,
            paths: { '@webpieces/core-util': [path.join(CORE_UTIL, 'src', 'index.ts')] },
        };
        expect(() =>
            new ApiDocExtractor().extractFile(path.join(FIXTURES, 'InheritanceApi.ts'), unresolved),
        ).toThrow(
            /cannot flatten the fields of '(OfflineSettingsDto|LearnerNamedDto|RequestLanguageDto)'/,
        );
    });

    it('ACCEPTS the call that used to be refused with `$.language is not allowed`', () => {
        const call = {
            language: 'es',
            firstLanguage: 'English',
            lessonNumber: 3,
            voice: 'narrator',
            formats: ['mp3'],
        };
        expect(new ApiJsonSchemaValidator().validate(fixture.input('render_lesson'), call)).toBe(
            undefined,
        );
    });
});

describe('a readonly array', () => {
    beforeAll(() => fixture.load(), 60_000);

    it('resolves `readonly X[]` exactly like `X[]`', () => {
        expect(fixture.field('LessonRenderRequest', 'formats').type).toEqual(
            TypeRef.array(TypeRef.primitiveOf('string')),
        );
    });

    it('resolves `ReadonlyArray<X>` exactly like `X[]`', () => {
        expect(fixture.field('LessonRenderRequest', 'labels').type).toEqual(
            TypeRef.array(TypeRef.primitiveOf('string')),
        );
    });

    it('resolves `readonly Alias[]` of a string union imported from a published package', () => {
        expect(fixture.field('MySettingsResponse', 'connectedAiProviders').type).toEqual(
            TypeRef.array(TypeRef.ref('AiProvider')),
        );
        expect(fixture.type('AiProvider').enumValues).toEqual(['claude', 'chatgpt']);
        const providers = fixture.output('render_lesson').properties?.['connectedAiProviders'];
        expect(providers?.type).toBe('array');
        expect(providers?.items?.enum).toEqual(['claude', 'chatgpt']);
    });
});
