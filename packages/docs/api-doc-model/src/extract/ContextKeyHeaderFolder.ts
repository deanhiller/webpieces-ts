import * as ts from 'typescript';
import { ApiDocExtractionError } from './ApiDocExtractionError';
import { ConstantFolder } from './ConstantFolder';
import { SourceLocation } from './SourceLocation';

/** Which of a ContextKey's two wire names to read. */
export enum ContextKeyHeaderSlot {
    /** `httpHeader` — the name the key rides under on a REQUEST. An api-key credential's header. */
    REQUEST = 'httpHeader',
    /** `responseHeader` — the name the key is written back under on a RESPONSE. */
    RESPONSE = 'responseHeader',
}

/** The class whose two factories define every context key. Matched by name, through imports. */
const CONTEXT_KEY = 'ContextKey';

/**
 * WHERE each factory takes each header, positionally — the two factories differ by `provenance`,
 * which only `trusted` has:
 *
 *   ContextKey.trusted(name, provenance, httpHeader?, maskInLogs?, isLogged?, responseHeader?, merge?)
 *   ContextKey.untrusted(name, httpHeader?, maskInLogs?, isLogged?, responseHeader?, merge?)
 */
const ARGUMENT_INDEX: ReadonlyMap<string, ReadonlyMap<ContextKeyHeaderSlot, number>> = new Map([
    [
        'trusted',
        new Map([
            [ContextKeyHeaderSlot.REQUEST, 2],
            [ContextKeyHeaderSlot.RESPONSE, 5],
        ]),
    ],
    [
        'untrusted',
        new Map([
            [ContextKeyHeaderSlot.REQUEST, 1],
            [ContextKeyHeaderSlot.RESPONSE, 4],
        ]),
    ],
]);

/**
 * Read a HEADER NAME off a `ContextKey` reference, statically (#1249).
 *
 * Header names are never written as strings on a documented surface: an api-key credential names
 * the ContextKey carrying it (`{ in: 'header', key: OneTabletKey.ORG_ID }`), and a manifest's
 * response header names an exported ContextKey const. ONE definition of each header — the
 * `ContextKey.trusted(...)` / `ContextKey.untrusted(...)` call — is therefore what the server,
 * the clients and the published document all read, so a rename cannot leave a copy stale.
 *
 * This follows the reference — through `!`, `as`, `satisfies`, parentheses, `const`s, imports,
 * object-literal properties and a class's `static readonly` properties — to that factory call, and
 * folds the header argument with the same {@link ConstantFolder} every other decorator argument
 * goes through.
 *
 * It FAILS rather than guessing, and the refusal quotes the EXPRESSION it could not resolve: a
 * document that silently dropped a header would tell a partner they need one credential fewer than
 * the running hook demands.
 */
export class ContextKeyHeaderFolder {
    constructor(private readonly folder: ConstantFolder) {}

    /**
     * The header name `expression` — a reference to a ContextKey — rides under in `slot`.
     *
     * @param what names the surface for the refusal, e.g. "the apiKey(...) header credential's key".
     * @throws ApiDocExtractionError naming the expression when it cannot be established.
     */
    fold(expression: ts.Expression, slot: ContextKeyHeaderSlot, what: string): string {
        const definition = this.folder.follow(expression);
        return this.foldDefinition(definition, expression.getText(), expression, slot, what);
    }

    /**
     * Same as {@link fold}, starting from a SYMBOL — an exported const a manifest names, possibly a
     * dotted path into a class or object (`OneTabletKey.TX_ID`).
     */
    foldSymbol(
        symbol: ts.Symbol,
        written: string,
        where: string,
        slot: ContextKeyHeaderSlot,
        what: string,
    ): string {
        const initializer = this.folder.initializerOf(symbol);
        if (initializer === undefined) {
            throw this.unresolvable(written, where, what);
        }
        return this.foldDefinition(this.folder.follow(initializer), written, initializer, slot, what);
    }

    private foldDefinition(
        definition: ts.Expression,
        written: string,
        at: ts.Node,
        slot: ContextKeyHeaderSlot,
        what: string,
    ): string {
        const factory = ts.isCallExpression(definition) ? this.factoryOf(definition) : undefined;
        if (factory === undefined || !ts.isCallExpression(definition)) {
            throw this.unresolvable(written, SourceLocation.of(at), what);
        }
        const index = ARGUMENT_INDEX.get(factory)!.get(slot)!;
        const argument = definition.arguments[index];
        if (argument === undefined || this.isUndefined(argument)) {
            throw new ApiDocExtractionError(
                `${what} '${written}' is a ContextKey that declares no ${slot}`,
                SourceLocation.of(definition),
                `Give the key its ${slot} in its ContextKey.${factory}(...) definition — a key with no ` +
                    'header name never crosses the wire, so it cannot be documented as one.',
            );
        }
        const header = this.folder.tryFoldString(argument);
        if (header === undefined || header.trim() === '') {
            throw new ApiDocExtractionError(
                `${what} '${written}': the ${slot} of its ContextKey is not a foldable constant: '${argument.getText()}'`,
                SourceLocation.of(argument),
                'Write the header name as a string literal (or a `const` initialised with one) in the ' +
                    "key's ContextKey.trusted(...) / ContextKey.untrusted(...) call.",
            );
        }
        return header;
    }

    private unresolvable(written: string, where: string, what: string): ApiDocExtractionError {
        return new ApiDocExtractionError(
            `cannot statically resolve ${what} '${written}' to a ContextKey.trusted(...) / ContextKey.untrusted(...) definition`,
            where,
            'Reference a ContextKey declared in source — a `const`, an object property, or a class ' +
                "`static readonly` — initialised directly by ContextKey.trusted(...) or ContextKey.untrusted(...). " +
                'A key only known at runtime (or only as a .d.ts declaration) has no header name a document can read.',
        );
    }

    /** `trusted` / `untrusted` when this is `ContextKey.trusted(...)` / `ContextKey.untrusted(...)`. */
    private factoryOf(call: ts.CallExpression): string | undefined {
        const callee = call.expression;
        if (!ts.isPropertyAccessExpression(callee) || !ARGUMENT_INDEX.has(callee.name.text)) {
            return undefined;
        }
        const resolved = this.folder.symbolOf(callee.expression);
        // The resolved name covers an aliased import (`import { ContextKey as Key }`); the written
        // name covers a program that could not resolve the module at all.
        const named =
            resolved?.name === CONTEXT_KEY ||
            (ts.isIdentifier(callee.expression) && callee.expression.text === CONTEXT_KEY);
        return named ? callee.name.text : undefined;
    }

    private isUndefined(argument: ts.Expression): boolean {
        return ts.isIdentifier(argument) && argument.text === 'undefined';
    }
}
