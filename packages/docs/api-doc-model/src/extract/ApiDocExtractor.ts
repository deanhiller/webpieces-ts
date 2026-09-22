import * as ts from 'typescript';
import {
    ApiPath,
    CLOUDTASKS,
    CRON,
    Endpoint,
    EXTERNAL,
    GET,
    MaskLog,
    POST,
    READ,
    RPC,
    WRITE,
    WRITE_IDEMPOTENT,
    WpAuthApiKey,
    WpAuthJwt,
    WpAuthLocalOnly,
    WpAuthOidc,
    WpAuthPublic,
    WpAuthSharedSecret,
    WpAuthWebhook,
    ApiType,
    EXTERNAL_CUSTOMER,
    MCP,
    SVC_TO_SVC,
    WpMcpAuthJwt,
    WpMcpTool,
} from '@webpieces/core-util';
import {
    ApiDocModel,
    DocumentedApiKey,
    DocumentedApiKeyCredential,
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

/**
 * The decorator names this extractor matches on, taken from the REAL SYMBOLS rather than re-typed as
 * string literals.
 *
 * ## Why `.name` and not `'Endpoint'`
 *
 * The extractor matches decorators by NAME on the syntax — it must, because it reads a contract with
 * the compiler and never executes it. The question is only where that name comes from, and a literal
 * has a silent failure mode that a symbol does not: rename `@WpMcpTool` in `core-util` and a literal
 * simply stops matching. The extractor then finds zero MCP tools, the MCP document is correctly not
 * written because it has no tools in it, and the BUILD IS GREEN. A partner-facing document silently
 * loses a section with nothing red anywhere (issue #1001).
 *
 * `Endpoint.name` makes that rename a COMPILE ERROR here, which in this repo is the delivery
 * mechanism for a migration rather than an obstacle to one: a compile break names the new spelling
 * and an agent applies it in one pass, where a green build teaches nobody anything.
 *
 * ## Why importing `@webpieces/core-util` is not the coupling it looks like
 *
 * Any contract carrying `@Endpoint` already depends on `core-util` by definition, so there is no
 * upstream project this import could shut out. It is build-time only, it creates no cycle, and it
 * costs a browser bundle nothing because nothing in a bundle imports this package. The direction that
 * WOULD be fatal is `core-util` depending on the TypeScript compiler, and that is not this.
 */
const API_PATH = ApiPath.name;
const ENDPOINT = Endpoint.name;
const MASK_LOG = MaskLog.name;
const MCP_TOOL = WpMcpTool.name;
const MCP_AUTH = WpMcpAuthJwt.name;
const API_KEY_AUTH = WpAuthApiKey.name;
const API_TYPE = ApiType.name;

/**
 * The prefix shared by every credential decorator. A PREFIX genuinely has no symbol to take a name
 * from, so it stays a literal — but the set it selects is pinned below, which is what stops it
 * quietly matching nothing.
 */
const AUTH_PREFIX = 'WpAuth';

/** Every credential decorator, by real symbol, so a rename of any of them fails to compile here. */
const AUTH_DECORATORS = new Set([
    WpAuthPublic.name,
    WpAuthJwt.name,
    WpAuthOidc.name,
    WpAuthSharedSecret.name,
    WpAuthWebhook.name,
    WpAuthApiKey.name,
    WpAuthLocalOnly.name,
]);

/** The REAL trigger kinds and side-effect contracts, so a contract cannot declare one that is not. */
const ENDPOINT_KINDS: readonly string[] = [RPC, CLOUDTASKS, CRON, EXTERNAL];
const ENDPOINT_OPERATIONS: readonly string[] = [READ, WRITE_IDEMPOTENT, WRITE];
const HTTP_METHODS: readonly string[] = [GET, POST];

/** `@Endpoint`'s four required positions, named so a failure can say which one is missing. */
const ARGUMENT_NAMES = ['http method', 'path', 'operation', 'trigger kind'];

/** The allowed values of each required position, in the same order, for the same failure. */
const ARGUMENT_VALUES: readonly (readonly string[])[] = [
    HTTP_METHODS,
    [],
    ENDPOINT_OPERATIONS,
    ENDPOINT_KINDS,
];

/** The REAL document types, so a contract cannot name a document that does not exist. */
const API_TYPES: readonly string[] = [SVC_TO_SVC, EXTERNAL_CUSTOMER, MCP];

/** The fail-closed default: a contract that declares nothing feeds only the internal document. */
const DEFAULT_API_TYPES: readonly string[] = [SVC_TO_SVC];

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
 * ## Why it IMPORTS `@webpieces/core-util`
 *
 * Decorators are matched BY NAME on the syntax — they must be, because this reads a contract and
 * never executes it. The NAMES come from the real symbols (`Endpoint.name`), so a rename in
 * `core-util` is a compile error here instead of a literal that quietly stops matching. The full
 * argument, and why the import is not the coupling it looks like, is at those constants.
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

        const apiTypes = this.declaredApiTypes(contract, folder);
        const endpoints: DocumentedEndpoint[] = [];
        for (const member of contract.members) {
            const endpoint = this.endpointOf(member, folder, resolver);
            if (endpoint !== undefined) {
                endpoints.push(endpoint);
            }
        }
        this.assertApiTypeMatchesMcpTools(contract, apiTypes, endpoints);

        return new ApiDocModel(
            contract.name?.text ?? '<anonymous>',
            apiTypes,
            basePath,
            JsDoc.read(contract).description,
            endpoints,
            resolver.collectedTypes(),
            resolver.collectedUnmapped(),
        );
    }

    /**
     * Extract ONE named type and everything it reaches, from a file that holds NO contract.
     *
     * This exists for a type nothing in a contract points at but a document still publishes — the
     * document-wide error body a renderer's manifest names. Reading it with the SAME resolver is the
     * point: a second reader would be a second answer to "what shape is this type", and the two
     * would drift the first time a field changed.
     *
     * @throws ApiDocExtractionError when the file does not declare that name.
     */
    extractType(
        entryFile: string,
        typeName: string,
        compilerOptions: ts.CompilerOptions = {},
    ): ApiDocModel {
        const program = ts.createProgram([entryFile], compilerOptions);
        const source = program.getSourceFile(entryFile);
        if (source === undefined) {
            throw new ApiDocExtractionError(
                'entry file is not part of the program',
                entryFile,
                'Pass an absolute path to a .ts file that exists.',
            );
        }
        const resolver = new TypeResolver(program.getTypeChecker());
        const declaration = ApiDocExtractor.declarationNamed(source, typeName);
        if (declaration === undefined) {
            throw new ApiDocExtractionError(
                `no type named '${typeName}' is declared in this file`,
                entryFile,
                `Declare and export '${typeName}' there, or name the file that does.`,
            );
        }
        resolver.resolveDeclaration(typeName, declaration, typeName);
        return new ApiDocModel(
            typeName,
            DEFAULT_API_TYPES,
            '',
            '',
            [],
            resolver.collectedTypes(),
            resolver.collectedUnmapped(),
        );
    }

    /** The interface / class / type alias / enum declared under `name` at the file's top level. */
    // webpieces-disable no-function-outside-class -- private static reader of this class
    private static declarationNamed(
        source: ts.SourceFile,
        name: string,
    ): ts.Declaration | undefined {
        for (const statement of source.statements) {
            const named =
                ts.isInterfaceDeclaration(statement) ||
                ts.isClassDeclaration(statement) ||
                ts.isTypeAliasDeclaration(statement) ||
                ts.isEnumDeclaration(statement);
            if (named && statement.name?.text === name) {
                return statement;
            }
        }
        return undefined;
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

        // `@Endpoint(httpMethod, path, operation, kind, options?)` — METHOD-FIRST, five positions.
        // The positions are read here and nowhere else, so the one place that has to change when the
        // decorator changes is this block plus `ARGUMENT_NAMES` beside it.
        const httpMethod = this.requiredArgument(call, methodName, 0, folder);
        const path = this.requiredArgument(call, methodName, 1, folder);
        const operation = this.requiredArgument(call, methodName, 2, folder);
        const kind = this.requiredArgument(call, methodName, 3, folder);

        const options = call.arguments[4];
        const literal =
            options !== undefined && ts.isObjectLiteralExpression(options) ? options : undefined;

        const doc = JsDoc.read(member);
        const mcpTool = ApiDocExtractor.mcpToolOf(member, folder);
        return new DocumentedEndpoint(
            methodName,
            httpMethod,
            path,
            operation,
            kind,
            ApiDocExtractor.booleanProperty(literal, 'hidden'),
            ApiDocExtractor.booleanProperty(literal, 'openWorld'),
            new DocumentedEndpointOptions(
                ApiDocExtractor.booleanProperty(literal, 'formPost'),
                ApiDocExtractor.stringProperty(literal, 'calledBy', folder),
                ApiDocExtractor.stringProperty(literal, 'callerKind', folder),
            ),
            ApiDocExtractor.authOf(member, folder),
            mcpTool,
            ApiDocExtractor.decoratorCall(member, MCP_AUTH)?.arguments[0]?.getText(),
            ApiDocExtractor.maskLogOf(member),
            doc.description,
            doc.mcp,
            this.requestOf(member, methodName, resolver),
            this.responseOf(member, methodName, resolver),
        );
    }

    /**
     * One REQUIRED positional argument of `@Endpoint`, folded to the string it denotes.
     *
     * Every one of the four is an enum member (`POST`, `READ`, `RPC`) as often as it is a literal,
     * and the folder resolves both — a document that printed `RPC` where the trigger goes would be
     * worse than no document. A missing one is a hard failure naming the position, because the
     * alternative is a document quietly missing a verb.
     */
    private requiredArgument(
        call: ts.CallExpression,
        methodName: string,
        index: number,
        folder: ConstantFolder,
    ): string {
        const argument = call.arguments[index];
        const what = ARGUMENT_NAMES[index];
        if (argument === undefined) {
            throw new ApiDocExtractionError(
                `@Endpoint on '${methodName}' declares no ${what}`,
                SourceLocation.of(call),
                "Write all four: @Endpoint(POST, '/thing', READ, RPC).",
            );
        }
        const value = folder.foldString(argument, `@Endpoint ${what} on '${methodName}'`);
        const allowed = ARGUMENT_VALUES[index]!;
        if (allowed.length > 0 && !allowed.includes(value)) {
            throw new ApiDocExtractionError(
                `@Endpoint on '${methodName}' declares ${what} '${value}', which is not one of ` +
                    allowed.join(', '),
                SourceLocation.of(argument),
                `Use one of the exported constants: ${allowed.join(', ')}.`,
            );
        }
        return value;
    }

    /**
     * `@ApiType(...)` on the contract, folded to the real values.
     *
     * A value that is not one of the three documents is a HARD FAILURE rather than a silent drop: a
     * contract that named `CUSTOMER` by mistake would otherwise feed nothing, which looks exactly
     * like a contract somebody deliberately kept internal.
     */
    private declaredApiTypes(node: ts.Node, folder: ConstantFolder): readonly string[] {
        const call = ApiDocExtractor.decoratorCall(node, API_TYPE);
        if (call === undefined) {
            return DEFAULT_API_TYPES;
        }
        const declared = call.arguments.map((argument: ts.Expression) =>
            folder.foldString(argument, `@${API_TYPE} argument`),
        );
        for (const apiType of declared) {
            if (!API_TYPES.includes(apiType)) {
                throw new ApiDocExtractionError(
                    `@${API_TYPE} names '${apiType}', which is not a generated document`,
                    SourceLocation.of(call),
                    `Use one of the exported constants: ${API_TYPES.join(', ')}.`,
                );
            }
        }
        return declared.length === 0 ? DEFAULT_API_TYPES : declared;
    }

    /**
     * MCP membership has exactly ONE spelling, and this is the build-time half of enforcing it
     * (`assertApiTypeMatchesMcpTools` in `@webpieces/core-util` is the wiring-time half).
     *
     * Declared in two places, the two can disagree — and the disagreement is invisible, because each
     * declaration is individually valid. That is the defect this whole epic exists to remove, so it
     * fails the DOCUMENT build rather than producing one that quietly lists the wrong tools.
     */
    private assertApiTypeMatchesMcpTools(
        contract: ts.ClassDeclaration,
        apiTypes: readonly string[],
        endpoints: readonly DocumentedEndpoint[],
    ): void {
        const tools = endpoints.filter((e: DocumentedEndpoint) => e.mcpTool !== undefined);
        const declaresMcp = apiTypes.includes(MCP);
        if (declaresMcp && tools.length === 0) {
            throw new ApiDocExtractionError(
                `@${API_TYPE} names MCP but no method carries @${MCP_TOOL}`,
                SourceLocation.of(contract),
                `Add @${MCP_TOOL}({name, description, openWorldHint}) to the methods agents may ` +
                    `call, or drop MCP from the @${API_TYPE} list.`,
            );
        }
        if (!declaresMcp && tools.length > 0) {
            const named = tools.map((e: DocumentedEndpoint) => e.methodName).join(', ');
            throw new ApiDocExtractionError(
                `@${MCP_TOOL} is on ${named} but @${API_TYPE} does not name MCP`,
                SourceLocation.of(contract),
                `Add MCP to the @${API_TYPE} list — membership has ONE spelling, so a tool on a ` +
                    'contract nobody published to agents is a contradiction, not a hint.',
            );
        }
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
    private static authOf(member: ts.Node, folder: ConstantFolder): DocumentedAuth | undefined {
        const decorators = ts.canHaveDecorators(member) ? (ts.getDecorators(member) ?? []) : [];
        for (const decorator of decorators) {
            const call = decorator.expression;
            if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) {
                continue;
            }
            const name = call.expression.text;
            if (name.startsWith(AUTH_PREFIX) && AUTH_DECORATORS.has(name)) {
                return new DocumentedAuth(
                    name,
                    call.arguments.map((argument: ts.Expression) => argument.getText()),
                    name === API_KEY_AUTH ? ApiDocExtractor.apiKeyOf(call, folder) : undefined,
                );
            }
        }
        return undefined;
    }

    /**
     * `@WpAuthApiKey(regime, [{in: 'header', name: 'x-api-key', description: '…'}, …])`, parsed.
     *
     * A malformed declaration FAILS rather than yielding a half-parsed regime: the credentials are
     * what a published document's security block is made of, and a document that silently omitted
     * one would tell a partner they need fewer credentials than the running hook demands.
     */
    // webpieces-disable no-function-outside-class -- private static reader of this class
    private static apiKeyOf(call: ts.CallExpression, folder: ConstantFolder): DocumentedApiKey {
        const regimeArgument = call.arguments[0];
        const credentialsArgument = call.arguments[1];
        if (regimeArgument === undefined || credentialsArgument === undefined) {
            throw new ApiDocExtractionError(
                '@WpAuthApiKey needs a regime AND its credentials',
                SourceLocation.of(call),
                "Write both: @WpAuthApiKey('partner', [{ in: 'header', name: 'x-api-key' }]).",
            );
        }
        const regime = folder.foldString(regimeArgument, '@WpAuthApiKey regime');
        // FOLLOW a name first: a credential list shared by every method of a contract is written
        // once as a `const` and named per method, which is better source than a copy per method.
        const credentialsLiteral = folder.follow(credentialsArgument);
        if (!ts.isArrayLiteralExpression(credentialsLiteral)) {
            throw new ApiDocExtractionError(
                '@WpAuthApiKey credentials is not an array literal',
                SourceLocation.of(credentialsArgument),
                'Write the credentials as an array literal, inline or in a `const`; a value ' +
                    'assembled at runtime cannot appear in a published security scheme.',
            );
        }
        const credentials: DocumentedApiKeyCredential[] = [];
        for (const element of credentialsLiteral.elements) {
            credentials.push(ApiDocExtractor.credentialOf(element, folder));
        }
        return new DocumentedApiKey(regime, credentials);
    }

    /** ONE `{ in: …, name?: …, description?: … }` credential. */
    // webpieces-disable no-function-outside-class -- private static reader of this class
    private static credentialOf(
        expression: ts.Expression,
        folder: ConstantFolder,
    ): DocumentedApiKeyCredential {
        const element = folder.follow(expression);
        if (!ts.isObjectLiteralExpression(element)) {
            throw new ApiDocExtractionError(
                'an @WpAuthApiKey credential is not an object literal',
                SourceLocation.of(element),
                "Write it inline: { in: 'header', name: 'x-api-key' }.",
            );
        }
        const location = ApiDocExtractor.stringProperty(element, 'in', folder);
        if (location === undefined) {
            throw new ApiDocExtractionError(
                'an @WpAuthApiKey credential declares no `in`',
                SourceLocation.of(element),
                "Say where it rides: `in: 'header'` with a name, or `in: 'bearer'`.",
            );
        }
        return new DocumentedApiKeyCredential(
            location,
            ApiDocExtractor.stringProperty(element, 'name', folder),
            ApiDocExtractor.stringProperty(element, 'description', folder),
        );
    }

    /**
     * `@WpMcpTool({ name, openWorldHint })` — the two facts the source cannot otherwise state.
     *
     * `description` is NOT read: the method's JSDoc is the description for the agent and the partner
     * alike. The three side-effect hints are not read either — they are computed from the endpoint's
     * `operation`. See {@link DocumentedMcpTool} for why both of those are deliberate.
     */
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
        return new DocumentedMcpTool(
            ApiDocExtractor.stringProperty(argument, 'name', folder) ?? '',
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
