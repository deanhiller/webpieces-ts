/**
 * The pure VERDICTS the api-contract rules print, split out of `api-doc-rules-scan.ts`, which owns
 * the walk and is at its file-size limit.
 *
 * Nothing here touches the filesystem or the project graph. Each function answers one question about
 * ONE declaration the extractor or the renderer has already ruled on, and turns it into the two
 * halves every webpieces refusal carries — what is wrong, and what to do instead. The DECISION is
 * never made here: `model.unmapped` is the extractor's and a render failure is the renderer's. What
 * this file adds is the WORDING, which is the part a generic "no model representation for this type
 * form" cannot give an author.
 */

import * as ts from 'typescript';
import {
    ApiDocModel,
    DocumentedEndpoint,
    McpRenderError,
    McpSchemaRenderer,
    TypeRef,
    UnmappedType,
} from '@webpieces/api-doc-model';
import { EndpointKind } from './api-relations';

/**
 * The one trigger kind an MCP tool may have. A LITERAL, for the same reason `EndpointKind` beside it
 * is one: this package deliberately does not depend on `@webpieces/core-util` at runtime, and the
 * set the literal belongs to is pinned by that type.
 */
export const RPC_KIND: EndpointKind = 'rpc';

/**
 * The endpoint kinds whose response a caller WAITS FOR, and which therefore must name a DTO (#1017).
 *
 * `rpc` and `external` are both synchronous request/response: somebody posts and reads what comes
 * back, so there IS a body and it must be a named type that can gain a field later. `void` on either
 * is a one-way door — a `void` response can never grow without breaking every generated client, where
 * an empty DTO grows additively forever. #1016 refused it on `rpc` only, because `external` was
 * unstated at the time; it is stated now.
 *
 * `cloudtasks` and `cron` are deliberately NOT here: delivery is fire-and-forget, nobody waits for a
 * body, and `Promise<void>` is the CONTRACT rather than an omission.
 */
export const ANSWERING_KINDS: readonly EndpointKind[] = ['rpc', 'external'];

/** The scalar keywords a MIXED SCALAR union is made of. */
const SCALAR_KEYWORDS = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.StringKeyword,
    ts.SyntaxKind.NumberKeyword,
    ts.SyntaxKind.BooleanKeyword,
]);

/** ONE reason a declaration is refused, in the two halves every refusal prints. */
export class Verdict {
    constructor(
        public readonly what: string,
        public readonly cure: string,
    ) {}
}


/** Method name -> the line its declaration starts on, for one contract class. */
export class ContractLines {
    constructor(
        public readonly classLine: number,
        public readonly byMethod: ReadonlyMap<string, number>,
        /** Methods carrying `@WpMcpTool` that do NOT also carry `@Endpoint`. */
        public readonly toolsWithoutEndpoint: readonly string[],
    ) {}

    lineOf(methodName: string): number {
        return this.byMethod.get(methodName) ?? this.classLine;
    }
}


/**
 * The cure for an `unknown` value, for whichever rule is REPORTING it.
 *
 * It takes the rule name rather than naming one, because this defect is shared: it blocks the
 * OpenAPI document, so `DefectSink` routes it to `api-rules-for-openapi` when that rule is running
 * and to `api-rules-for-mcp` when it is the only one. A hard-coded rule name would then hand an
 * author, on the mcp-only configuration, a `// webpieces-disable api-rules-for-openapi` line that
 * the collector reading the site does not look for — a cure that does not cure, which is the one
 * failure mode a printed cure must not have.
 */
// webpieces-disable no-function-outside-class -- pure message builder, beside the verdicts that print it
export function unknownValueCure(rule: string): string {
    return (
        'Name the value type — a DTO, an array of one, a string-literal union, or ' +
        'Record<string, ThatDto>. If the shape really is unknowable (a transport envelope, ' +
        'arbitrary SQL rows), write the per-site disable and say so: ' +
        `// webpieces-disable ${rule} -- <why this field is published with no shape>. ` +
        'An existing no-any-unknown disable does NOT count — that rule asked whether the code is ' +
        'type-safe, which is a different question from whether a partner is handed a shapeless field.'
    );
}

