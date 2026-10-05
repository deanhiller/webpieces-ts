import * as ts from 'typescript';
import { WiringSourceTypes } from './source-types';

/**
 * Infer graph-relevant constructor paths from destination uses and selected named modules. Only
 * classes declared in a canonical src/wiring.ts are walked.
 */
export class PreparedTargets {
    private readonly types: WiringSourceTypes;

    constructor(private readonly checker: ts.TypeChecker) {
        this.types = new WiringSourceTypes(checker);
    }

    paths(invocation: ts.NewExpression | ts.CallExpression, channel: 'target' | 'policy'): string[] {
        const declaration = this.checker.getResolvedSignature(invocation)?.declaration?.parent;
        if (declaration === undefined || !ts.isClassDeclaration(declaration)) return [];
        return this.collect(declaration, new Set<ts.ClassDeclaration>(), channel);
    }

    path(expression: ts.Expression): string | undefined {
        if (ts.isIdentifier(expression)) return expression.text;
        if (!ts.isPropertyAccessExpression(expression)) return undefined;
        if (expression.expression.kind === ts.SyntaxKind.ThisKeyword) return expression.name.text;
        const parent = this.path(expression.expression);
        return parent === undefined ? undefined : `${parent}.${expression.name.text}`;
    }

    private collect(declaration: ts.ClassDeclaration, active: Set<ts.ClassDeclaration>, channel: 'target' | 'policy'): string[] {
        // Only canonical wiring declarations carry graph-relevant paths; another file's body is never read.
        if (active.has(declaration) || !/(?:^|[\\/])src[\\/]wiring\.ts$/.test(declaration.getSourceFile().fileName)) return [];
        const next = new Set([...active, declaration]);
        const parameters = declaration.members.filter(ts.isConstructorDeclaration).flatMap(
            (constructor: ts.ConstructorDeclaration) => constructor.parameters.map(
                (parameter: ts.ParameterDeclaration) => parameter.name.getText(),
            ),
        );
        const paths = new Set<string>();
        const retain = (path: string | undefined): void => {
            if (path !== undefined && parameters.includes(path.split('.')[0])) paths.add(path);
        };
        const visit = (node: ts.Node): void => {
            if (channel === 'policy' && ts.isPropertyAccessExpression(node) && node.name.text === 'enabled')
                retain(this.path(node.expression));
            if (channel === 'target' && ts.isCallExpression(node) && this.clientCall(node)) {
                const target = node.arguments[1];
                if (target !== undefined) retain(this.path(target));
            }
            if (ts.isNewExpression(node) && this.types.kind(node.expression) !== undefined) {
                const child = this.types.declaration(node.expression);
                const signature = this.checker.getResolvedSignature(node);
                if (child !== undefined && ts.isClassDeclaration(child)) {
                    for (const path of this.collect(child, next, channel)) {
                        const parts = path.split('.');
                        const name = parts[0];
                        const suffix = parts.slice(1);
                        const index = signature?.getParameters().findIndex((parameter: ts.Symbol) => parameter.name === name) ?? -1;
                        const argument = node.arguments?.[index];
                        if (argument === undefined) continue;
                        const parent = this.path(argument);
                        retain(parent === undefined ? undefined : [parent, ...suffix].join('.'));
                    }
                }
            }
            ts.forEachChild(node, visit);
        };
        ts.forEachChild(declaration, visit);
        return [...paths].sort();
    }

    private clientCall(call: ts.CallExpression): boolean {
        const signature = this.checker.getResolvedSignature(call)?.declaration;
        if (signature === undefined || (!ts.isMethodDeclaration(signature) && !ts.isMethodSignature(signature))) return false;
        const file = signature.getSourceFile().fileName.replace(/\\/g, '/');
        const name = signature.name?.getText();
        return name !== undefined && ['createRpcClientAndBind', 'createPubSubClientAndBind'].includes(name) &&
            /(?:\/packages\/http\/|\/node_modules\/@webpieces\/)(?:http-routing|http-client-browser)\//.test(file);
    }
}
