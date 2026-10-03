import { describe, expect, it } from 'vitest';
import { MethodLines, MethodLineSite } from './method-lines';

describe('shared method line detection', () => {
    it('counts physical lines including signatures, comments and blank lines', () => {
        const source = 'class Service {\nrun(\n input: ActualDto\n): void {\n // comment\n\n void input;\n}\n}';
        const sites = new MethodLines().parse('service.ts', source);
        expect(sites).toHaveLength(1);
        expect(sites[0]).toMatchObject({ name: 'run', line: 2, endLine: 8 });
        expect(sites[0].lines).toBe(7);
    });

    it('preserves existing build coverage for named functions, methods and variable arrow functions', () => {
        const source = 'function main(): void {}\nconst other = (): void => {};\nclass Service { run(): void {} }';
        expect(new MethodLines().parse('service.ts', source).map((site: MethodLineSite): string => site.name)).toEqual(['main', 'other', 'run']);
    });

    it('parses braces in strings/comments and TSX without counting them as method boundaries', () => {
        const source = 'function view() {\n const text = "}"; // {\n return <div>{text}</div>;\n}';
        const sites = new MethodLines().parse('view.tsx', source);
        expect(sites).toHaveLength(1);
        expect(sites[0].lines).toBe(4);
    });
});
