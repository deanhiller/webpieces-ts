import * as ts from 'typescript';
import { Mcp } from '@webpieces/core-util';
import { ConstantFolder } from './ConstantFolder';
import { ApiDocExtractionError } from './ApiDocExtractionError';
import { SourceLocation } from './SourceLocation';

/** Reads authored membership without executing contract code or guessing runtime values. */
export class McpProfiles {
    read(argument: ts.Expression | undefined, folder: ConstantFolder): readonly string[] {
        if (argument === undefined) return [Mcp.DEFAULT];
        const options = folder.follow(argument);
        if (!ts.isObjectLiteralExpression(options)) return this.invalid(argument);
        let profiles: ts.Expression | undefined;
        for (const property of options.properties) {
            if (
                ts.isPropertyAssignment(property) &&
                property.name.getText().replace(/['"]/g, '') === 'profiles'
            ) {
                if (profiles !== undefined) return this.invalid(property);
                profiles = property.initializer;
            } else if (
                ts.isShorthandPropertyAssignment(property) &&
                property.name.text === 'profiles'
            ) {
                if (profiles !== undefined) return this.invalid(property);
                profiles = property.name;
            } else return this.invalid(property);
        }
        if (profiles === undefined) return [Mcp.DEFAULT];
        const list = folder.follow(profiles);
        if (!ts.isArrayLiteralExpression(list)) return this.invalid(profiles);
        const names = list.elements.map((entry: ts.Expression) =>
            folder.foldString(entry, 'MCP profile'),
        );
        return Mcp.profiles(
            names,
            '@WpMcpTool',
            (message: string) =>
                new ApiDocExtractionError(
                    message,
                    SourceLocation.of(argument),
                    'Use a non-empty array of unique profile identifiers matching [a-z][a-z0-9-]{0,63}; use Mcp.DEFAULT for the base group.',
                ),
        );
    }

    private invalid(node: ts.Node): never {
        throw new ApiDocExtractionError(
            'Malformed @WpMcpTool profile options',
            SourceLocation.of(node),
            "Write { profiles: [Mcp.DEFAULT, 'admin'] } with constant identifiers; omit options for only Mcp.DEFAULT.",
        );
    }
}
