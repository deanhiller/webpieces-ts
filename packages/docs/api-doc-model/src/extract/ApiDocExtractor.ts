import * as ts from 'typescript';
import {
    ApiDocModel,
    DocumentedAuth,
    DocumentedEndpoint,
    DocumentedEndpointOptions,
    DocumentedMcpTool,
} from '../model/ApiDocModel';
import { TypeRef } from '../model/TypeRef';
import { ApiDocExtractionError } from './ApiDocExtractionError';
import { ConstantFolder } from './ConstantFolder';
import { JsDoc } from './JsDoc';
import { SourceLocation } from './SourceLocation';
import { TypeResolver } from './TypeResolver';

/** The decorator names this extractor reads, by NAME. It imports none of them — see the class doc. */
const API_PATH = 'ApiPath';
const ENDPOINT = 'Endpoint';
const MASK_LOG = 'MaskLog';
const MCP_TOOL = 'WpMcpTool';
const MCP_AUTH = 'WpMcpAuthJwt';
const AUTH_PREFIX = 'WpAuth';

/** The MCP tool hints a renderer surfaces to an agent. */
const TOOL_HINTS = ['readOnly', 'destructive', 'idempotent', 'openWorld'];

/**
 * ONE contract file -> ONE {@link ApiDocModel}. The single extraction pass both the OpenAPI documents
 * and the MCP tool list (#982) are rendered from.
 *
 * ## Why the compiler API at all
 *
 * A DTO field's TYPE IS ERASED AT RUNTIME. Reflection can see that `save` takes one argument; it
 * cannot see that the argument has a `deliveryWindow` that is a discriminated union of two shapes,
 * one of which carries an ISO timestamp. Those are precisely the shapes a partner-grade document is
 * made of, so the only place they exist is the source, and the only honest way to read the source is
 * the compiler.
 *
 * ## Why it imports NO webpieces package
 *
 * It depends on `typescript` and nothing else, so it can be pointed at ANY upstream project's
 * contract — which is the whole point of shipping it as a package rather than as a script in this
 * repo. Decorators are therefore matched BY NAME on the syntax, never by importing the real
 * decorator. One `@webpieces/core-util` import here would make the package unusable by anybody whose
 * webpieces version differs from ours, which is everybody.
 *
 * ## What it does NOT do
 *
 * It emits nothing. No OpenAPI, no MCP tool definitions, no file — that is #982, and keeping the
 * render out means the two renderers cannot drift apart about what the contract SAYS.
 */
export class ApiDocExtractor {
    /**
     * Extract the contract in `entryFile`.
     *
     * @param entryFile absolute path to the `.ts` file holding the `@ApiPath` class.
     * @param compilerOptions handed straight to `ts.createProgram`; the caller owns them because
     *        only the caller knows its own `paths` / `lib` setup.
     * @throws ApiDocExtractionError when the file holds no `@ApiPath` class, or when something that
     *         must be exact (a path constant, a numeric bound) cannot be established.
     */
    extractFile(entryFile: string, compilerOptions: ts.CompilerOptions = {}): ApiDocModel {
        const program = ts.createProgram([entryFile], compilerOptions);
        const source = program.getSourceFile(entryFile);
        if (source === undefined) {
            throw new ApiDocExtractionError(
                'entry file is not part of the program',
                entryFile,
                'Pass an absolute path to a .ts file that exists.',
            );
        }
        return this.extract(program, source);
    }

    /** The same extraction against a program the caller already built. */
    extract(program: ts.Program, source: ts.SourceFile): ApiDocModel {
        const checker = program.getTypeChecker();
        const folder = new ConstantFolder(checker);
        const resolver = new TypeResolver(checker);

        const contract = this.findContract(source);
        const pathDecorator = ApiDocExtractor.decoratorCall(contract, API_PATH)!;
        const basePathArgument = pathDecorator.arguments[0];
        const basePath =
            basePathArgument === undefined
                ? ''
                : folder.foldString(basePathArgument, '@ApiPath argument');

        const endpoints: DocumentedEndpoint[] = [];
        for (const member of contract.members) {
            const endpoint = this.endpointOf(member, folder, resolver);
            if (endpoint !== undefined) {
                endpoints.push(endpoint);
            }
        }

        return new ApiDocModel(
            contract.name?.text ?? '<anonymous>',
            basePath,
            JsDoc.read(contract).description,
            endpoints,
            resolver.collectedTypes(),
            resolver.collectedUnmapped(),
        );
    }

