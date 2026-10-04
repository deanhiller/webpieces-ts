import { describe, expect, it } from 'vitest';
import { RuntimeDeclarationCodec } from './codec';
import { RuntimeDeclaration, WiringExport } from './declaration';

describe('runtime declaration input validation', () => {
    const valid = new RuntimeDeclaration(
        'app',
        'node',
        { Plan: new WiringExport('plan', [], []) },
        'Plan',
        'app',
    );
    it('round trips a versioned declaration without adding volatile provenance', () => {
        expect(new RuntimeDeclarationCodec().decode(JSON.stringify(valid), 'app')).toEqual(valid);
    });
    it('rejects wrong versions, foreign owners, unknown fields, and malformed exports', () => {
        const codec = new RuntimeDeclarationCodec();
        expect(() => codec.decode(JSON.stringify({ ...valid, schemaVersion: 2 }), 'app')).toThrow(
            'schemaVersion',
        );
        expect(() => codec.decode(JSON.stringify(valid), 'other')).toThrow(
            'Expected project other',
        );
        expect(() =>
            codec.decode(JSON.stringify({ ...valid, credential: 'must-not-be-approved' }), 'app'),
        ).toThrow('Unknown runtime-deps field credential');
        expect(() =>
            codec.decode(
                JSON.stringify({
                    ...valid,
                    exports: { Plan: { kind: 'plan', relationships: {}, selections: [] } },
                }),
                'app',
            ),
        ).toThrow('JSON array');
    });
    it('rejects prototype-mutating dictionary keys', () => {
        expect(() =>
            new RuntimeDeclarationCodec().decode(
                '{"schemaVersion":1,"project":"app","framework":"node","exports":{"__proto__":{}}}',
                'app',
            ),
        ).toThrow('Reserved runtime-deps field');
    });
});
