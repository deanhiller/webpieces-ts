import * as path from 'path';
import * as ts from 'typescript';
import { Option, RuleFailError } from '@webpieces/rules-config';
import type { ProjectInfo } from '../project-info';
import { ContractIdentity } from './declaration';
import type { DeclaredTarget, PolicyValue } from './declaration';
import { PreparedTargets } from './prepared-targets';
import { WiringSourceTypes } from './source-types';

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
        if (ts.isNewExpression(value) && ['ClientConfig', 'TaskClientConfig'].includes(this.symbolName(value.expression)))
            return this.target(value.arguments?.[0], depth + 1);
        const declaration = this.symbol(value)?.declarations?.[0];
        if (declaration !== undefined && ts.isVariableDeclaration(declaration))
            return this.target(declaration.initializer, depth + 1);
        if (declaration !== undefined && ts.isPropertyAssignment(declaration))
            return this.target(declaration.initializer, depth + 1);
        if (declaration !== undefined && ts.isParameter(declaration))
            return { kind: 'parameter', parameter: this.parameterPath(value) };
        if (ts.isPropertyAccessExpression(value)) {
            const type = this.checker.getTypeAtLocation(value);
            if ((type.flags & ts.TypeFlags.StringLike) !== 0)
                return { kind: 'parameter', parameter: this.parameterPath(value) };
        }
        this.fail(
            `Unsupported target ${value.getText()}; use a literal service or a prepared constructor field.`,
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
        const prepared = new PreparedTargets(this.checker);
        for (const path of prepared.paths(invocation, 'target')) {
            const parts = path.split('.');
            const name = parts[0];
            const suffix = parts.slice(1);
            const index = signature?.getParameters().findIndex((parameter: ts.Symbol) => parameter.name === name) ?? -1;
            const expression = invocation.arguments?.[index];
            if (expression === undefined) this.fail(`Missing prepared destination argument ${path}.`);
            if (suffix.length === 0) targets[path] = this.target(expression);
            else {
                const value = this.preparedValue(expression!, suffix);
                targets[path] = value instanceof ForwardedParameter
                    ? { kind: 'parameter', parameter: value.parameter } : this.target(value);
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
    ): Record<string, PolicyValue> {
        const policies: Record<string, PolicyValue> = {};
        const signature = this.checker.getResolvedSignature(invocation);
        const prepared = new PreparedTargets(this.checker);
        for (const path of prepared.paths(invocation, 'policy')) {
            const parts = path.split('.');
            const name = parts[0];
            const suffix = parts.slice(1);
            const index = signature?.getParameters().findIndex((parameter: ts.Symbol) => parameter.name === name) ?? -1;
            const supplied = invocation.arguments?.[index];
            if (supplied === undefined) this.fail(`Missing explicit policy argument ${path}.`);
            const argument = suffix.length === 0 ? supplied! : this.preparedValue(supplied!, suffix);
            if (argument instanceof ForwardedParameter) {
                policies[path] = { parameter: argument.parameter };
                continue;
            }
            if (ts.isIdentifier(argument) || ts.isPropertyAccessExpression(argument)) {
                policies[path] = { parameter: this.parameterPath(argument) };
                continue;
            }
            if (!ts.isNewExpression(argument) || !new WiringSourceTypes(this.checker).isFramework(argument.expression, 'WiringPolicy'))
                this.fail('Pass an explicit named WiringPolicy to conditional modules.');
            const condition = argument.arguments?.[1];
            policies[path] = condition?.kind === ts.SyntaxKind.TrueKeyword ? true
                : condition?.kind === ts.SyntaxKind.FalseKeyword ? false : 'runtime';
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
                policy = this.parameterPath((condition as ts.PropertyAccessExpression).expression);
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

    private preparedValue(expression: ts.Expression, suffix: readonly string[]): ts.Expression | ForwardedParameter {
        const base = this.symbol(expression)?.declarations?.[0];
        if (base !== undefined && ts.isParameter(base))
            return new ForwardedParameter([this.parameterPath(expression), ...suffix].join('.'));
        if (ts.isPropertyAccessExpression(expression)) {
            const root = expression.expression;
            if (root.kind === ts.SyntaxKind.ThisKeyword || ts.isPropertyAccessExpression(root))
                return new ForwardedParameter([this.parameterPath(expression), ...suffix].join('.'));
        }
        let type = this.checker.getTypeAtLocation(expression);
        let declaration: ts.Declaration | undefined;
        for (const name of suffix) {
            const property = type.getProperty(name);
            declaration = property?.valueDeclaration;
            if (property === undefined || declaration === undefined)
                this.fail(`Cannot resolve prepared destination ${expression.getText()}.${suffix.join('.')}.`);
            type = this.checker.getTypeOfSymbolAtLocation(property!, declaration!);
        }
        if (declaration !== undefined && ts.isPropertyAssignment(declaration))
            return declaration.initializer;
        if (declaration !== undefined && ts.isPropertyDeclaration(declaration) && declaration.initializer !== undefined)
            return declaration.initializer;
        this.fail(`Unresolved destination ${expression.getText()}.${suffix.join('.')}; prepare a statically resolvable destination, never a computed config function.`);
    }

    private parameterPath(expression: ts.Expression): string {
        if (ts.isPropertyAccessExpression(expression)) {
            if (expression.expression.kind === ts.SyntaxKind.ThisKeyword) return expression.name.text;
            return `${this.parameterPath(expression.expression)}.${expression.name.text}`;
        }
        if (ts.isIdentifier(expression)) return expression.text;
        this.fail(`Unsupported prepared parameter path ${expression.getText()}.`);
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

class ForwardedParameter {
    constructor(readonly parameter: string) {}
}
