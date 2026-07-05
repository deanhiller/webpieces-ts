/**
 * Angular DI Analyzer (pass 2, Angular flavor)
 *
 * Renders each Angular entry component's injection tree "from the page/root
 * component on down". Reuses the shared {@link DiDesignBuilder} base (node ids,
 * leaf/unresolved labeling, provider-table resolution, factory-dep edges, level
 * assignment) via its `collectInjections` hook — only the front-half (roots,
 * providers, injection-site discovery) is Angular-specific.
 *
 * Angular injection sites per class:
 *   1. Constructor params — `@Inject(TOKEN)` (capital I), `forwardRef(() => X)`,
 *      `@Optional`/`@Self`/`@SkipSelf`/`@Host`, or a bare typed param (the class
 *      itself is the token).
 *   2. Field initializers calling `inject()` — the standalone pattern
 *      (`private saveApi = inject(SaveApi)`); the field name is the edge label
 *      and the declared/token type labels the box.
 *
 * Every site is an `angularToken` injection: the provider table is consulted
 * first, then the token expression is resolved as a bare `@Injectable` class,
 * else it becomes an `unresolved` node. Generation never fails.
 */

import * as ts from 'typescript';
import { DiDesign, DiGraph, DiNodeKind } from './model';
import { BindingTable, classDecorators, decoratorCall, decoratorName } from './bindings';
import { buildDesign, DiDesignBuilder, findConstructor, Injection } from './analyzer';
import { collectAngularProviders } from './angular-providers';
import { findAngularRoots } from './angular-roots';

function hasComponentDecorator(cls: ts.ClassDeclaration): boolean {
    for (const decorator of classDecorators(cls)) {
        if (decoratorName(decorator) === 'Component') return true;
    }
    return false;
}

/** Unwrap `forwardRef(() => X)` to its inner `X`; return `expr` unchanged otherwise. */
function unwrapForwardRef(expr: ts.Expression): ts.Expression {
    if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === 'forwardRef') {
        const arrow = expr.arguments[0];
        if (arrow && ts.isArrowFunction(arrow) && ts.isExpression(arrow.body)) {
            return arrow.body;
        }
    }
    return expr;
}

/** Read a constructor param's `@Inject(TOKEN)` token and `@Optional` flag. */
class AngularParam {
    token: ts.Expression | null;
    optional: boolean;

    constructor(token: ts.Expression | null, optional: boolean) {
        this.token = token;
        this.optional = optional;
    }
}

function readAngularParam(param: ts.ParameterDeclaration): AngularParam {
    let token: ts.Expression | null = null;
    let optional = false;
    for (const decorator of ts.getDecorators(param) ?? []) {
        const name = decoratorName(decorator);
        const call = decoratorCall(decorator);
        if (name === 'Inject' && call?.arguments[0]) {
            token = unwrapForwardRef(call.arguments[0]);
        } else if (name === 'Optional') {
            optional = true;
        }
        // @Self/@SkipSelf/@Host change the resolving injector, not the token —
        // the edge is recorded regardless; the scope nuance is out of scope for v1.
    }
    return new AngularParam(token, optional);
}

/** `inject(TOKEN)` call in a field initializer → the token expression, else null. */
function fieldInjectToken(initializer: ts.Expression | undefined): ts.Expression | null {
    if (!initializer || !ts.isCallExpression(initializer)) return null;
    if (!ts.isIdentifier(initializer.expression) || initializer.expression.text !== 'inject') return null;
    return initializer.arguments[0] ? unwrapForwardRef(initializer.arguments[0]) : null;
}

/**
 * Angular builder: injection sites are constructor params (`@Inject`/bare typed)
 * plus `inject()` field initializers. Root/reached components render as
 * `component`; services as `class`.
 */
class AngularDesignBuilder extends DiDesignBuilder {
    protected override rootKindOf(cls: ts.ClassDeclaration): DiNodeKind {
        return hasComponentDecorator(cls) ? 'component' : 'class';
    }

    protected collectInjections(cls: ts.ClassDeclaration): Injection[] {
        const injections: Injection[] = [];

        const ctor = findConstructor(cls);
        for (const param of ctor?.parameters ?? []) {
            const info = readAngularParam(param);
            const paramName = ts.isIdentifier(param.name) ? param.name.text : param.name.getText();
            const paramType = param.type ? param.type.getText() : '';

            if (info.token) {
                injections.push(new Injection('angularToken', info.token, paramName, paramType, false, info.optional));
            } else {
                const typeRef =
                    param.type && ts.isTypeReferenceNode(param.type) && ts.isIdentifier(param.type.typeName)
                        ? param.type.typeName
                        : null;
                if (typeRef) {
                    injections.push(new Injection('angularToken', typeRef, paramName, paramType, false, info.optional));
                }
            }
        }

        for (const member of cls.members) {
            if (!ts.isPropertyDeclaration(member) || !ts.isIdentifier(member.name)) continue;
            const token = fieldInjectToken(member.initializer);
            if (!token) continue;
            const paramName = member.name.text;
            // The field usually has no explicit type (`= inject(SaveApi)`) — the
            // token IS the declared type, so label the box with it.
            const paramType = member.type ? member.type.getText() : token.getText();
            injections.push(new Injection('angularToken', token, paramName, paramType));
        }

        return injections;
    }
}

/**
 * Build the full Angular DI graph for one project: one self-contained `DiDesign`
 * per entry component (bootstrap + routed). `projectRoot` is workspace-relative.
 */
export function buildAngularDiGraph(
    program: ts.Program,
    workspaceRoot: string,
    projectRoot: string,
    projectName: string,
): DiGraph {
    const checker = program.getTypeChecker();
    const table: BindingTable = collectAngularProviders(program, checker, workspaceRoot);
    const graph = new DiGraph(projectName);

    for (const root of findAngularRoots(program, checker, workspaceRoot, projectRoot)) {
        graph.designs.push(
            buildDesign(
                root,
                'component',
                workspaceRoot,
                (design: DiDesign) => new AngularDesignBuilder(checker, table, workspaceRoot, design),
            ),
        );
    }

    return graph;
}