/** The one cure for a `void` endpoint that somebody is WAITING on (rpc or external). */
export const VOID_RPC_CURE =
    'Declare a named response DTO and return Promise<That>, even when it has no fields today: an ' +
    'empty object grows additively forever, and a void response cannot gain a field without ' +
    'breaking every generated client. An external endpoint is a synchronous call an outside caller ' +
    'waits on, so it has a body too — an empty one serializes as {} and the failure detail rides on ' +
    'the thrown error. Promise<void> stays legal on a cloudtasks or cron endpoint, where ' +
    'fire-and-forget is the contract.';

/**
 * Why the resolver could not map this type, said in the author's vocabulary.
 *
 * The DECISION to refuse is the extractor's and is not second-guessed here — every entry in
 * `model.unmapped` becomes a defect. What this adds is the MESSAGE: an open enum and a mixed scalar
 * union are the two shapes a real repo actually hits (measured: 6 of 98 endpoints, from exactly
 * these two), and "no model representation for this type form" tells their author nothing.
 */
// webpieces-disable no-function-outside-class -- pure classifier over the extractor's own verdict
export function classifyUnmapped(unmapped: UnmappedType): Verdict {
    const branches = unionBranchesOf(unmapped.typeText);
    if (isOpenEnum(branches)) {
        return new Verdict(
            `'${unmapped.typeText}' is an OPEN ENUM — literals unioned with the wide type`,
            'Use an enum OR a string, not both. TypeScript COLLAPSES this union to the wide type, ' +
                'so the literals buy no compile-time safety and a document cannot state them as a ' +
                "closed set. Either drop the `| string` (`'a' | 'b'` publishes as a real enum), or " +
                'drop the literals and list the known values in the JSDoc.',
        );
    }
    if (isMixedScalarUnion(branches)) {
        return new Verdict(
            `'${unmapped.typeText}' is a MIXED SCALAR union`,
            'Give the field ONE type. JSON Schema can spell {"type": ["string","number"]}, but ' +
                'this framework\'s ApiJsonSchema helpers read a type array as "one real type plus ' +
                'maybe null" (baseTypeOf returns the first non-null member), so publishing it ' +
                'would VALIDATE WRONGLY — which is worse than refusing it. Pick the type, or wrap ' +
                'the alternatives in a discriminated union of named objects.',
        );
    }
    return new Verdict(
        `'${unmapped.typeText}' has no shape a document can state — ${unmapped.reason}`,
        'Give it a type a document can carry: a named DTO, an array of one, a string-literal ' +
            'union, a Record<string, ThatDto>, or a primitive. A field with no shape publishes as ' +
            '"anything".',
    );
}

/** The branches of `typeText` when it parses as a union, else an empty list. */
// webpieces-disable no-function-outside-class -- pure parser used by classifyUnmapped alone
function unionBranchesOf(typeText: string): readonly ts.TypeNode[] {
    const parsed = ts.createSourceFile(
        '__unmapped.ts',
        `type __X = ${typeText};`,
        ts.ScriptTarget.Latest,
        true,
    );
    const alias = parsed.statements[0];
    if (alias === undefined || !ts.isTypeAliasDeclaration(alias)) return [];
    if (!ts.isUnionTypeNode(alias.type)) return [];
    return alias.type.types.filter((branch: ts.TypeNode) => !isNullishBranch(branch));
}

/** `'a' | 'b' | string`, and the numeric equivalent. See #1010 and the decision on #1011. */
// webpieces-disable no-function-outside-class -- pure predicate beside classifyUnmapped
function isOpenEnum(branches: readonly ts.TypeNode[]): boolean {
    const wide = branches.some(
        (branch: ts.TypeNode) =>
            branch.kind === ts.SyntaxKind.StringKeyword ||
            branch.kind === ts.SyntaxKind.NumberKeyword,
    );
    const literals = branches.some((branch: ts.TypeNode) => ts.isLiteralTypeNode(branch));
    return wide && literals;
}

