import * as ts from 'typescript';
import { Option, RuleFailError } from '@webpieces/rules-config';
import { WiringSourceTypes, WiringKind } from './source-types';
import { CanonicalClientBindings } from './canonical-clients';

/** One canonical-file grammar. Symbol resolution may read imports; format checking never does. */
export class WiringFormat {
    private readonly types: WiringSourceTypes;

    constructor(private readonly checker: ts.TypeChecker, private readonly maxLines: number) {
        this.types = new WiringSourceTypes(checker);
    }

    problems(file: ts.SourceFile): string[] {
        if (!/(?:^|\/)wiring\.ts$/.test(file.fileName)) return [];
        const problems: string[] = new CanonicalClientBindings(this.checker).problems(file);
        const report = (node: ts.Node, message: string): void => {
            const at = file.getLineAndCharacterOfPosition(node.getStart(file));
            problems.push(`${file.fileName}:${at.line + 1}:${at.character + 1}: ${message}`);
        };
        if (file.text.trimEnd().split('\n').length > this.maxLines)
            report(file, `wiring.ts exceeds ${this.maxLines} lines; move implementations to imported named modules.`);
        for (const statement of file.statements) {
            if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) continue;
            if (!ts.isClassDeclaration(statement)) {
                report(statement, 'Only imports, exports and named declarative classes belong in wiring.ts.');
                continue;
            }
            const kind = this.types.kind(statement);
            if (kind === undefined) {
                report(statement, 'Implement the framework Wiring, AppWiring, BindingModule or RouteModule contract.');
                continue;
            }
            this.classProblems(statement, kind, report);
        }
        return problems;
    }

    assert(problems: readonly string[]): void {
        if (problems.length === 0) return;
        throw new RuleFailError('wiring-format', problems.join('\n'), undefined, undefined, [
            new Option('Use Wiring/AppWiring with literal named module selections. Move setup and business logic out of wiring.ts; keep named WiringPolicy conditions explicit.', true),
        ]);
    }

    private classProblems(
        declaration: ts.ClassDeclaration,
        kind: WiringKind,
        report: (node: ts.Node, message: string) => void,
    ): void {
        for (const member of declaration.members) {
            if (ts.isConstructorDeclaration(member)) {
                if (member.body !== undefined && member.body.statements.length > 0)
                    report(member, 'Use constructor parameter properties to store prepared inputs; no setup logic.');
                continue;
            }
            if (!ts.isMethodDeclaration(member)) {
                report(member, 'Store prepared inputs in constructor parameter properties.');
                continue;
            }
            const name = member.name.getText();
            if (['getBindingModules', 'getRoutingModules', 'getWirings'].includes(name)) {
                const expected = name === 'getWirings' ? 'wiring' : name === 'getBindingModules' ? 'binding' : 'routing';
                if (name === 'getWirings' && kind !== 'app')
                    report(member, 'Only AppWiring can declare getWirings; libraries cannot compose libraries.');
                this.arrayProblems(member, expected, report);
            } else if (name === 'configure' && ['binding', 'routing'].includes(kind)) {
                for (const statement of member.body?.statements ?? [])
                    this.configureProblems(statement, report);
            } else if (name !== 'getHeaders' || kind !== 'app')
                report(member, 'Keep only canonical selection getters and short configure declarations; getRuntimeWiring and helper methods were removed.');
        }
        if (kind === 'app' || kind === 'wiring') {
            const names = ['getBindingModules', 'getRoutingModules', ...(kind === 'app' ? ['getWirings'] : [])];
            for (const name of names) {
                const method = this.types.method(declaration, name);
                if (method === undefined) report(declaration, `Missing ${name} literal array getter.`);
            }
            if (kind === 'wiring' && this.types.method(declaration, 'getWirings') !== undefined)
                report(declaration, 'A library Wiring must not inherit getWirings.');
        }
    }

    private arrayProblems(
        method: ts.MethodDeclaration,
        expected: WiringKind,
        report: (node: ts.Node, message: string) => void,
    ): void {
        const statements = method.body?.statements;
        const returned = statements?.length === 1 && ts.isReturnStatement(statements[0]) ? statements[0].expression : undefined;
        if (returned === undefined || !ts.isArrayLiteralExpression(returned)) {
            report(method, 'Getter body must be exactly return [new NamedModule(preparedInputs)]; no delegation, spreads, helpers or conditions.');
            return;
        }
        for (const element of returned.elements) {
            if (!ts.isNewExpression(element) || this.types.kind(element.expression) !== expected)
                report(element, `Select a named framework ${expected} instance; nested arrays and AppWiring children are forbidden.`);
            else for (const argument of element.arguments ?? []) {
                if (!this.prepared(argument)) report(argument, 'Pass prepared inputs or a named WiringPolicy; no callbacks, topology wrappers or computed setup.');
            }
        }
    }

    private prepared(expression: ts.Expression): boolean {
        if (ts.isIdentifier(expression) || ts.isLiteralExpression(expression)) return true;
        if (ts.isPropertyAccessExpression(expression)) return this.prepared(expression.expression);
        if ([ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.ThisKeyword].includes(expression.kind)) return true;
        if (!ts.isNewExpression(expression)) return false;
        return this.types.isFramework(expression.expression, 'WiringPolicy');
    }

    private configureProblems(statement: ts.Statement, report: (node: ts.Node, message: string) => void): void {
        if (ts.isVariableStatement(statement)) {
            const declarations = statement.declarationList.declarations;
            const initializer = declarations.length === 1 ? declarations[0].initializer : undefined;
            if ((statement.declarationList.flags & ts.NodeFlags.Const) !== 0 && initializer !== undefined && ts.isNewExpression(initializer) &&
                ['RuntimeClients', 'RuntimeTaskClients'].some((name: string) => this.types.isFramework(initializer.expression, name)) &&
                (initializer.arguments ?? []).every((argument: ts.Expression) => this.prepared(argument))) return;
        }
        if (ts.isIfStatement(statement) && ts.isPropertyAccessExpression(statement.expression) && statement.expression.name.text === 'enabled' && this.types.isPolicy(statement.expression.expression) && statement.elseStatement === undefined) {
            const body = ts.isBlock(statement.thenStatement) ? statement.thenStatement.statements : [statement.thenStatement];
            for (const child of body) this.configureProblems(child, report);
            return;
        }
        const expression = ts.isExpressionStatement(statement) || ts.isReturnStatement(statement) ? statement.expression : undefined;
        if (expression === undefined || (!ts.isCallExpression(expression) && !ts.isNewExpression(expression))) {
            report(statement, 'configure contains only short binding, route, external-contract or module-load declarations and named policy conditions.');
            return;
        }
        const text = expression.getText();
        if (!this.declarationCall(expression) || /(?:=>|\bfunction\b|\brpcTarget\b|\bContainerModule\b)/.test(text))
            report(expression, 'Use recognized declarative registration calls; move custom setup and factories into imported implementations.');
    }

    private declarationCall(expression: ts.CallExpression | ts.NewExpression): boolean {
        if (ts.isNewExpression(expression)) {
            return this.types.isFramework(expression.expression, 'ExternalContractUse');
        }
        if (!ts.isPropertyAccessExpression(expression.expression)) return false;
        const receiver = expression.expression.expression;
        if (ts.isCallExpression(receiver)) return this.declarationCall(receiver);
        if (!['bind', 'bindRpc', 'bindPubSub', 'add', 'addRoutes', 'addFilter', 'load'].includes(expression.expression.name.text)) return false;
        const declaration = this.checker.getResolvedSignature(expression)?.declaration;
        if (declaration === undefined) return false;
        const file = declaration.getSourceFile().fileName.replace(/\\/g, '/');
        return /(?:\/packages\/(?:http|cloud)\/|\/node_modules\/@webpieces\/)(?:http-routing|http-client-node|http-client-browser|cloudtasks-client)\//.test(file) ||
            /\/node_modules\/(?:@inversifyjs\/|inversify\/)/.test(file);
    }
}
