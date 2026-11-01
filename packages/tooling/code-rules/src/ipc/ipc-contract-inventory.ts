/**
 * The type-checked read of the IPC contract library (#1389), shared by `ipc-pairing` and
 * `ipc-protocol-fingerprint`. Its `ts.Program` is rooted at the configured contract files ALONE (plus the
 * wire table file), so the program holds the contract library and what it imports — never the endpoint
 * apps, never an unrelated project. `types: []` keeps every ambient `@types/*` package out as well.
 *
 * The checker is what makes a wire table row like `{ wire: AUDIO_PLAY, direction: WireDirectionDto.NATIVE }`
 * readable: both are resolved to their literal values, exactly as the replaced script read them.
 */

import * as path from 'path';
import * as ts from 'typescript';
import { InformAiError } from '@webpieces/tooling-common';
import { IpcContractNames, IpcContractSyntax } from './ipc-contract-shape-analyzer';
import { IpcSourceFile } from './ipc-source';

/** A literal value read from the contract through the checker. */
export type IpcLiteral = string | number | undefined;

/** One method of a directional contract class. Data-only. */
export class IpcContractMethod {
    constructor(
        readonly name: string,
        readonly id: IpcLiteral,
        /** `request` / `notification`, or undefined when the decorator has a non-literal kind. */
        readonly kind: string | undefined,
        readonly hasEndpoint: boolean,
        readonly declaration: ts.MethodDeclaration,
    ) {}
}

/** One directional contract class of the contract library (an `…ToNativeApi`). Data-only. */
export class IpcDirectionalContract {
    constructor(
        readonly name: string,
        /** The `@WpInternal` id, or undefined when absent / not a literal. */
        readonly id: IpcLiteral,
        readonly relFile: string,
        readonly declaration: ts.ClassDeclaration,
        readonly methods: readonly IpcContractMethod[],
    ) {}
}

/** One row of the configured wire table, each field resolved to its literal value. Data-only. */
export class IpcWireRow {
    constructor(
        readonly api: IpcLiteral,
        readonly method: IpcLiteral,
        readonly wire: IpcLiteral,
        readonly direction: IpcLiteral,
        readonly kind: IpcLiteral,
        readonly since: IpcLiteral,
    ) {}
}

/** Where the literal wire table lives, when the contract has one. Data-only. */
export class IpcWireTableRef {
    constructor(
        readonly relFile: string,
        readonly exportName: string,
    ) {}
}

/** The wire table a config names, or undefined when it names none; one of the two null is a config error. */
export class IpcWireTableConfig {
    of(ruleName: string, file: string | null, exportName: string | null): IpcWireTableRef | undefined {
        if (file === null && exportName === null) return undefined;
        if (file === null || exportName === null) {
            throw new InformAiError(
                `${ruleName}: "wireTableFile" and "wireTableExport" must both be set or both be null ` +
                    `(got ${JSON.stringify(file)} / ${JSON.stringify(exportName)}).`,
            );
        }
        return new IpcWireTableRef(file, exportName);
    }
}

/** Everything the two project-scoped rules read from the contract library. */
export class IpcContractInventory {
    constructor(
        readonly program: ts.Program,
        readonly contracts: ReadonlyMap<string, IpcDirectionalContract>,
        /** Undefined when no wire table is configured. */
        readonly rows: readonly IpcWireRow[] | undefined,
        readonly errors: readonly string[],
    ) {}

    get checker(): ts.TypeChecker {
        return this.program.getTypeChecker();
    }
}

export class IpcContractInventoryReader {
    private readonly syntax = new IpcContractSyntax();

    /**
     * Builds the contract-rooted program and reads its directional contracts and wire table.
     * `contractFiles` are workspace-relative; `wireTable` must name an existing file when given.
     */
    read(
        workspaceRoot: string,
        options: ts.CompilerOptions,
        contractFiles: readonly string[],
        apiSuffixes: readonly string[],
        wireTable: IpcWireTableRef | undefined,
    ): IpcContractInventory {
        const roots = [...contractFiles];
        if (wireTable !== undefined && !roots.includes(wireTable.relFile)) roots.push(wireTable.relFile);
        const program = ts.createProgram(
            roots.map((rel: string) => path.join(workspaceRoot, rel)),
            { ...options, types: [] },
        );
        const checker = program.getTypeChecker();
        const errors: string[] = [];
        const contracts = new Map<string, IpcDirectionalContract>();
        for (const rel of contractFiles) {
            const source = program.getSourceFile(path.join(workspaceRoot, rel));
            if (source === undefined) continue;
            const file = new IpcSourceFile(rel, source);
            for (const statement of source.statements) {
                if (!this.syntax.isApiClass(statement, apiSuffixes)) continue;
                const contract = this.readContract(file, statement, checker);
                contracts.set(contract.name, contract);
            }
        }
        const rows = wireTable === undefined ? undefined : this.readRows(workspaceRoot, program, wireTable, errors);
        return new IpcContractInventory(program, contracts, rows, errors);
    }