/** `string | number`, `string | boolean | null` — two or more DIFFERENT scalar keywords. */
// webpieces-disable no-function-outside-class -- pure predicate beside classifyUnmapped
function isMixedScalarUnion(branches: readonly ts.TypeNode[]): boolean {
    if (branches.length < 2) return false;
    const kinds = new Set<ts.SyntaxKind>();
    for (const branch of branches) {
        if (!SCALAR_KEYWORDS.has(branch.kind)) return false;
        kinds.add(branch.kind);
    }
    return kinds.size >= 2;
}

/** `null` / `undefined` branches — nullability, not composition, exactly as the resolver reads it. */
// webpieces-disable no-function-outside-class -- pure predicate beside classifyUnmapped
function isNullishBranch(node: ts.TypeNode): boolean {
    if (node.kind === ts.SyntaxKind.UndefinedKeyword || node.kind === ts.SyntaxKind.NullKeyword) {
        return true;
    }
    return ts.isLiteralTypeNode(node) && node.literal.kind === ts.SyntaxKind.NullKeyword;
}

/**
 * True when this type PUBLISHES an `unknown` value.
 *
 * It looks at the VALUE TYPE wherever it sits — the item of an array, the value of an open map, the
 * field itself — and never at the `Record<>` spelling, because the real cases in the wild are not
 * all Records: `params?: unknown[]` is the same defect written differently.
 *
 * It does NOT descend through a `ref`: a named DTO is its own entry in the model and its own fields
 * are judged there, so descending would report the same field once per type that points at it.
 */
// webpieces-disable no-function-outside-class -- pure predicate over one TypeRef
export function carriesUnknown(ref: TypeRef): boolean {
    if (ref.kind === 'primitive') return ref.primitive === 'unknown';
    if (ref.kind === 'array') return carriesUnknown(ref.items!);
    if (ref.kind === 'openMap') return carriesUnknown(ref.values!);
    return false;
}

/**
 * `void`, `unknown` and `any` all reach the model as the same primitive — the resolver maps the
 * three keywords onto one, because to a document they say the identical thing: nothing.
 */
// webpieces-disable no-function-outside-class -- pure predicate over one TypeRef
export function isVoidLike(ref: TypeRef): boolean {
    return ref.kind === 'primitive' && ref.primitive === 'unknown';
}

/**
 * Every reason this tool could not be served, in the order `McpToolRegistry` asks them at boot —
 * unique name, trigger kind, HTTP auth, MCP auth — and then the renderer's own verdict.
 *
 * The registry's four are restated from the model rather than driven, because they are decorator
 * PRESENCE facts the model already carries verbatim; the SCHEMA question is the one with a real
 * implementation behind it, and that one is driven.
 */
// webpieces-disable no-function-outside-class, max-lines-new-methods -- pure judge over one endpoint, and the four boot checks read as one list
export function toolFailures(
    endpoint: DocumentedEndpoint,
    renderer: McpSchemaRenderer,
    toolNames: Map<string, string>,
    model: ApiDocModel,
): readonly Verdict[] {
    const found: Verdict[] = [];
    const toolName = endpoint.mcpTool!.name;
    const claimed = toolNames.get(toolName);
    if (claimed === undefined) {
        toolNames.set(toolName, `${model.contractName}.${endpoint.methodName}`);
    } else {
        found.push(
            new Verdict(
                `tool name '${toolName}' is already declared by ${claimed}`,
                'Tool names are the protocol identity and are globally unique — rename one of the ' +
                    'two @WpMcpTool declarations.',
            ),
        );
    }
    if (endpoint.kind !== RPC_KIND) {
        found.push(
            new Verdict(
                `an MCP tool is declared on a '${endpoint.kind}' endpoint`,
                'Only an RPC endpoint can be a tool — a cloudtasks, cron or external endpoint is ' +
                    'driven by something other than a caller. Make it RPC, or drop the @WpMcpTool.',
            ),
        );
    }
    if (endpoint.auth === undefined) {
        found.push(
            new Verdict(
                'an MCP tool declares no HTTP auth',
                'Put a @WpAuth... decorator on the method. The MCP server refuses to boot without ' +
                    'one, because a tool with no credential is an unauthenticated endpoint an ' +
                    'agent can call.',
            ),
        );
    }
    if (endpoint.mcpAuthText === undefined) {
        found.push(
            new Verdict(
                'an MCP tool does not declare @WpMcpAuthJwt(...)',
                'Add @WpMcpAuthJwt(...) beside the HTTP auth. MCP authorization is rechecked ' +
                    'before the endpoint boundary and is declared separately on purpose.',
            ),
        );
    }
    const rendered = renderFailure(renderer, endpoint);
    if (rendered !== undefined) found.push(rendered);
    return found;
}

