import * as path from 'path';
import * as ts from 'typescript';
import { Option, RuleFailError } from '@webpieces/rules-config';
import type { ProjectInfo } from '../project-info';
import { ContractIdentity } from './declaration';
import type { DeclaredTarget } from './declaration';

/** Resolves imported symbols and bounded literal expressions without invoking application code. */
export class WiringSourceValues {
    constructor(
        private readonly workspaceRoot: string,
        private readonly infos: ReadonlyMap<string, ProjectInfo>,
        private readonly checker: ts.TypeChecker,
    ) {}

    symbolName(node: ts.Node): string {
        const symbol = this.symbol(node);
        const declaration = symbol?.declarations?.[0];
        if (
            declaration !== undefined &&
            ts.isVariableDeclaration(declaration) &&
            declaration.initializer !== undefined &&
            (ts.isPropertyAccessExpression(declaration.initializer) ||
                ts.isElementAccessExpression(declaration.initializer))
        )
            return this.symbolName(declaration.initializer);
        return symbol?.getName() ?? node.getText().split('.').pop()!;
    }

    identity(node: ts.Node): ContractIdentity {
        const symbol = this.symbol(node);
        const declaration = symbol?.declarations?.[0];
        if (declaration === undefined)
            this.fail(`Cannot resolve canonical identity for ${node.getText()}.`);
        const file = path.resolve(declaration!.getSourceFile().fileName);
        const owners = [...this.infos.values()].filter(
            (info) =>
                info.root !== '.' &&
                info.root !== '' &&
                file.startsWith(path.resolve(this.workspaceRoot, info.root) + path.sep),
        );
        owners.sort((left, right) => right.root.length - left.root.length);
        if (owners.length === 0)
            this.fail(
                `No workspace owner for ${node.getText()} at ${file}; configure source tsconfig paths.`,
            );
        return new ContractIdentity(owners[0].name, symbol!.getName());
    }

    target(expression: ts.Expression | undefined, depth: number = 0): DeclaredTarget {
        if (expression === undefined || depth > 20)
            this.fail('Missing or cyclic runtime target expression.');
        const value = expression!;
        if (ts.isStringLiteralLike(value)) return { kind: 'service', service: value.text };
        if (ts.isCallExpression(value) && this.symbolName(value.expression) === 'rpcTarget') {
            const target = this.target(value.arguments[1], depth + 1);
            if (target.kind !== 'service')
                this.fail('rpcTarget requires a literal deployment identity.');
            return { ...target, contract: this.identity(value.arguments[0]) };
        }
        if (
            ts.isNewExpression(value) &&
            ['RpcTarget', 'ClientConfig', 'TaskClientConfig'].includes(
                this.symbolName(value.expression),
            )
        )
            return this.target(
                value.arguments?.[this.symbolName(value.expression) === 'RpcTarget' ? 1 : 0],
                depth + 1,
            );
        const declaration = this.symbol(value)?.declarations?.[0];
        if (declaration !== undefined && ts.isVariableDeclaration(declaration))
            return this.target(declaration.initializer, depth + 1);
        if (declaration !== undefined && ts.isPropertyAssignment(declaration))
            return this.target(declaration.initializer, depth + 1);
        if (declaration !== undefined && ts.isParameter(declaration))
            return { kind: 'parameter', parameter: declaration.name.getText() };
        this.fail(
            `Unsupported target ${value.getText()}; use a literal service, rpcTarget, or an explicit typed target parameter.`,
        );
    }

    transport(expression: ts.Expression): 'rpc' | 'pubsub' {
        const declaration = this.symbol(expression)?.declarations?.[0];
        if (declaration === undefined || !ts.isClassDeclaration(declaration))
            this.fail(`API ${expression.getText()} must resolve to its source contract class.`);
        for (const decorator of ts.getDecorators(declaration as ts.ClassDeclaration) ?? []) {
            const expression = decorator.expression;
            const name = this.symbolName(
                ts.isCallExpression(expression) ? expression.expression : expression,
            );
            if (name === 'PubSub') return 'pubsub';
        }
        return 'rpc';
    }

    arguments(invocation: ts.NewExpression | ts.CallExpression): Record<string, DeclaredTarget> {
        const targets: Record<string, DeclaredTarget> = {};
        const signature = this.checker.getResolvedSignature(invocation);
        for (const [index, parameter] of (signature?.getParameters() ?? []).entries()) {
            const declaration = parameter.valueDeclaration;
            if (declaration === undefined) continue;
            const type = this.checker.typeToString(
                this.checker.getTypeOfSymbolAtLocation(parameter, declaration),
            );
            if (
                type.includes('RpcTarget') ||
                (type === 'string' && /target/i.test(parameter.getName()))
            ) {
                targets[parameter.getName()] = this.target(invocation.arguments?.[index]);
            }
        }
        return targets;
    }

