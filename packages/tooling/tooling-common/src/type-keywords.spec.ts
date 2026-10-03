import { describe, expect, it } from 'vitest';
import { TypeKeywords, TypeKeywordSite } from './type-keywords';

describe('TypeKeywords syntax-only detector', () => {
    const detector = new TypeKeywords();

    it.each([
        ['type Payload = any;', ['any']],
        ['type Payload = unknown;', ['unknown']],
        ['type Payload = CustomBox<Map<string, unknown[] | any>>;', ['unknown', 'any']],
        ['const result = input as unknown as ActualDto;', ['unknown']],
        ['interface Contract { payload: [any, unknown]; load(input: unknown): Promise<any>; }', ['any', 'unknown', 'unknown', 'any']],
        ['const data = <any>input;', ['any']],
        ['type Payload = CustomBox<\n unknown\n>;', ['unknown']],
    ])('finds actual keyword types in %s', (source: string, keywords: string[]): void => {
        expect(detector.parse('contract.ts', source).map((site: TypeKeywordSite): string => site.keyword)).toEqual(keywords);
    });

    it('ignores strings, comments, identifiers, literal property names and concrete types', () => {
        const source = '// any unknown\nconst unknownValue = "any unknown";\ninterface ActualDto { unknown: string; any: number; }';
        expect(detector.parse('contract.ts', source)).toEqual([]);
    });

    it('preserves only the existing catch-variable exception, checking the catch body', () => {
        const source = 'try {} catch (err: unknown) { const value: unknown = err; const other: any = err; }';
        const sites = detector.parse('contract.ts', source);
        expect(sites.map((site: TypeKeywordSite): boolean => site.catchVariable)).toEqual([true, false, false]);
    });

    it('parses TSX and reports full-file line/column locations', () => {
        const sites = detector.parse('view.tsx', 'const view = <div title="unknown">any</div>;\ntype Data = unknown;');
        expect(sites).toHaveLength(1);
        expect(sites[0]).toMatchObject({ line: 2, column: 13, keyword: 'unknown' });
    });
});
