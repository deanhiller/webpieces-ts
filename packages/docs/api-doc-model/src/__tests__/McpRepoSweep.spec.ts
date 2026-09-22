import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { ApiDocExtractor } from '../extract/ApiDocExtractor';
import { ApiDocModel, DocumentedEndpoint, DocumentedField } from '../model/ApiDocModel';
import { TypeRef } from '../model/TypeRef';
import { McpRenderError } from '../render/McpRenderError';
import { McpSchemaRenderer } from '../render/McpSchemaRenderer';

/**
 * THE REPO SWEEP half of the equivalence gate (#983).
 *
 * `McpEquivalence.spec.ts` proves the two readers agree, field for field, on a contract that declares
 * its shape BOTH ways. This file asks the other half of the question — *does that result generalise
 * to the contracts this repo actually has?* — over EVERY `@WpMcpTool` under `packages/**` and
 * `apps/**`.
 *
 * It is compiler-side only, deliberately. Running `DtoSchemaBuilder` against another package's
 * fixtures would mean importing `@webpieces/mcp-server` from a docs package, which puts the
 * TypeScript compiler in the dependency closure of every app that runs an MCP server. Everything this
 * file needs is in the SOURCE: the declared types on one side and the `@WpDtoField` arguments on the
 * other, both read with the same compiler. A `@WpDtoField` argument that lies about its field's type
 * is therefore caught here WITHOUT executing anything.
 *
 * ## It reports in three lists, and only one of them is a failure
 *
 * - **lies** — a `@WpDtoField` argument that contradicts the declared TypeScript type. These are real
 *   defects nothing else in the repo can see, and the list is asserted EMPTY.
 * - **blocked** — a tool whose schema the compiler cannot render today, with the reason. Asserted
 *   against an explicit list, so a new one shows up as a failure and a fixed one does too.
 * - **migration** — where the decorator's prose and the source's prose differ, or the source has
 *   none. Recorded, never failed: deleting the decorator's copy is #984's job, and this list IS that
 *   job, named file by file and field by field.
 *
 * ## Why a spec under a repo-agnostic package walks repo paths
 *
 * `responsibilities.md` keeps repo paths out of this package's `src`, and that constraint is about
 * the published SURFACE — `tsconfig.lib.json` excludes specs, so nothing here ships. The gate being
 * measured is a fact about THIS repo's contracts, so the measurement lives where the renderer does.
 */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const SWEPT_ROOTS = ['packages', 'apps'];
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.git', 'coverage', '.nx']);

/** ONE tool the sweep looked at, and whether the compiler could render its schemas. */
class ToolOutcome {
    constructor(
        readonly contract: string,
        readonly toolName: string,
        readonly blockedBy: string | undefined,
    ) {}

    toString(): string {
        return this.blockedBy === undefined
            ? `${this.contract}/${this.toolName}`
            : `${this.contract}/${this.toolName}: ${this.blockedBy}`;
    }
}

/** ONE place the decorator's prose and the source's prose are not the same string. */
class MigrationItem {
    constructor(
        readonly where: string,
        readonly decorator: string,
        readonly source: string,
    ) {}

    toString(): string {
        return `${this.where}: decorator=${JSON.stringify(this.decorator)} source=${JSON.stringify(this.source)}`;
    }
}

/** ONE `@WpDtoField` argument that contradicts the field's declared TypeScript type. */
class ContractLie {
    constructor(
        readonly where: string,
        readonly argument: string,
        readonly decorator: string,
        readonly compiler: string,
    ) {}

    toString(): string {
        return `${this.where} ${this.argument}: decorator=${this.decorator} compiler=${this.compiler}`;
    }
}