    /** The one `@ApiPath` class in the file. Zero is a hard failure; the FIRST wins if there are two. */
    private findContract(source: ts.SourceFile): ts.ClassDeclaration {
        for (const statement of source.statements) {
            if (
                ts.isClassDeclaration(statement) &&
                ApiDocExtractor.decoratorCall(statement, API_PATH) !== undefined
            ) {
                return statement;
            }
        }
        throw new ApiDocExtractionError(
            'no @ApiPath class in this file',
            source.fileName,
            'Point the extractor at the contract file — the one whose class carries @ApiPath.',
        );
    }

    /** One `@Endpoint` method. Members without the decorator are not part of the contract. */
    private endpointOf(
        member: ts.ClassElement,
        folder: ConstantFolder,
        resolver: TypeResolver,
    ): DocumentedEndpoint | undefined {
        if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) {
            return undefined;
        }
        const call = ApiDocExtractor.decoratorCall(member, ENDPOINT);
        if (call === undefined) {
            return undefined;
        }
        const methodName = member.name.text;

        const pathArgument = call.arguments[0];
        if (pathArgument === undefined) {
            throw new ApiDocExtractionError(
                `@Endpoint on '${methodName}' declares no path`,
                SourceLocation.of(call),
                "Give it a path: @Endpoint('/thing', 'rpc').",
            );
        }
        const path = folder.foldString(pathArgument, `@Endpoint path on '${methodName}'`);

        const kindArgument = call.arguments[1];
        if (kindArgument === undefined) {
            throw new ApiDocExtractionError(
                `@Endpoint on '${methodName}' declares no kind`,
                SourceLocation.of(call),
                "State what triggers it: 'rpc', 'cloudtasks', 'cron' or 'external'.",
            );
        }
        const kind = folder.foldString(kindArgument, `@Endpoint kind on '${methodName}'`);

        const options = call.arguments[2];
        const literal =
            options !== undefined && ts.isObjectLiteralExpression(options) ? options : undefined;

