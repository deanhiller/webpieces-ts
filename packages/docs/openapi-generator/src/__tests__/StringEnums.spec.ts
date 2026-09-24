import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OpenApiCli } from '../cli/OpenApiCli';

/**
 * STRING ENUMS and multi-value union DISCRIMINATORS in the OpenAPI document (#1023), through the
 * whole command (`OpenApiCli`) against a real fixture contract.
 *
 * The string enum is the ONE spelling of a fixed set of values in an API, so it publishes as a named
 * `enum` of its member VALUES everywhere a type appears; a discriminator whose value on one branch is
 * a union maps EVERY value to that branch, which OpenAPI's `mapping` allows.
 */
type Json = Record<string, unknown>;

class EnumsDocument {
    document: Json = {};

    load(): void {
        const fixtures = path.join(__dirname, 'fixtures');
        const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-openapi-enums-'));
        const result = new OpenApiCli().run(
            ['--manifest', path.join(fixtures, 'enums.manifest.json'), '--out', out, '--format', 'json'],
            fixtures,
        );
        const file = result.written.find(
            (each: string) => path.basename(each) === 'full-private-openapi.json',
        );
        expect(file, 'no private document written').toBeDefined();
        this.document = JSON.parse(fs.readFileSync(file!, 'utf8')) as Json;
    }

    schema(name: string): Json {
        const components = this.document['components'] as Json;
        const found = (components['schemas'] as Json)[name] as Json | undefined;
        expect(found, `no components.schemas.${name}`).toBeDefined();
        return found!;
    }

    property(schemaName: string, propertyName: string): Json {
        return (this.schema(schemaName)['properties'] as Json)[propertyName] as Json;
    }
}

const doc = new EnumsDocument();

describe('a string enum in the OpenAPI document', () => {
    beforeAll(() => doc.load(), 60_000);

    it('is a named schema whose enum is the member VALUES', () => {
        expect(doc.schema('SpeakerGender')).toEqual({
            type: 'string',
            description: 'Who is speaking.',
            enum: ['female', 'male'],
        });
    });

    it('is referenced from a field, an array element, a Record value, a nested DTO and the response', () => {
        const ref = { $ref: '#/components/schemas/SpeakerGender' };
        expect(doc.property('StoryRequest', 'gender')).toEqual(ref);
        expect(doc.property('StoryRequest', 'rotation')['items']).toEqual(ref);
        expect(doc.property('StoryRequest', 'byCharacter')['additionalProperties']).toEqual(ref);
        expect(doc.property('Speaker', 'gender')).toMatchObject(ref);
        expect(doc.property('StoryResponse', 'gender')).toEqual(ref);
    });

    it('renders ONE enum member used as a type as a one-value enum', () => {
        expect(doc.property('StoryRequest', 'only')).toEqual({ type: 'string', enum: ['fixed'] });
    });
});

describe('a discriminator whose value is a union on one branch', () => {
    beforeAll(() => doc.load(), 60_000);

    it('maps every enum-member value of the union branch to that branch', () => {
        expect(doc.schema('StoryVoiceChoice')['discriminator']).toEqual({
            propertyName: 'mode',
            mapping: {
                random: '#/components/schemas/RandomStoryVoice',
                randomWithChirp: '#/components/schemas/ChirpRandomVoice',
                randomChirpMale: '#/components/schemas/ChirpRandomVoice',
                fixed: '#/components/schemas/FixedStoryVoice',
            },
        });
        expect(doc.property('ChirpRandomVoice', 'mode')).toEqual({
            type: 'string',
            enum: ['randomWithChirp', 'randomChirpMale'],
        });
    });

    it('maps every literal of a literal-union branch to that branch', () => {
        expect(doc.schema('LiteralVoiceChoice')['discriminator']).toEqual({
            propertyName: 'kind',
            mapping: {
                randomFemale: '#/components/schemas/LiteralRandomVoice',
                randomMale: '#/components/schemas/LiteralRandomVoice',
                fixed: '#/components/schemas/LiteralFixedVoice',
            },
        });
    });
});
