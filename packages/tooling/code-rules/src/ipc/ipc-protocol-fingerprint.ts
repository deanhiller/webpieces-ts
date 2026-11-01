/**
 * The IPC protocol fingerprint (#1389) — a port of the replaced script's `version.mjs` +
 * `metadata.mjs#wireSurface`, kept byte-compatible with it: the same declaration objects in the same key
 * order, the same resolved-shape walk, the same comment-free printer, the same sha256 input order. A
 * manifest recorded by the script therefore verifies here when the configured files are the ones it hashed.
 *
 * The checker it needs comes from the contract-rooted program in {@link IpcContractInventory}; no endpoint
 * file is ever part of it.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { InformAiError } from '@webpieces/tooling-common';
import { IpcContractInventory, IpcContractMethod, IpcDirectionalContract, IpcLiteral, IpcWireRow } from './ipc-contract-inventory';

/** The recorded manifest: the protocol integer and the fingerprint of the wire it speaks. Data-only. */
export class IpcProtocolSnapshot {
    constructor(
        readonly protocol: number,
        readonly fingerprint: string,
    ) {}

    /** The manifest file's text, exactly as the replaced script wrote it. */
    toManifestText(): string {
        return `${JSON.stringify({ protocol: this.protocol, fingerprint: this.fingerprint }, null, 2)}\n`;
    }
}

/** A resolved wire shape: a type name, a sorted union, or a structural description. */
type WireShape = string | WireShape[] | WireShapeObject;

/** The structural half of a {@link WireShape}; keys mirror the replaced script's JSON exactly. */
class WireShapeObject {
    promise?: WireShape;
    array?: WireShape;
    tuple?: WireShape[];
    properties?: WireProperty[];
    index?: WireShape;
}

/** `[name, { optional, type }]`, the script's property tuple. */
type WireProperty = [string, WirePropertyShape];

class WirePropertyShape {
    constructor(
        readonly optional: boolean,
        readonly type: WireShape,
    ) {}
}

/** One fingerprinted operation; field order is the hash input's key order. Data-only. */
class WireDeclaration {
    constructor(
        readonly wire: IpcLiteral,
        readonly apiId: IpcLiteral,
        readonly methodId: IpcLiteral,
        readonly kind: IpcLiteral,
        readonly direction: IpcLiteral,
        readonly since: IpcLiteral,
        readonly parameters: WireShape[],
        readonly reply: WireShape,
    ) {}
}

/** Inputs of one snapshot, already resolved to workspace files. Data-only. */
export class IpcFingerprintInputs {
    constructor(
        readonly workspaceRoot: string,
        readonly inventory: IpcContractInventory,
        /** Workspace-relative, in hash order. */
        readonly normalizedSourceFiles: readonly string[],
        readonly versionFile: string,
        readonly versionConstant: string,
    ) {}
}

export class IpcProtocolFingerprinter {
    snapshot(inputs: IpcFingerprintInputs): IpcProtocolSnapshot {
        const declarations = this.wireSurface(inputs.inventory);
        const fingerprint = createHash('sha256')
            .update(JSON.stringify(declarations))
            .update(this.normalizedSource(inputs.workspaceRoot, inputs.normalizedSourceFiles))
            .digest('hex');
        return new IpcProtocolSnapshot(this.protocolOf(inputs), fingerprint);
    }

    /** The integer `export const <versionConstant> = <n>` declares; `\b` keeps `MIN_<constant>` out. */
    private protocolOf(inputs: IpcFingerprintInputs): number {
        const absFile = path.join(inputs.workspaceRoot, inputs.versionFile);
        if (!fs.existsSync(absFile)) {
            throw new InformAiError(`ipc-protocol-fingerprint: versionFile "${inputs.versionFile}" does not exist.`);
        }
        const escaped = inputs.versionConstant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = fs.readFileSync(absFile, 'utf8').match(new RegExp(`\\b${escaped}\\s*=\\s*(\\d+)`));
        if (match === null) {
            throw new InformAiError(
                `ipc-protocol-fingerprint: ${inputs.versionConstant} in ${inputs.versionFile} must be a literal integer ` +
                    `(\`export const ${inputs.versionConstant} = <n>;\`).`,
            );
        }
        return Number(match[1]);
    }