        const doc = JsDoc.read(member);
        return new DocumentedEndpoint(
            methodName,
            path,
            kind,
            ApiDocExtractor.booleanProperty(literal, 'hidden'),
            new DocumentedEndpointOptions(
                ApiDocExtractor.booleanProperty(literal, 'formPost'),
                ApiDocExtractor.stringProperty(literal, 'calledBy', folder),
                ApiDocExtractor.stringProperty(literal, 'callerKind', folder),
            ),
            ApiDocExtractor.authOf(member),
            ApiDocExtractor.mcpToolOf(member, folder),
            ApiDocExtractor.decoratorCall(member, MCP_AUTH)?.arguments[0]?.getText(),
            ApiDocExtractor.maskLogOf(member),
            doc.description,
            doc.mcp,
            this.requestOf(member, methodName, resolver),
            this.responseOf(member, methodName, resolver),
        );
    }

    /** The FIRST parameter's declared type. An endpoint with no parameter has no request document. */
    private requestOf(
        member: ts.MethodDeclaration,
        methodName: string,
        resolver: TypeResolver,
    ): TypeRef | undefined {
        const parameter = member.parameters[0];
        if (parameter?.type === undefined) {
            return undefined;
        }
        return resolver.resolve(parameter.type, `${methodName}.request`);
    }

    /** The declared return type, unwrapped from `Promise<...>` by the resolver. */
    private responseOf(
        member: ts.MethodDeclaration,
        methodName: string,
        resolver: TypeResolver,
    ): TypeRef | undefined {
        if (member.type === undefined) {
            return undefined;
        }
        return resolver.resolve(member.type, `${methodName}.response`);
    }

    /** `@WpAuthPublic()`, `@WpAuthJwt({...})`, … — recorded verbatim; this package rules on nothing. */
    // webpieces-disable no-function-outside-class -- private static reader of this class
    private static authOf(member: ts.Node): DocumentedAuth | undefined {
        const decorators = ts.canHaveDecorators(member) ? (ts.getDecorators(member) ?? []) : [];
        for (const decorator of decorators) {
            const call = decorator.expression;
            if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) {
                continue;
            }
            const name = call.expression.text;
            if (name.startsWith(AUTH_PREFIX) && name !== MCP_AUTH) {
                return new DocumentedAuth(name, call.arguments[0]?.getText());
            }
        }
        return undefined;
    }

    /** `@WpMcpTool({ name, readOnly, ... })` — the name plus whichever hints were declared. */
    // webpieces-disable no-function-outside-class -- private static reader of this class
    private static mcpToolOf(
        member: ts.Node,
        folder: ConstantFolder,
    ): DocumentedMcpTool | undefined {
        const call = ApiDocExtractor.decoratorCall(member, MCP_TOOL);
        const argument = call?.arguments[0];
        if (argument === undefined || !ts.isObjectLiteralExpression(argument)) {
            return undefined;
        }
        const hints = new Map<string, boolean>();
        for (const hint of TOOL_HINTS) {
            const value = ApiDocExtractor.findProperty(argument, hint);
            if (value !== undefined) {
                hints.set(hint, value.kind === ts.SyntaxKind.TrueKeyword);
            }
        }
        return new DocumentedMcpTool(
            ApiDocExtractor.stringProperty(argument, 'name', folder) ?? '',
            hints,
        );
    }

    /** `@MaskLog({ refreshToken: 'full' })` -> field name -> mask mode. */
    // webpieces-disable no-function-outside-class -- private static reader of this class
    private static maskLogOf(member: ts.Node): ReadonlyMap<string, string> {
        const fields = new Map<string, string>();
        const argument = ApiDocExtractor.decoratorCall(member, MASK_LOG)?.arguments[0];
        if (argument === undefined || !ts.isObjectLiteralExpression(argument)) {
            return fields;
        }
        for (const property of argument.properties) {
            if (
                ts.isPropertyAssignment(property) &&
                (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
                ts.isStringLiteralLike(property.initializer)
            ) {
                fields.set(property.name.text, property.initializer.text);
            }
        }
        return fields;
    }

    // webpieces-disable no-function-outside-class -- private static reader of this class
    private static booleanProperty(
        literal: ts.ObjectLiteralExpression | undefined,
        name: string,
    ): boolean {
        const value =
            literal === undefined ? undefined : ApiDocExtractor.findProperty(literal, name);
        return value?.kind === ts.SyntaxKind.TrueKeyword;
    }

    // webpieces-disable no-function-outside-class -- private static reader of this class
    private static stringProperty(
        literal: ts.ObjectLiteralExpression | undefined,
        name: string,
        folder: ConstantFolder,
    ): string | undefined {
        const value =
            literal === undefined ? undefined : ApiDocExtractor.findProperty(literal, name);
        return value === undefined ? undefined : folder.tryFoldString(value);
    }

    // webpieces-disable no-function-outside-class -- private static reader of this class
    private static findProperty(
        literal: ts.ObjectLiteralExpression,
        name: string,
    ): ts.Expression | undefined {
        for (const property of literal.properties) {
            if (
                ts.isPropertyAssignment(property) &&
                (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
                property.name.text === name
            ) {
                return property.initializer;
            }
        }
        return undefined;
    }

    // webpieces-disable no-function-outside-class -- private static reader of this class
    private static decoratorCall(
        node: ts.Node,
        decoratorName: string,
    ): ts.CallExpression | undefined {
        const decorators = ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
        for (const decorator of decorators) {
            const call = decorator.expression;
            if (
                ts.isCallExpression(call) &&
                ts.isIdentifier(call.expression) &&
                call.expression.text === decoratorName
            ) {
                return call;
            }
        }
        return undefined;
    }
}