    private readContract(file: IpcSourceFile, node: ts.ClassDeclaration, checker: ts.TypeChecker): IpcDirectionalContract {
        const decorator = this.syntax.decoratorCall(file, node, IpcContractNames.API_DECORATOR);
        const methods = node.members.filter(ts.isMethodDeclaration).map((member: ts.MethodDeclaration) => {
            const endpoint = this.syntax.decoratorCall(file, member, IpcContractNames.ENDPOINT_DECORATOR);
            return new IpcContractMethod(
                member.name.getText(file.source),
                endpoint === undefined ? undefined : this.literal(checker, endpoint.arguments[0]),
                endpoint === undefined ? undefined : this.endpointKind(checker, endpoint),
                endpoint !== undefined,
                member,
            );
        });
        const id = decorator === undefined ? undefined : this.literal(checker, decorator.arguments[0]);
        return new IpcDirectionalContract(node.name?.text ?? '', id, file.relFile, node, methods);
    }

    /** The endpoint `kind`, resolved through the checker (a const or enum member counts). */
    private endpointKind(checker: ts.TypeChecker, call: ts.CallExpression): string | undefined {
        const options = call.arguments[1];
        if (options === undefined || !ts.isObjectLiteralExpression(options)) return 'request';
        const kind = options.properties.find(
            (property: ts.ObjectLiteralElementLike) => ts.isPropertyAssignment(property) && property.name.getText() === 'kind',
        );
        if (kind === undefined) return 'request';
        const value = ts.isPropertyAssignment(kind) ? this.literal(checker, kind.initializer) : undefined;
        return typeof value === 'string' ? value : undefined;
    }

    private readRows(workspaceRoot: string, program: ts.Program, table: IpcWireTableRef, errors: string[]): IpcWireRow[] {
        const source = program.getSourceFile(path.join(workspaceRoot, table.relFile));
        if (source === undefined) {
            throw new InformAiError(
                `ipc rules: wireTableFile "${table.relFile}" does not exist. Point "wireTableFile" at the file ` +
                    'declaring the wire table, or set both "wireTableFile" and "wireTableExport" to null.',
            );
        }
        const declaration = this.findConst(source, table.exportName);
        const initializer = declaration?.initializer;
        if (initializer === undefined || !ts.isArrayLiteralExpression(initializer)) {
            errors.push(`${table.exportName} in ${table.relFile} must be a literal array.`);
            return [];
        }
        const checker = program.getTypeChecker();
        const rows: IpcWireRow[] = [];
        for (const entry of initializer.elements) {
            if (!ts.isObjectLiteralExpression(entry)) {
                errors.push(`${table.exportName} entries must be literal objects.`);
                continue;
            }
            rows.push(this.readRow(checker, entry));
        }
        return rows;
    }

    private readRow(checker: ts.TypeChecker, entry: ts.ObjectLiteralExpression): IpcWireRow {
        const values = new Map<string, IpcLiteral>();
        for (const property of entry.properties) {
            if (ts.isPropertyAssignment(property)) values.set(property.name.getText(), this.literal(checker, property.initializer));
        }
        return new IpcWireRow(
            values.get('api'),
            values.get('method'),
            values.get('wire'),
            values.get('direction'),
            values.get('kind'),
            values.get('since'),
        );
    }

    private findConst(source: ts.SourceFile, name: string): ts.VariableDeclaration | undefined {
        for (const statement of source.statements) {
            if (!ts.isVariableStatement(statement)) continue;
            const found = statement.declarationList.declarations.find(
                (declaration: ts.VariableDeclaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name,
            );
            if (found !== undefined) return found;
        }
        return undefined;
    }

    private literal(checker: ts.TypeChecker, node: ts.Expression | undefined): IpcLiteral {
        if (node === undefined) return undefined;
        const type = checker.getTypeAtLocation(node);
        if (!type.isLiteral()) return undefined;
        return typeof type.value === 'object' ? undefined : type.value;
    }
}
