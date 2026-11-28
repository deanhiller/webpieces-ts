import * as ts from 'typescript';
import { WpMcpTool } from '@webpieces/core-util';
import { DocumentedMcpTool } from '../model/ApiDocModel';
import { ApiDocExtractionError } from './ApiDocExtractionError';
import { ConstantFolder } from './ConstantFolder';
import { CanonicalDecorator } from './CanonicalDecorator';
import { McpProfiles } from './McpProfiles';
import { SourceLocation } from './SourceLocation';

/** Every authored identity on one method, independent of TypeScript's decorator execution order. */
export class McpIdentities {
    read(member: ts.Node, folder: ConstantFolder): readonly DocumentedMcpTool[] {
        const tools: DocumentedMcpTool[] = [];
        const decorators = ts.canHaveDecorators(member) ? (ts.getDecorators(member) ?? []) : [];
        for (const decorator of decorators) {
            const call = decorator.expression;
            if (!ts.isCallExpression(call)) continue;
            if (CanonicalDecorator.nameOf(call.expression) !== WpMcpTool.name) continue;
            const argument = call.arguments[0];
            const identity = new DocumentedMcpTool(
                argument === undefined ? '' : (folder.tryFoldString(argument) ?? ''),
                new McpProfiles().read(call.arguments[1], folder),
            );
            if (tools.some((tool: DocumentedMcpTool) => tool.name === identity.name)) {
                throw new ApiDocExtractionError(
                    `Duplicate @WpMcpTool name '${identity.name}' on one method`,
                    SourceLocation.of(member),
                    'Declare each identity once, with all its profiles in one profiles array.',
                );
            }
            tools.push(identity);
        }
        return tools.sort((a: DocumentedMcpTool, b: DocumentedMcpTool) =>
            a.name.localeCompare(b.name),
        );
    }
}