/** The `@WpDtoField` arguments of ONE field, as written in the source. */
class DeclaredField {
    constructor(
        readonly dto: string,
        readonly name: string,
        readonly description: string,
        readonly required: boolean | undefined,
        readonly arrayItems: string | undefined,
        readonly mapValues: string | undefined,
        readonly integer: boolean,
        readonly minimum: number | undefined,
        readonly maximum: number | undefined,
        readonly enumValues: readonly string[] | undefined,
        readonly mcpHeader: string | undefined,
    ) {}
}

class Sweep {
    readonly tools: ToolOutcome[] = [];
    readonly migration: MigrationItem[] = [];
    readonly lies: ContractLie[] = [];
    readonly files: string[] = [];

    run(): void {
        const found = Sweep.filesDeclaringTools();
        this.files.push(...found.map((file: string) => path.relative(REPO_ROOT, file)));
        const program = ts.createProgram(found, Sweep.compilerOptions());
        const extractor = new ApiDocExtractor();
        for (const file of found) {
            const source = program.getSourceFile(file);
            if (source === undefined) {
                throw new Error(`swept file is not in the program: ${file}`);
            }
            const models = extractor.extractAllFrom(program, source);
            for (const model of models) {
                this.sweepContract(model, source);
            }
            this.sweepDtos(models, source);
        }
    }

    /** Every tool of one contract: its prose, and whether its schemas render. */
    private sweepContract(model: ApiDocModel, source: ts.SourceFile): void {
        for (const endpoint of model.endpoints) {
            if (endpoint.mcpTool === undefined) {
                continue;
            }
            this.recordToolProse(model, endpoint, source);
            this.tools.push(
                new ToolOutcome(
                    model.contractName,
                    endpoint.mcpTool.name,
                    Sweep.renderFailure(model, endpoint),
                ),
            );
        }
    }

    /**
     * Render ONE tool, by handing the renderer a model holding that endpoint alone.
     *
     * Per-TOOL and not per-contract because the report has to name the tool that cannot be published;
     * a contract-level catch would blame all seven of `McpRemoteFixtures`' tools for one of them.
     */
    // webpieces-disable no-function-outside-class -- private static helper of this class
    private static renderFailure(
        model: ApiDocModel,
        endpoint: DocumentedEndpoint,
    ): string | undefined {
        const single = new ApiDocModel(
            model.contractName,
            model.apiTypes,
            model.basePath,
            model.description,
            [endpoint],
            model.types,
            model.unmapped,
        );
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- the throw IS the measurement
        try {
            new McpSchemaRenderer(single).render();
            return undefined;
        } catch (err: unknown) {
            //const error = toError(err);
            return err instanceof McpRenderError ? err.message : String(err);
        }
    }

    /** `@WpMcpTool({description})` against the method's JSDoc — the tool-level migration item. */
    private recordToolProse(
        model: ApiDocModel,
        endpoint: DocumentedEndpoint,
        source: ts.SourceFile,
    ): void {
        const declared = Sweep.toolDescriptionOf(source, model.contractName, endpoint.methodName);
        const compiled = endpoint.mcpDescription ?? endpoint.description;
        if (declared !== undefined && declared !== compiled) {
            this.migration.push(
                new MigrationItem(
                    `${model.contractName}.${endpoint.methodName}`,
                    declared,
                    compiled,
                ),
            );
        }
    }

    /** Every `@WpDto` class in the file, compared argument by argument with the compiler's view. */
    private sweepDtos(models: readonly ApiDocModel[], source: ts.SourceFile): void {
        for (const declaration of source.statements) {
            if (!ts.isClassDeclaration(declaration) || declaration.name === undefined) {
                continue;
            }
            if (Sweep.decoratorCall(declaration, 'WpDto') === undefined) {
                continue;
            }
            const dto = declaration.name.text;
            for (const model of models) {
                const type = model.types.get(dto);
                if (type === undefined) {
                    continue;
                }
                for (const declared of Sweep.declaredFieldsOf(declaration, dto)) {
                    const field = type.fields.find(
                        (each: DocumentedField) => each.name === declared.name,
                    );
                    if (field === undefined) {
                        this.lies.push(
                            new ContractLie(
                                `${dto}.${declared.name}`,
                                'field',
                                'declared',
                                'absent from the compiler view',
                            ),
                        );
                        continue;
                    }
                    this.compareField(declared, field);
                }
                break;
            }
        }
    }

