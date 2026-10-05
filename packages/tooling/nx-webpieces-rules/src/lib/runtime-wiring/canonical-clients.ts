import * as ts from 'typescript';

/** Replacement diagnostics used only by the canonical wiring-format analyzer. */
export class CanonicalClientBindings {
    constructor(private readonly checker: ts.TypeChecker) {}

    problems(file: ts.SourceFile): string[] {
        if (!/(?:^|\/)wiring\.ts$/.test(file.fileName)) return [];
        const problems: string[] = [];
        const visit = (node: ts.Node): void => {
            if (ts.isCallExpression(node) && this.method(node.expression) === 'toDynamicValue') {
                const bind = this.expand(node.expression);
                const receiver =
                    ts.isPropertyAccessExpression(bind) || ts.isElementAccessExpression(bind)
                        ? this.expand(bind.expression)
                        : undefined;
                if (
                    receiver !== undefined &&
                    ts.isCallExpression(receiver) &&
                    this.method(receiver.expression) === 'bind' &&
                    this.singleton(node)
                ) {
                    this.checkFactory(
                        node.arguments[0],
                        receiver.arguments[0],
                        false,
                        file,
                        problems,
                    );
                }
            }
            if (ts.isObjectLiteralExpression(node)) {
                const token = this.property(node, 'provide');
                const factory = this.property(node, 'useFactory');
                if (token !== undefined && factory !== undefined)
                    this.checkFactory(factory, token, true, file, problems);
            }
            ts.forEachChild(node, visit);
        };
        visit(file);
        return problems;
    }

    private checkFactory(
        factory: ts.Expression | undefined,
        token: ts.Expression | undefined,
        browser: boolean,
        file: ts.SourceFile,
        problems: string[],
    ): void {
        if (factory === undefined || token === undefined) return;
        const value = this.expand(factory);
        if (!ts.isArrowFunction(value) && !ts.isFunctionExpression(value)) return;
        const result =
            ts.isBlock(value.body) &&
            value.body.statements.length === 1 &&
            ts.isReturnStatement(value.body.statements[0])
                ? value.body.statements[0].expression
                : ts.isBlock(value.body)
                  ? undefined
                  : value.body;
        if (result === undefined) return; // Side effects/custom adapters have no helper equivalent.
        const call = this.expand(result);
        if (!ts.isCallExpression(call)) return;
        const declaration = this.checker.getResolvedSignature(call)?.declaration;
        const owner = declaration?.parent;
        if (owner === undefined || !ts.isClassDeclaration(owner)) return;
        const name = owner.name?.text;
        const method = this.method(call.expression);
        const rpc = name === 'ClientHttpFactory' && method === 'createRpcClient' && !browser;
        const task =
            name === 'ClientCloudTasksFactory' && method === 'createPubSubClient' && !browser;
        const provider =
            name === 'ClientHttpBrowserFactory' && method === 'createRpcClient' && browser;
        if (!rpc && !task && !provider) return;
        if (call.arguments.length < 2 || call.arguments.length > (rpc ? 3 : 2)) return;
        const config = this.expand(call.arguments[1]);
        if (
            !ts.isNewExpression(config) ||
            this.method(config.expression) !== (task ? 'TaskClientConfig' : 'ClientConfig') ||
            config.arguments?.length !== 1
        )
            return; // Custom config options aren't supported by helpers.
        const api = call.arguments[0].getText();
        const target = config.arguments[0].getText();
        const filters = call.arguments[2] === undefined ? '' : `, ${call.arguments[2].getText()}`;
        const replacement = task
            ? `new RuntimeTaskClients(options).bindPubSub(${token.getText()}, ${api}, ${target});`
            : provider
              ? `provideRpcClient(${token.getText()}, ${api}, ${target})`
              : `new RuntimeClients(options).bindRpc(${token.getText()}, ${api}, ${target}${filters});`;
        const location = file.getLineAndCharacterOfPosition(factory.getStart(file));
        problems.push(
            `${file.fileName}:${location.line + 1}:${location.character + 1}: canonical client registration required: ${replacement}`,
        );
    }

    private singleton(call: ts.CallExpression): boolean {
        let node: ts.Node = call;
        while (
            node.parent !== undefined &&
            (ts.isPropertyAccessExpression(node.parent) ||
                ts.isElementAccessExpression(node.parent) ||
                ts.isCallExpression(node.parent))
        ) {
            node = node.parent;
            if (ts.isCallExpression(node) && this.method(node.expression) === 'inSingletonScope')
                return true;
        }
        return false;
    }

    private property(node: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
        for (const property of node.properties) {
            if (
                ts.isPropertyAssignment(property) &&
                (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) &&
                property.name.text === name
            )
                return property.initializer;
            if (ts.isShorthandPropertyAssignment(property) && property.name.text === name)
                return property.name;
        }
        return undefined;
    }

    private method(expression: ts.Expression): string {
        const value = this.expand(expression);
        if (ts.isPropertyAccessExpression(value)) return value.name.text;
        if (ts.isElementAccessExpression(value) && ts.isStringLiteralLike(value.argumentExpression))
            return value.argumentExpression.text;
        const symbol = this.checker.getSymbolAtLocation(value);
        return symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0
            ? this.checker.getAliasedSymbol(symbol).getName()
            : (symbol?.getName() ?? value.getText());
    }

    private expand(expression: ts.Expression, seen: Set<ts.Node> = new Set()): ts.Expression {
        if (seen.has(expression)) return expression;
        seen.add(expression);
        if (
            ts.isParenthesizedExpression(expression) ||
            ts.isAsExpression(expression) ||
            ts.isNonNullExpression(expression) ||
            ts.isSatisfiesExpression(expression)
        )
            return this.expand(expression.expression, seen);
        const declaration = this.checker.getSymbolAtLocation(expression)?.valueDeclaration;
        if (
            declaration !== undefined &&
            ts.isVariableDeclaration(declaration) &&
            declaration.initializer !== undefined
        )
            return this.expand(declaration.initializer, seen);
        return expression;
    }
}
