import * as ts from 'typescript';
import { ApiDocExtractionError } from './ApiDocExtractionError';
import { SourceLocation } from './SourceLocation';

/**
 * Decorator arguments are constants as often as they are literals — `@Endpoint(POST, SAVE_PATH, READ,
 * RPC)`, `@ApiPath(PATHS.SAVE)` — and a document that printed `SAVE_PATH` as the path, or `RPC` as the
 * trigger, would be worse than no document.
 *
 * So the folder resolves them, and where it CANNOT it FAILS. There is deliberately no fallback to
 * the source text and no "best effort" path: a partner-grade document that is quietly wrong about a
 * URL is the one failure mode nobody catches by reading it.
 *
 * It asks the CHECKER first, which is what makes this robust across re-exports, imports and
 * `as const` objects: a `const` initialised with a string has a string-LITERAL type, and the checker
 * has already done the resolution. The syntactic walk below it exists only for the shapes the
 * checker widens.
 */
export class ConstantFolder {
    constructor(private readonly checker: ts.TypeChecker) {}

    /**
     * The string this expression denotes.
     *
     * @throws ApiDocExtractionError when it cannot be established — never a guess.
     */
    foldString(expression: ts.Expression, what: string): string {
        const folded = this.tryFold(expression, new Set<ts.Node>());
        if (folded === undefined) {
            throw new ApiDocExtractionError(
                `${what} is not a foldable constant: '${expression.getText()}'`,
                SourceLocation.of(expression),
                'Declare it as a `const` initialised with a string literal (or write the literal inline). ' +
                    'A value only known at runtime cannot appear in a published document.',
            );
        }
        return folded;
    }

    /** The string this expression denotes, or undefined. No throw — for optional arguments. */
    tryFoldString(expression: ts.Expression): string | undefined {
        return this.tryFold(expression, new Set<ts.Node>());
    }

    /**
     * The expression a name ultimately DENOTES, following `const` declarations through imports.
     *
     * A decorator argument is a constant as often as it is a literal, and that is true of structures
     * too: a credential list shared by every method of a contract is written once as a `const` and
     * named five times, which is better source than five copies. A reader that only understood a
     * literal would force the copies — so the copies would happen, and one of them would drift.
     *
     * Returns the expression unchanged when it is not a name, so a caller can follow first and then
     * ask what shape it is.
     */
    follow(expression: ts.Expression): ts.Expression {
        return this.followThrough(expression, new Set<ts.Node>());
    }

    private followThrough(expression: ts.Expression, seen: Set<ts.Node>): ts.Expression {
        if (seen.has(expression)) {
            return expression;
        }
        seen.add(expression);
        if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)) {
            return this.followThrough(expression.expression, seen);
        }
        if (!ts.isIdentifier(expression) && !ts.isPropertyAccessExpression(expression)) {
            return expression;
        }
        const symbol = this.checker.getSymbolAtLocation(expression);
        const resolved =
            symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0
                ? this.checker.getAliasedSymbol(symbol)
                : symbol;
        for (const declaration of resolved?.declarations ?? []) {
            if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
                return this.followThrough(declaration.initializer, seen);
            }
            if (ts.isPropertyAssignment(declaration) && ts.isExpression(declaration.initializer)) {
                return this.followThrough(declaration.initializer, seen);
            }
        }
        return expression;
    }

    private tryFold(expression: ts.Expression, seen: Set<ts.Node>): string | undefined {
        if (seen.has(expression)) {
            return undefined; // a const initialised from itself; not our problem to diagnose
        }
        seen.add(expression);

        if (ts.isStringLiteralLike(expression)) {
            return expression.text;
        }

        // The checker's answer, which already resolved imports, re-exports and `as const`.
        const type = this.checker.getTypeAtLocation(expression);
        if (type.isStringLiteral()) {
            return type.value;
        }

        if (ts.isTemplateExpression(expression)) {
            let out = expression.head.text;
            for (const span of expression.templateSpans) {
                const part = this.tryFold(span.expression, seen);
                if (part === undefined) {
                    return undefined;
                }
                out += part + span.literal.text;
            }
            return out;
        }

        if (
            ts.isBinaryExpression(expression) &&
            expression.operatorToken.kind === ts.SyntaxKind.PlusToken
        ) {
            const left = this.tryFold(expression.left, seen);
            const right = this.tryFold(expression.right, seen);
            return left === undefined || right === undefined ? undefined : left + right;
        }

        if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)) {
            return this.foldThroughSymbol(expression, seen);
        }

        if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)) {
            return this.tryFold(expression.expression, seen);
        }

        return undefined;
    }

    /** Follow an identifier / `Obj.MEMBER` to its declaration's initializer and fold that. */
    private foldThroughSymbol(expression: ts.Expression, seen: Set<ts.Node>): string | undefined {
        const symbol = this.checker.getSymbolAtLocation(expression);
        const resolved =
            symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0
                ? this.checker.getAliasedSymbol(symbol)
                : symbol;
        for (const declaration of resolved?.declarations ?? []) {
            if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
                return this.tryFold(declaration.initializer, seen);
            }
            if (ts.isPropertyAssignment(declaration) && ts.isExpression(declaration.initializer)) {
                return this.tryFold(declaration.initializer, seen);
            }
            if (ts.isPropertyDeclaration(declaration) && declaration.initializer) {
                return this.tryFold(declaration.initializer, seen);
            }
        }
        return undefined;
    }
}