    /** Wire identity and resolved payload shapes, independent of file, class and method renames. */
    private wireSurface(inventory: IpcContractInventory): WireDeclaration[] {
        const checker = inventory.checker;
        const rows = inventory.rows ?? this.rowsFromContracts(inventory);
        return rows
            .map((row: IpcWireRow) => {
                const contract = typeof row.api === 'string' ? inventory.contracts.get(row.api) : undefined;
                const method = contract?.methods.find((each: IpcContractMethod) => each.name === row.method);
                if (contract === undefined || method === undefined) {
                    throw new InformAiError(
                        `ipc-protocol-fingerprint: cannot fingerprint unbound IPC method ${String(row.api)}.${String(row.method)} — ` +
                            'fix the wire table row (ipc-pairing names the cause).',
                    );
                }
                const signature = checker.getSignatureFromDeclaration(method.declaration);
                const reply = signature === undefined ? 'unknown' : this.shape(checker, checker.getReturnTypeOfSignature(signature), method.declaration);
                return new WireDeclaration(
                    row.wire,
                    contract.id,
                    method.id,
                    row.kind,
                    row.direction,
                    row.since,
                    method.declaration.parameters.map((p: ts.ParameterDeclaration) => this.shape(checker, checker.getTypeAtLocation(p), p)),
                    reply,
                );
            })
            .sort((a: WireDeclaration, b: WireDeclaration) => String(a.wire).localeCompare(String(b.wire)));
    }

    /** Without a wire table, every contract method is one operation, named `<apiId>.<methodId>`. */
    private rowsFromContracts(inventory: IpcContractInventory): IpcWireRow[] {
        const rows: IpcWireRow[] = [];
        for (const contract of inventory.contracts.values()) {
            rows.push(...contract.methods.map((method: IpcContractMethod) => this.rowOf(contract, method)));
        }
        return rows;
    }

    private rowOf(contract: IpcDirectionalContract, method: IpcContractMethod): IpcWireRow {
        const wire = `${String(contract.id)}.${String(method.id)}`;
        return new IpcWireRow(contract.name, method.name, wire, undefined, method.kind, undefined);
    }

    private shape(checker: ts.TypeChecker, type: ts.Type, node: ts.Node, visiting: ReadonlySet<ts.Type> = new Set<ts.Type>()): WireShape {
        if (visiting.has(type)) return 'recursive';
        if (type.isUnion()) {
            return type.types
                .map((part: ts.Type) => this.shape(checker, part, node, visiting))
                .sort((a: WireShape, b: WireShape) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        }
        if (!(type.flags & ts.TypeFlags.Object)) return checker.typeToString(type);
        const next = new Set<ts.Type>(visiting).add(type);
        const out = new WireShapeObject();
        if (type.getSymbol()?.name === 'Promise') {
            out.promise = this.shape(checker, checker.getTypeArguments(type as ts.TypeReference)[0], node, next);
            return out;
        }
        if (checker.isArrayType(type)) {
            out.array = this.shape(checker, checker.getTypeArguments(type as ts.TypeReference)[0], node, next);
            return out;
        }
        if (checker.isTupleType(type)) {
            out.tuple = checker.getTypeArguments(type as ts.TypeReference).map((part: ts.Type) => this.shape(checker, part, node, next));
            return out;
        }
        out.properties = type
            .getProperties()
            .map((property: ts.Symbol): WireProperty => [
                property.name,
                new WirePropertyShape(
                    (property.flags & ts.SymbolFlags.Optional) !== 0,
                    this.shape(
                        checker,
                        checker.getTypeOfSymbolAtLocation(property, property.valueDeclaration ?? property.declarations?.[0] ?? node),
                        node,
                        next,
                    ),
                ),
            ])
            .sort((a: WireProperty, b: WireProperty) => a[0].localeCompare(b[0]));
        const index = checker.getIndexTypeOfType(type, ts.IndexKind.String);
        if (index !== undefined) out.index = this.shape(checker, index, node, next);
        return out;
    }

    /** Decorators, masks and validators, printed without comments so formatting never moves the hash. */
    private normalizedSource(workspaceRoot: string, files: readonly string[]): string {
        const printer = ts.createPrinter({ removeComments: true });
        return files
            .map((rel: string) => {
                const absFile = path.join(workspaceRoot, rel);
                return printer.printFile(ts.createSourceFile(absFile, fs.readFileSync(absFile, 'utf8'), ts.ScriptTarget.Latest, true));
            })
            .join('\n');
    }
}

/** The three ways a fingerprint check fails, worded for the configured version constant. */
export class IpcProtocolComparison {
    constructor(
        private readonly versionConstant: string,
        private readonly recordCommand: string,
    ) {}

    compare(current: IpcProtocolSnapshot, committed: IpcProtocolSnapshot, base: IpcProtocolSnapshot | undefined): string[] {
        const errors: string[] = [];
        if (current.fingerprint !== committed.fingerprint || current.protocol !== committed.protocol) {
            errors.push(
                `IPC contract fingerprint changed. Review request/reply/event shape, increment ${this.versionConstant} ` +
                    `for a wire change, then run ${this.recordCommand}.`,
            );
        }
        if (base !== undefined && current.protocol < base.protocol) {
            errors.push(`${this.versionConstant} cannot decrease, including on a revert.`);
        }
        if (base !== undefined && current.fingerprint !== base.fingerprint && current.protocol <= base.protocol) {
            errors.push(
                `IPC contract changed without a ${this.versionConstant} increment relative to the branch base. ` +
                    'Updating the manifest alone cannot waive a protocol change.',
            );
        }
        return errors;
    }
}
