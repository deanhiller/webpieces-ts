/**
 * ESLint rule: no-mat-cell-def
 *
 * Bans *matCellDef and *matHeaderCellDef in Angular HTML templates.
 * New files should use the div-grid table pattern instead of mat-table.
 *
 * Works with @angular-eslint/template-parser AST where structural directives
 * (*matCellDef) are desugared into Template nodes with templateAttrs[].
 *
 * NOTE: This rule only works when files are parsed with @angular-eslint/template-parser.
 * It is intended for Angular HTML template files (**.html).
 */

import type { Rule } from 'eslint';

// webpieces-disable no-any-unknown -- Angular template AST node interfaces
// These interfaces represent the Template node shape from @angular-eslint/template-parser.
// We define them inline since the parser is not a dependency of this plugin.
interface AngularTemplateNode {
    templateAttrs?: Array<{ name: string }>;
    // webpieces-disable no-any-unknown -- ESTree AST index signature
    [key: string]: any;
}

const BANNED_DIRECTIVES = ['matCellDef', 'matHeaderCellDef'];

const rule: Rule.RuleModule = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Ban *matCellDef and *matHeaderCellDef — use div-grid tables instead',
        },
        messages: {
            noMatCellDef:
                '*{{ directive }} is banned in new files. Use the div-grid table pattern instead. ' +
                'Div-grid tables are inherently type-safe with @for loops + strictTemplates.',
        },
        schema: [],
    },
    create(context: Rule.RuleContext): Rule.RuleListener {
        return {
            Template(node: AngularTemplateNode): void {
                // Structural directives (*matCellDef) are desugared into Template nodes.
                // The directive name appears in node.templateAttrs as either a
                // BoundAttribute or TextAttribute.
                const attrs = node.templateAttrs || [];
                for (const attr of attrs) {
                    if (BANNED_DIRECTIVES.includes(attr.name)) {
                        context.report({
                            // webpieces-disable no-any-unknown -- ESTree AST cast for ESLint report
                            node: node as unknown as Rule.Node,
                            messageId: 'noMatCellDef',
                            data: { directive: attr.name },
                        });
                    }
                }
            },
        };
    },
};

export = rule;
