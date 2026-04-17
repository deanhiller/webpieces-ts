/**
 * ESLint rule: require-typed-template
 *
 * Enforces that every <ng-template> with let- variables also has [templateClassType]
 * to preserve type safety via TypedTemplateOutletDirective.
 *
 * Works with @angular-eslint/template-parser AST where:
 *   - ng-template variables (let-xxx) appear in node.variables[]
 *   - bound inputs ([templateClassType]) appear in node.inputs[]
 *   - static attributes appear in node.attributes[]
 *
 * NOTE: This rule only works when files are parsed with @angular-eslint/template-parser.
 * It is intended for Angular HTML template files (**.html).
 */

import type { Rule } from 'eslint';

// webpieces-disable no-any-unknown -- Angular template AST node interfaces
// These interfaces represent the Template node shape from @angular-eslint/template-parser.
// We define them inline since the parser is not a dependency of this plugin.
interface AngularTemplateNode {
    tagName?: string;
    variables?: Array<{ name: string }>;
    inputs?: Array<{ name: string }>;
    attributes?: Array<{ name: string }>;
    // webpieces-disable no-any-unknown -- ESTree AST index signature
    [key: string]: any;
}

const rule: Rule.RuleModule = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Require [templateClassType] on ng-template elements that use let- variables',
        },
        messages: {
            missingTypedTemplate:
                'ng-template with let- variables must include ' +
                '[templateClassType]="YourDtoClass" to preserve type safety. ' +
                'Fix: (1) Add [templateClassType]="YourDtoClass" to this ng-template, ' +
                '(2) Add TypedTemplateOutletDirective to component imports array, ' +
                '(3) Expose the DTO class: protected readonly YourDtoClass = YourDtoClass. ' +
                'See @fuse/directives/typed-template-outlet/.',
        },
        schema: [],
    },
    create(context: Rule.RuleContext): Rule.RuleListener {
        return {
            Template(node: AngularTemplateNode): void {
                // Only match explicit <ng-template>, not desugared structural directives
                // (*ngFor, *ngIf, etc.) which also produce Template AST nodes
                if (node.tagName !== 'ng-template') {
                    return;
                }

                const hasLetVariables = node.variables && node.variables.length > 0;
                if (!hasLetVariables) {
                    return;
                }

                const hasTemplateClassType =
                    (node.inputs &&
                        node.inputs.some((input) => input.name === 'templateClassType')) ||
                    (node.attributes &&
                        node.attributes.some((attr) => attr.name === 'templateClassType'));

                if (!hasTemplateClassType) {
                    context.report({
                        // webpieces-disable no-any-unknown -- ESTree AST cast for ESLint report
                        node: node as unknown as Rule.Node,
                        messageId: 'missingTypedTemplate',
                    });
                }
            },
        };
    },
};

export = rule;
