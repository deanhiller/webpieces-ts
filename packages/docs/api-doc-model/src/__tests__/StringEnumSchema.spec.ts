import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'node:path';
import * as ts from 'typescript';
import { ApiJsonSchema, ApiJsonSchemaValidator } from '@webpieces/core-util';
import { ApiDocExtractor } from '../extract/ApiDocExtractor';
import { ApiDocModel, DocumentedField, DocumentedType, UnmappedType } from '../model/ApiDocModel';
import { TypeRef } from '../model/TypeRef';
import { McpCatalogRender, McpSchemaRenderer, SkippedMcpTool } from '../render/McpSchemaRenderer';

/**
 * STRING ENUMS and multi-value union DISCRIMINATORS (#1023), read from a real fixture contract
 * (`fixtures/McpEnumApi.ts`) through the real extractor and the real MCP renderer.
 *
 * The string enum (`export enum SpeakerGender { FEMALE = 'female', MALE = 'male' }`) is the ONE
 * spelling of a fixed set of values in an API, so it has to publish as an `enum` of its member VALUES
 * wherever a type can appear — and a discriminator written with enum members, or with a union of
 * literals on one branch, has to narrow exactly as TypeScript narrows it.
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

const GENDERS = ['female', 'male'];

class Fixture {
    model!: ApiDocModel;
    rendered!: McpCatalogRender;

    load(): void {
        const file = path.join(__dirname, 'fixtures', 'McpEnumApi.ts');
        this.model = new ApiDocExtractor().extractFile(file, COMPILER_OPTIONS);
        this.rendered = McpSchemaRenderer.catalogOf([this.model]);
    }

    type(name: string): DocumentedType {
        const found = this.model.types.get(name);
        expect(found, `no model entry for ${name}`).toBeDefined();
        return found!;
    }

    field(typeName: string, fieldName: string): DocumentedField {
        const found = this.type(typeName).fields.find((f: DocumentedField) => f.name === fieldName);
        expect(found, `no field ${typeName}.${fieldName}`).toBeDefined();
        return found!;
    }

    input(): ApiJsonSchema {
        return this.rendered.catalogs[0]!.find('write_story')!.inputSchema;
    }
}

const fixture = new Fixture();

describe('a string enum in the model', () => {
    beforeAll(() => fixture.load(), 60_000);

    it('is ONE named entry whose enum is the member VALUES, not the member names', () => {
        expect(fixture.type('SpeakerGender').enumValues).toEqual(GENDERS);
        expect(fixture.field('StoryRequest', 'gender').type).toEqual(TypeRef.ref('SpeakerGender'));
    });

    it('composes: an array element and a Record value both point at the enum', () => {
        expect(fixture.field('StoryRequest', 'rotation').type).toEqual(
            TypeRef.array(TypeRef.ref('SpeakerGender')),
        );
        expect(fixture.field('StoryRequest', 'byCharacter').type).toEqual(
            TypeRef.openMap(TypeRef.ref('SpeakerGender')),
        );
    });

    it('resolves ONE enum member as a type to that member value, and a union of members to their values', () => {
        expect(fixture.field('StoryRequest', 'only').type).toEqual(TypeRef.enumOf(['fixed']));
        expect(fixture.field('StoryRequest', 'someModes').type).toEqual(
            TypeRef.enumOf(['random', 'fixed']),
        );
    });

    it('records nothing unmapped for any of the enum spellings', () => {
        const enumRelated = fixture.model.unmapped.filter(
            (u: UnmappedType) => !u.typeText.includes('Overlap'),
        );
        expect(enumRelated).toEqual([]);
    });
});

describe('a discriminator whose value is a UNION on one branch', () => {
    beforeAll(() => fixture.load(), 60_000);

    it('maps EVERY enum-member value of a branch to that branch', () => {
        const choice = fixture.type('StoryVoiceChoice');
        expect(choice.discriminator?.propertyName).toBe('mode');
        expect(choice.discriminator?.branchValues.get('RandomStoryVoice')).toEqual(['random']);
        expect(choice.discriminator?.branchValues.get('ChirpRandomVoice')).toEqual([
            'randomWithChirp',
            'randomChirpFemale',
            'randomChirpMale',
        ]);
        expect(choice.discriminator?.branchValues.get('FixedStoryVoice')).toEqual(['fixed']);
    });

    it('maps every LITERAL of a literal-union branch too — the generator keeps supporting literals', () => {
        const choice = fixture.type('LiteralVoiceChoice');
        expect(choice.discriminator?.propertyName).toBe('kind');
        expect(choice.discriminator?.branchValues.get('LiteralRandomVoice')).toEqual([
            'randomFemale',
            'randomMale',
        ]);
        expect(choice.discriminator?.branchValues.get('LiteralFixedVoice')).toEqual(['fixed']);
    });

    it('INVENTS none when two branches claim the same value — TypeScript cannot narrow that', () => {
        expect(fixture.model.types.has('OverlappingChoice')).toBe(false);
        const recorded = fixture.model.unmapped.find((u: UnmappedType) => u.typeText.includes('OverlapA'));
        expect(recorded?.reason).toContain('discriminator');
        const skipped = fixture.rendered.skipped.find((s: SkippedMcpTool) => s.name === 'overlap_story');
        expect(skipped, 'the un-narrowable union was published').toBeDefined();
    });
});

describe('a string enum in an MCP tool schema', () => {
    beforeAll(() => fixture.load(), 60_000);

    it('renders the enum VALUES on a request field, an array element, a Record value and a nested DTO', () => {
        const properties = fixture.input().properties!;
        expect(properties['gender'].type).toBe('string');
        expect(properties['gender'].enum).toEqual(GENDERS);
        expect(properties['rotation'].items?.enum).toEqual(GENDERS);
        expect((properties['byCharacter'].additionalProperties as ApiJsonSchema).enum).toEqual(GENDERS);
        expect(properties['narrator'].properties!['gender'].enum).toEqual(GENDERS);
    });

    it('renders the enum VALUES on a response field', () => {
        const output = fixture.rendered.catalogs[0]!.find('write_story')!.outputSchema;
        expect(output.properties!['gender'].enum).toEqual(GENDERS);
    });

    it('publishes the discriminator mapping with several values pointing at one branch', () => {
        const voice = fixture.input().properties!['voice'];
        expect(voice.discriminator?.propertyName).toBe('mode');
        expect(voice.discriminator?.mapping).toEqual({
            random: 'RandomStoryVoice',
            randomWithChirp: 'ChirpRandomVoice',
            randomChirpFemale: 'ChirpRandomVoice',
            randomChirpMale: 'ChirpRandomVoice',
            fixed: 'FixedStoryVoice',
        });
        expect(voice.oneOf![1].properties!['mode'].enum).toEqual([
            'randomWithChirp',
            'randomChirpFemale',
            'randomChirpMale',
        ]);
    });

    it('validates a call against the rendered schema: every value of the union branch selects it', () => {
        const validator = new ApiJsonSchemaValidator();
        const schema = fixture.input();
        const base = {
            gender: 'female',
            rotation: ['male'],
            byCharacter: { ann: 'female' },
            narrator: { gender: 'male' },
            only: 'fixed',
            someModes: 'random',
        };
        expect(validator.validate(schema, { ...base, voice: { mode: 'randomChirpMale' } })).toBeUndefined();
        expect(validator.validate(schema, { ...base, voice: { mode: 'fixed', name: 'Ann' } })).toBeUndefined();
        expect(validator.validate(schema, { ...base, gender: 'FEMALE' })?.field).toBe('$.gender');
        expect(validator.validate(schema, { ...base, voice: { mode: 'nope' } })?.message).toContain(
            'randomChirpMale',
        );
    });
});