    hasExternalConsumer(
        owner: string,
        project: string,
        exportedName: string,
        program: ts.Program,
    ): boolean {
        const info = this.infos.get(owner);
        if (info === undefined) return false;
        const root = path.resolve(this.workspaceRoot, info.root) + path.sep;
        let found = false;
        const visit = (node: ts.Node): void => {
            if (ts.isClassDeclaration(node)) {
                // An adapter implements a seam; it does not prove a business caller uses that seam.
                const adapter = node.heritageClauses?.some(
                    (clause) =>
                        clause.token === ts.SyntaxKind.ImplementsKeyword &&
                        clause.types.some((type) => {
                            if (this.symbol(type.expression)?.getName() !== exportedName)
                                return false;
                            return this.identity(type.expression).project === project;
                        }),
                );
                if (adapter) return;
                for (const member of node.members) {
                    if (!ts.isConstructorDeclaration(member)) continue;
                    for (const parameter of member.parameters) {
                        if (parameter.type === undefined || !ts.isTypeReferenceNode(parameter.type))
                            continue;
                        const symbol = this.symbol(parameter.type.typeName);
                        const declaration = symbol?.declarations?.[0];
                        if (
                            declaration === undefined ||
                            symbol?.getName() !== exportedName ||
                            !(
                                ts.isInterfaceDeclaration(declaration) ||
                                ts.isClassDeclaration(declaration)
                            )
                        )
                            continue;
                        const identity = this.identity(parameter.type.typeName);
                        if (identity.project === project && identity.exportedName === exportedName)
                            found = true;
                    }
                }
            }
            ts.forEachChild(node, visit);
        };
        for (const file of program.getSourceFiles()) {
            if (
                file.isDeclarationFile ||
                !file.fileName.startsWith(root) ||
                /(?:\.spec\.|\.test\.|\/__tests__\/)/.test(file.fileName)
            )
                continue;
            visit(file);
        }
        return found;
    }

    policies(
        invocation: ts.NewExpression | ts.CallExpression,
    ): Record<string, boolean | 'runtime'> {
        const policies: Record<string, boolean | 'runtime'> = {};
        const signature = this.checker.getResolvedSignature(invocation);
        for (const [index, parameter] of (signature?.getParameters() ?? []).entries()) {
            const declaration = parameter.valueDeclaration;
            if (declaration === undefined) continue;
            const type = this.checker.typeToString(
                this.checker.getTypeOfSymbolAtLocation(parameter, declaration),
            );
            if (!type.includes('WiringPolicy')) continue;
            const argument = invocation.arguments?.[index];
            if (
                argument === undefined ||
                !ts.isNewExpression(argument) ||
                this.symbolName(argument.expression) !== 'WiringPolicy'
            )
                this.fail('Pass an explicit named WiringPolicy to conditional modules.');
            const condition = argument.arguments?.[1];
            policies[parameter.getName()] =
                condition?.kind === ts.SyntaxKind.TrueKeyword
                    ? true
                    : condition?.kind === ts.SyntaxKind.FalseKeyword
                      ? false
                      : 'runtime';
        }
        return policies;
    }

    condition(call: ts.Node): string | undefined {
        let child = call;
        let node: ts.Node | undefined = call.parent;
        let policy: string | undefined;
        while (
            node !== undefined &&
            !ts.isClassDeclaration(node) &&
            !ts.isFunctionDeclaration(node)
        ) {
            if (ts.isIfStatement(node)) {
                if (policy !== undefined || child === node.elseStatement)
                    this.fail(
                        'Nested topology policies and else branches require separate explicitly selected modules.',
                    );
                const condition = node.expression;
                if (!ts.isPropertyAccessExpression(condition) || condition.name.text !== 'enabled')
                    this.fail('Topology conditions must use a named WiringPolicy.enabled.');
                policy = this.symbolName((condition as ts.PropertyAccessExpression).expression);
            }
            if (
                ts.isConditionalExpression(node) ||
                ts.isSwitchStatement(node) ||
                ts.isIterationStatement(node, false)
            )
                this.fail('Dynamic topology branches and loops require explicit selected modules.');
            child = node;
            node = node.parent;
        }
        return policy;
    }

    private symbol(node: ts.Node): ts.Symbol | undefined {
        const symbol = this.checker.getSymbolAtLocation(node);
        return symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0
            ? this.checker.getAliasedSymbol(symbol)
            : symbol;
    }

    private fail(message: string): never {
        throw new RuleFailError('validate-runtime-architecture', message, undefined, undefined, [
            new Option(
                'Use qualified imports and bounded target declarations in src/wiring.ts.',
                true,
            ),
        ]);
    }
}
