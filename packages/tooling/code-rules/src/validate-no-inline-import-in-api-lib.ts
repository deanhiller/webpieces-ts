/**
 * `no-inline-import-in-api-lib` (#1023) — an API imports at the top of the file, only.
 *
 * In every `role:api-lib` project this refuses:
 *
 *   activeAiProvider?: import('@myorg/company-core').AiProvider;   // an import() TYPE node
 *   const mod = await import('./heavy');                             // a dynamic import() EXPRESSION
 *
 * and prints the replacement:
 *
 *   import { AiProvider } from '@myorg/company-core';
 *   activeAiProvider?: AiProvider;
 *
 * Why: an api library is the contract every client, server and document generator reads. An inline
 * `import()` hides a cross-library dependency inside a field's type, where no reader of the file's
 * imports — human, architecture graph or generator — sees it, and a dynamic import in a contract is
 * runtime behaviour in a file that should carry none.
 */

import { DiffScope, NoInlineImportInApiLibConfig, RULE_NAMES } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import * as ts from 'typescript';
import { ApiLibFile, ApiLibSite, ApiLibSourceRule } from './api-lib-source-rule';
import { ProjectRoleResolver } from './project-role-resolver';
import { ScanScope } from './scan-scope';

/** Finds every inline `import()` in one parsed file. */
export class InlineImportScanner {
    scan(file: ApiLibFile): ApiLibSite[] {
        const sites: ApiLibSite[] = [];
        const visit = (node: ts.Node): void => {
            if (ts.isImportTypeNode(node)) sites.push(this.typeSite(file, node));
            else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
                sites.push(this.expressionSite(file, node));
            }
            ts.forEachChild(node, visit);
        };
        visit(file.source);
        return sites;
    }

    /** `import('m').A.B` → `import { A } from 'm';` and `A.B` in its place. */
    private typeSite(file: ApiLibFile, node: ts.ImportTypeNode): ApiLibSite {
        const specifier = this.specifierOf(node);
        const qualifier = node.qualifier === undefined ? undefined : this.entityText(node.qualifier);
        const first = qualifier?.split('.')[0];
        const what = 'an import() TYPE — an API imports at the top of the file, only';
        if (first === undefined) {
            return file.site(node, what,
                `add \`import * as ${this.namespaceFor(specifier)} from '${specifier}';\` at the top of the file and ` +
                    `write \`${node.isTypeOf ? 'typeof ' : ''}${this.namespaceFor(specifier)}\` here.`);
        }
        return file.site(node, what,
            `add \`import { ${first} } from '${specifier}';\` at the top of the file and write ` +
                `\`${node.isTypeOf ? 'typeof ' : ''}${qualifier}\` here instead of \`${node.getText(file.source)}\`.`);
    }

    private expressionSite(file: ApiLibFile, node: ts.CallExpression): ApiLibSite {
        const argument = node.arguments[0];
        const specifier = argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : '<module>';
        return file.site(node, 'a dynamic import() EXPRESSION — an API loads nothing lazily; it imports at the top of the file, only',
            `replace it with a static \`import { … } from '${specifier}';\` at the top of the file, naming what is used.`);
    }

    private specifierOf(node: ts.ImportTypeNode): string {
        const argument = node.argument;
        if (ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal)) return argument.literal.text;
        return argument.getText();
    }

    private entityText(name: ts.EntityName): string {
        return ts.isIdentifier(name) ? name.text : `${this.entityText(name.left)}.${name.right.text}`;
    }

    /** A PascalCase namespace name for a module specifier: `@myorg/company-core` → `CompanyCore`. */
    private namespaceFor(specifier: string): string {
        const last = specifier.split('/').pop() ?? specifier;
        return last.split(/[^A-Za-z0-9]+/).filter((part: string) => part !== '')
            .map((part: string) => part[0]!.toUpperCase() + part.slice(1)).join('') || 'Module';
    }
}

@injectable(bindingScopeValues.Singleton)
export class NoInlineImportInApiLibValidator extends ApiLibSourceRule<NoInlineImportInApiLibConfig> {
    private readonly scanner = new InlineImportScanner();

    constructor(config: NoInlineImportInApiLibConfig, roleResolver: ProjectRoleResolver, diffScope: DiffScope, scanScope: ScanScope) {
        super(config, RULE_NAMES.NO_INLINE_IMPORT_IN_API_LIB, roleResolver, diffScope, scanScope);
    }

    protected sitesIn(file: ApiLibFile): ApiLibSite[] {
        return this.scanner.scan(file);
    }

    protected why(): string {
        return 'an API imports at the top of the file, only — an inline import() hides a cross-library dependency ' +
            'from every reader of the contract\'s imports, and a dynamic one is runtime behaviour in a contract.';
    }
}