    private compareField(declared: DeclaredField, field: DocumentedField): void {
        const where = `${declared.dto}.${declared.name}`;
        if (declared.description !== field.description) {
            this.migration.push(new MigrationItem(where, declared.description, field.description));
        }
        if (declared.required !== undefined && declared.required === field.optional) {
            this.lies.push(
                new ContractLie(
                    where,
                    'required',
                    String(declared.required),
                    field.optional ? 'optional (`?`)' : 'required',
                ),
            );
        }
        this.compareArray(declared, field, where);
        this.compareMap(declared, field, where);
        this.compareNumeric(declared, field, where);
        this.compareEnum(declared, field, where);
        if (declared.mcpHeader !== field.mcpHeader) {
            this.lies.push(
                new ContractLie(
                    where,
                    'mcpHeader',
                    declared.mcpHeader ?? 'absent',
                    field.mcpHeader ?? 'absent',
                ),
            );
        }
    }

    private compareArray(declared: DeclaredField, field: DocumentedField, where: string): void {
        const isArray = field.type.kind === 'array';
        if (declared.arrayItems === undefined) {
            if (isArray) {
                this.lies.push(new ContractLie(where, 'arrayItems', 'absent', 'an array type'));
            }
            return;
        }
        if (!isArray) {
            this.lies.push(
                new ContractLie(where, 'arrayItems', declared.arrayItems, `a ${field.type.kind}`),
            );
            return;
        }
        this.compareElement(declared.arrayItems, field.type.items!, where, 'arrayItems');
    }

    private compareMap(declared: DeclaredField, field: DocumentedField, where: string): void {
        const isMap = field.type.kind === 'openMap';
        if (declared.mapValues === undefined) {
            if (isMap) {
                this.lies.push(new ContractLie(where, 'mapValues', 'absent', 'a Record type'));
            }
            return;
        }
        if (!isMap) {
            this.lies.push(
                new ContractLie(where, 'mapValues', declared.mapValues, `a ${field.type.kind}`),
            );
            return;
        }
        this.compareElement(declared.mapValues, field.type.values!, where, 'mapValues');
    }

    /** `'string' | 'number' | 'integer' | 'boolean' | SomeDto` against the resolved element type. */
    private compareElement(
        element: string,
        resolved: TypeRef,
        where: string,
        argument: string,
    ): void {
        const actual = Sweep.elementName(resolved);
        if (element !== actual) {
            this.lies.push(new ContractLie(where, argument, element, actual));
        }
    }

    // webpieces-disable no-function-outside-class -- private static helper of this class
    private static elementName(ref: TypeRef): string {
        if (ref.kind === 'ref') {
            return ref.refName!;
        }
        if (ref.kind === 'primitive' && ref.primitive === 'number') {
            return ref.integer ? 'integer' : 'number';
        }
        if (ref.kind === 'primitive') {
            return ref.primitive!;
        }
        return ref.kind;
    }

    private compareNumeric(declared: DeclaredField, field: DocumentedField, where: string): void {
        const leaf = field.type;
        const integer = leaf.kind === 'primitive' && leaf.primitive === 'number' && leaf.integer;
        // An ARRAY's integer-ness is carried by `arrayItems: 'integer'`, not by this flag — the
        // runtime rejects `integer: true` on a non-Number field — so `compareArray` owns that case.
        if (field.type.kind !== 'array' && declared.integer !== integer) {
            this.lies.push(
                new ContractLie(
                    where,
                    'integer',
                    String(declared.integer),
                    integer ? 'Integer / @WpInt()' : 'a plain number',
                ),
            );
        }
        if (declared.minimum !== field.min) {
            this.lies.push(
                new ContractLie(
                    where,
                    'minimum',
                    String(declared.minimum),
                    String(field.min ?? 'absent'),
                ),
            );
        }
        if (declared.maximum !== field.max) {
            this.lies.push(
                new ContractLie(
                    where,
                    'maximum',
                    String(declared.maximum),
                    String(field.max ?? 'absent'),
                ),
            );
        }
    }

