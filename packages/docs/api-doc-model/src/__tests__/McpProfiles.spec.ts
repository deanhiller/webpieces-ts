import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { McpProfiles } from '../extract/McpProfiles';
import { ConstantFolder } from '../extract/ConstantFolder';
import { ApiDocExtractionError } from '../extract/ApiDocExtractionError';

class ProfileExpression {
    static read(text: string): readonly string[] {
        const source = ts.createSourceFile(
            'profile.ts',
            `const options = ${text};`,
            ts.ScriptTarget.Latest,
            true,
        );
        const statement = source.statements[0] as ts.VariableStatement;
        const expression = statement.declarationList.declarations[0].initializer!;
        return new McpProfiles().read(
            expression,
            new ConstantFolder(ts.createProgram([], {}).getTypeChecker()),
        );
    }
}

describe('profile authoring extraction', () => {
    it('extracts explicit and omitted groups without broadening either', () => {
        expect(ProfileExpression.read('{}')).toEqual(['default']);
        expect(ProfileExpression.read("{ profiles: ['admin', 'course-authoring'] }")).toEqual([
            'admin',
            'course-authoring',
        ]);
    });
    it.each([
        '{ profiles: [] }',
        "{ profiles: ['admin', 'admin'] }",
        "{ profiles: [''] }",
        "{ profiles: ['a/b'] }",
        '{ profiles: undefined }',
        '{ profiles: [42] }',
        "{ roles: ['admin'] }",
        'null',
        '[]',
        '{ ...other }',
        "{ profiles: ['admin'], profiles: ['default'] }",
    ])('refuses malformed membership %s', (text: string) => {
        expect(() => ProfileExpression.read(text)).toThrow(ApiDocExtractionError);
    });
    it('names where the title went when the retired title argument sits in the options slot (#1296)', () => {
        const read = (): readonly string[] => ProfileExpression.read("'Get your passages'");
        expect(read).toThrow(ApiDocExtractionError);
        expect(read).toThrow(/@WpMcpTool takes no title argument/);
        expect(read).toThrow(expect.objectContaining({ cure: expect.stringContaining('`@summary` line') }));
    });
});