/**
 * The renderer's own refusal for one tool, or undefined when it renders.
 *
 * This is the whole acceptance contract for the MCP half: "passes the rule" and "renders a tool" are
 * the SAME statement, because the rule asks the renderer. It covers the method's missing JSDoc,
 * every reachable DTO field's missing JSDoc, a request or response that is not a named object, a
 * root-level union, a recursive DTO, an `unknown` leaf and a malformed `@mcpHeader` — none of which
 * is restated here.
 *
 * One verdict per tool, because the renderer stops at the first thing it cannot draw. A tool blocked
 * by several undocumented fields is therefore fixed a round at a time, which is the price of having
 * exactly one definition of renderable rather than a second walk that could disagree with it.
 */
// webpieces-disable no-function-outside-class -- pure judge beside toolFailures
function renderFailure(
    renderer: McpSchemaRenderer,
    endpoint: DocumentedEndpoint,
): Verdict | undefined {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- the render refusal IS the verdict
    try {
        renderer.tool(endpoint);
        return undefined;
    } catch (err: unknown) {
        //const error = toError(err);
        if (!(err instanceof McpRenderError)) throw err;
        return new Verdict(`${err.message} — no MCP schema could be built`, err.cure);
    }
}

/** Every `@ApiPath` class name declared at the top level of a file, in declaration order. */
// webpieces-disable no-function-outside-class -- pure AST reader
export function contractNamesIn(source: ts.SourceFile): string[] {
    const names: string[] = [];
    for (const statement of source.statements) {
        if (!ts.isClassDeclaration(statement) || statement.name === undefined) continue;
        if (hasDecoratorNamed(statement, 'ApiPath')) names.push(statement.name.text);
    }
    return names;
}

/**
 * Where each method of one contract starts, and which of them carry `@WpMcpTool` without
 * `@Endpoint`.
 *
 * The line numbers exist because the MCP failures come from the RENDERER, whose location is a NAME
 * (`Order.window`) rather than a file offset — it publishes a schema, not a diagnostic. Anchoring
 * every tool failure at its METHOD is also where an author would write the disable: "this tool is
 * deliberately not renderable" is a decision about the method, not about a field three DTOs down.
 */
// webpieces-disable no-function-outside-class -- pure AST reader beside contractNamesIn
export function contractLinesOf(source: ts.SourceFile, contractName: string): ContractLines {
    for (const statement of source.statements) {
        if (!ts.isClassDeclaration(statement) || statement.name?.text !== contractName) continue;
        const byMethod = new Map<string, number>();
        const orphanTools: string[] = [];
        for (const member of statement.members) {
            if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue;
            byMethod.set(member.name.text, lineOf(source, member));
            if (hasDecoratorNamed(member, 'WpMcpTool') && !hasDecoratorNamed(member, 'Endpoint')) {
                orphanTools.push(member.name.text);
            }
        }
        return new ContractLines(lineOf(source, statement), byMethod, orphanTools);
    }
    return new ContractLines(1, new Map<string, number>(), []);
}

/** 1-based line of a node's first token, decorators excluded. */
// webpieces-disable no-function-outside-class -- pure AST reader
function lineOf(source: ts.SourceFile, node: ts.Node): number {
    return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

/** True when `node` carries `@name(...)`. Matched on the syntax, like every reader in this file. */
// webpieces-disable no-function-outside-class -- pure AST reader
function hasDecoratorNamed(node: ts.Node, name: string): boolean {
    const decorators = ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
    for (const decorator of decorators) {
        const call = decorator.expression;
        if (
            ts.isCallExpression(call) &&
            ts.isIdentifier(call.expression) &&
            call.expression.text === name
        ) {
            return true;
        }
    }
    return false;
}