    private compareEnum(declared: DeclaredField, field: DocumentedField, where: string): void {
        if (declared.enumValues === undefined) {
            return;
        }
        const resolved = field.type.kind === 'enum' ? field.type.enumValues : [];
        if (declared.enumValues.join(',') !== resolved.join(',')) {
            this.lies.push(
                new ContractLie(
                    where,
                    'enumValues',
                    declared.enumValues.join('|'),
                    resolved.length === 0 ? 'not a string-literal union' : resolved.join('|'),
                ),
            );
        }
    }

    /** Every `.ts` under the swept roots whose text names `@WpMcpTool(`. */
    // webpieces-disable no-function-outside-class -- private static collector of this class
    private static filesDeclaringTools(): string[] {
        const found: string[] = [];
        for (const root of SWEPT_ROOTS) {
            Sweep.walk(path.join(REPO_ROOT, root), found);
        }
        return found.sort();
    }

    // webpieces-disable no-function-outside-class -- private static collector of this class
    private static walk(directory: string, found: string[]): void {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                if (!SKIP_DIRECTORIES.has(entry.name)) {
                    Sweep.walk(full, found);
                }
                continue;
            }
            // A `.spec.ts` is skipped on purpose: `api-type.spec.ts` declares contracts that
            // deliberately BREAK the MCP biconditional in order to assert that the assert fires, and
            // a negative fixture is not a contract this repo publishes.
            if (!entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts')) {
                continue;
            }
            const text = fs.readFileSync(full, 'utf8');
            // BOTH markers, and `@ApiPath` only at COLUMN ZERO: this package's own docstrings show
            // `@ApiPath('/stores')` inside a ` * ` comment, and a file that only TALKS about a
            // contract declares none. An indented match would put five docstrings in the inventory.
            if (text.includes('@WpMcpTool(') && /^@ApiPath\(/m.test(text)) {
                found.push(full);
            }
        }
    }

    /** `tsconfig.base.json`'s `paths`, so an `@webpieces/*` import in a swept file RESOLVES. */
    // webpieces-disable no-function-outside-class -- private static configuration of this class
    private static compilerOptions(): ts.CompilerOptions {
        const base = ts.readConfigFile(path.join(REPO_ROOT, 'tsconfig.base.json'), ts.sys.readFile);
        const parsed = ts.parseJsonConfigFileContent(base.config, ts.sys, REPO_ROOT);
        return { ...parsed.options, noEmit: true, skipLibCheck: true, types: [] };
    }

    // webpieces-disable no-function-outside-class -- private static reader of this class
    private static toolDescriptionOf(
        source: ts.SourceFile,
        contractName: string,
        methodName: string,
    ): string | undefined {
        for (const statement of source.statements) {
            if (!ts.isClassDeclaration(statement) || statement.name?.text !== contractName) {
                continue;
            }
            for (const member of statement.members) {
                if (
                    !ts.isMethodDeclaration(member) ||
                    !ts.isIdentifier(member.name) ||
                    member.name.text !== methodName
                ) {
                    continue;
                }
                const argument = Sweep.decoratorCall(member, 'WpMcpTool')?.arguments[0];
                if (argument !== undefined && ts.isObjectLiteralExpression(argument)) {
                    return Sweep.stringProperty(argument, 'description');
                }
            }
        }
        return undefined;
    }

    /** Every `@WpDtoField(new Wp*FieldOptions(...))` on one class, parsed positionally. */
    // webpieces-disable no-function-outside-class -- private static reader of this class
    private static declaredFieldsOf(
        declaration: ts.ClassDeclaration,
        dto: string,
    ): DeclaredField[] {
        const fields: DeclaredField[] = [];
        for (const member of declaration.members) {
            if (!ts.isPropertyDeclaration(member) || !ts.isIdentifier(member.name)) {
                continue;
            }
            const argument = Sweep.decoratorCall(member, 'WpDtoField')?.arguments[0];
            if (argument === undefined || !ts.isNewExpression(argument)) {
                continue;
            }
            const args = argument.arguments ?? ts.factory.createNodeArray<ts.Expression>([]);
            const map = argument.expression.getText() === 'WpDtoMapFieldOptions';
            fields.push(
                new DeclaredField(
                    dto,
                    member.name.text,
                    Sweep.literalString(args[0]) ?? '',
                    Sweep.literalBoolean(args[1]),
                    map ? undefined : Sweep.elementText(args[2]),
                    map ? Sweep.elementText(args[2]) : undefined,
                    map ? false : (Sweep.literalBoolean(args[3]) ?? false),
                    map ? undefined : Sweep.literalNumber(args[4]),
                    map ? undefined : Sweep.literalNumber(args[5]),
                    map ? undefined : Sweep.literalStrings(args[6]),
                    map ? undefined : Sweep.headerName(args[7]),
                ),
            );
        }
        return fields;
    }

    // webpieces-disable no-function-outside-class -- private static reader of this class
    private static elementText(node: ts.Expression | undefined): string | undefined {
        if (node === undefined) {
            return undefined;
        }
        if (ts.isStringLiteralLike(node)) {
            return node.text;
        }
        if (ts.isIdentifier(node)) {
            return node.text === 'undefined' ? undefined : node.text;
        }
        return undefined;
    }

    // webpieces-disable no-function-outside-class -- private static reader of this class
    private static headerName(node: ts.Expression | undefined): string | undefined {
        if (node === undefined || !ts.isNewExpression(node)) {
            return undefined;
        }
        return Sweep.literalString(node.arguments?.[0]);
    }

    // webpieces-disable no-function-outside-class -- private static reader of this class
    private static literalStrings(node: ts.Expression | undefined): readonly string[] | undefined {
        const unwrapped = node !== undefined && ts.isAsExpression(node) ? node.expression : node;
        if (unwrapped === undefined || !ts.isArrayLiteralExpression(unwrapped)) {
            return undefined;
        }
        const values: string[] = [];
        for (const element of unwrapped.elements) {
            const text = Sweep.literalString(element);
            if (text !== undefined) {
                values.push(text);
            }
        }
        return values;
    }

    // webpieces-disable no-function-outside-class -- private static reader of this class
    private static literalString(node: ts.Expression | undefined): string | undefined {
        return node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined;
    }

    // webpieces-disable no-function-outside-class -- private static reader of this class
    private static literalBoolean(node: ts.Expression | undefined): boolean | undefined {
        if (node?.kind === ts.SyntaxKind.TrueKeyword) {
            return true;
        }
        if (node?.kind === ts.SyntaxKind.FalseKeyword) {
            return false;
        }
        return undefined;
    }

    // webpieces-disable no-function-outside-class -- private static reader of this class
    private static literalNumber(node: ts.Expression | undefined): number | undefined {
        if (node !== undefined && ts.isNumericLiteral(node)) {
            return Number(node.text);
        }
        if (
            node !== undefined &&
            ts.isPrefixUnaryExpression(node) &&
            node.operator === ts.SyntaxKind.MinusToken &&
            ts.isNumericLiteral(node.operand)
        ) {
            return -Number(node.operand.text);
        }
        return undefined;
    }

    // webpieces-disable no-function-outside-class -- private static reader of this class
    private static stringProperty(
        literal: ts.ObjectLiteralExpression,
        name: string,
    ): string | undefined {
        for (const property of literal.properties) {
            if (
                ts.isPropertyAssignment(property) &&
                ts.isIdentifier(property.name) &&
                property.name.text === name
            ) {
                return Sweep.literalString(property.initializer);
            }
        }
        return undefined;
    }

    // webpieces-disable no-function-outside-class -- private static reader of this class
    private static decoratorCall(node: ts.Node, name: string): ts.CallExpression | undefined {
        const decorators = ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
        for (const decorator of decorators) {
            const call = decorator.expression;
            if (
                ts.isCallExpression(call) &&
                ts.isIdentifier(call.expression) &&
                call.expression.text === name
            ) {
                return call;
            }
        }
        return undefined;
    }
}

describe('every @WpMcpTool in this repo, read by the compiler', () => {
    const sweep = new Sweep();

    beforeAll(() => {
        sweep.run();
    }, 120_000);

    it('finds every contract file that declares MCP tools', () => {
        expect(sweep.files).toEqual([
            'apps/app-example/partner-api/src/PartnerOrdersApi.ts',
            'packages/docs/api-doc-model/src/__tests__/fixtures/ExampleApi.ts',
            'packages/docs/api-doc-model/src/__tests__/fixtures/McpEquivalenceApi.ts',
            'packages/docs/openapi-generator/src/__tests__/fixtures/WidgetsApi.ts',
            'packages/http/mcp-server/src/__tests__/McpRemoteFixtures.ts',
            'packages/http/mcp-server/src/__tests__/WpMcpServerTestFixtures.ts',
        ]);
    });

    it('no @WpDtoField argument contradicts its declared TypeScript type', () => {
        expect(sweep.lies.map(String)).toEqual([]);
    });

    it('records which tools the compiler can render, and why the rest cannot', () => {
        expect(sweep.tools.map(String)).toEqual([
            // A DISCRIMINATED UNION. MCP's input schema is one flat object with no `oneOf`, so this
            // tool cannot be published as it stands — and the same contract could never be
            // REGISTERED either: its DTOs are interfaces with no `@WpDto`, so `DtoSchemaBuilder`
            // refuses them. Compiler and runtime agree it is not publishable, for different reasons.
            'PartnerOrdersApi/fetch_orders: a union has no MCP input-schema shape (Order.window)',
            // An UNDOCUMENTED field. An MCP parameter with no prose is one an agent has nothing to
            // go on for, so the renderer refuses rather than publishing a nameless hole.
            'ExampleApi/save_customer: a published DTO field has no documentation (SaveRequest.customer)',
            'McpEquivalenceApi/lookup_orders',
            'McpEquivalenceApi/cancel_order',
            'McpEquivalenceApi/reindex_store',
            'WidgetsApi/list_widgets: a published DTO field has no documentation (ListWidgetsResponse.widgets)',
            'RemoteMcpApi/remote_integration_search',
            'MissingRemoteMcpApi/missing_remote_integration_search',
            'RefusedRemoteApi/refused_remote',
            'GarbageRemoteApi/garbage_remote',
            'OidcFailRemoteApi/oidc_fail_remote',
            'LocalThrowApi/local_throw',
            'RemoteThrowApi/remote_throw',
            'SearchApi/account_search',
            'SearchApi/admin_search',
            'RemoteSearchApi/remote_search',
        ]);
    });

    it('records the #984 migration list: decorator prose vs source prose', () => {
        expect(sweep.migration.map(String)).toEqual([
            'PartnerOrdersApi.fetchOrders: decorator="Fetch recent orders for one store." ' +
                'source="Read-only. Call this before answering any question about recent orders; ' +
                'do not reuse an\\nearlier answer, order state changes minute to minute."',
            'ExampleApi.save: decorator="Create or update one customer." ' +
                'source="Create or update one customer record. Safe to retry."',
            'WidgetsApi.list: decorator="List widgets." ' +
                'source="Read-only. Prefer this over guessing from an earlier answer."',
        ]);
    });
});
