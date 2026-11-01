/**
 * `ipc-pairing` judgement (#1389): the cross-file half of the replaced script — `metadata.mjs`'s
 * inventory checks and `registrations.mjs`. Given the contract inventory (type-checked, contract-rooted)
 * and the endpoint files (parsed one by one), it verifies:
 *
 *   - every directional contract matches exactly one configured direction;
 *   - API ids are unique across the library; with a wire table, every row names a real contract method,
 *     wires are unique, kind/since/direction are sane, each method has exactly one row, and the
 *     decorator kind agrees with the row (an `event` row is a `notification` endpoint);
 *   - every contract has a generated `createClient(<Contract>)` in its direction's sender files;
 *   - every contract has EXACTLY ONE `create` / `createScoped(<Contract>, …)` registration across all
 *     receiver files, it sits in its own direction's receiver files, and its controller is a subclass of
 *     that same shared contract;
 *   - no receiver file registers an unknown contract or keeps a handwritten dispatch map beside the factory.
 */

import * as ts from 'typescript';
import { matchesAnyGlob } from '@webpieces/rules-config';
import { IpcDirectionEntry, IpcPairingConfig } from '../configs/ipc-configs';
import { IpcContractInventory, IpcContractMethod, IpcDirectionalContract, IpcWireRow } from './ipc-contract-inventory';
import { IpcClassRef, IpcControllerResolver } from './ipc-controller-resolver';
import { IpcFileReader, IpcFinding, IpcSourceFile } from './ipc-source';

/** One `create` / `createScoped` call found in a receiver file. Data-only. */
class IpcRegistration {
    constructor(
        readonly contract: string,
        readonly file: IpcSourceFile,
        readonly call: ts.CallExpression,
        readonly controller: IpcClassRef | undefined,
    ) {}
}

/** One `createClient(<Contract>)` call found in a sender file. Data-only. */
class IpcClientSite {
    constructor(
        readonly contract: string,
        readonly relFile: string,
    ) {}
}

const REGISTRATION_METHODS: readonly string[] = ['create', 'createScoped'];

export class IpcPairingAnalyzer {
    private readonly suffixes: readonly string[];

    constructor(
        private readonly config: IpcPairingConfig,
        private readonly reader: IpcFileReader,
        private readonly controllers: IpcControllerResolver,
    ) {
        this.suffixes = config.directions.map((direction: IpcDirectionEntry) => direction.apiSuffix);
    }

    /** `sourceFiles` is every workspace TypeScript source file; the configured globs pick from it. */
    analyze(inventory: IpcContractInventory, sourceFiles: readonly string[]): IpcFinding[] {
        const out: IpcFinding[] = [];
        for (const error of inventory.errors) out.push(new IpcFinding(this.config.wireTableFile ?? '', 1, '', error));
        out.push(...this.judgeIds(inventory));
        if (inventory.rows !== undefined) out.push(...this.judgeWireTable(inventory, inventory.rows));
        const senders = this.filesOf(sourceFiles, (direction: IpcDirectionEntry) => direction.senderFiles);
        const receivers = this.filesOf(sourceFiles, (direction: IpcDirectionEntry) => direction.receiverFiles);
        const clients = senders.flatMap((rel: string) => this.clientSites(rel));
        const registrations: IpcRegistration[] = [];
        for (const rel of receivers) out.push(...this.readRegistrations(rel, registrations));
        for (const contract of inventory.contracts.values()) out.push(...this.judgeContract(contract, clients, registrations));
        for (const registration of registrations) {
            if (inventory.contracts.has(registration.contract)) continue;
            out.push(registration.file.finding(registration.call, `IPC receiver registers unknown contract ${registration.contract}.`));
        }
        return out;
    }

    private filesOf(all: readonly string[], globs: (direction: IpcDirectionEntry) => readonly string[]): string[] {
        const patterns = this.config.directions.flatMap(globs);
        return all.filter((rel: string) => matchesAnyGlob(rel, patterns));
    }

    private directionOf(contract: string): IpcDirectionEntry | undefined {
        return this.config.directions.find((direction: IpcDirectionEntry) => contract.endsWith(direction.apiSuffix));
    }

    private judgeIds(inventory: IpcContractInventory): IpcFinding[] {
        const out: IpcFinding[] = [];
        const seen = new Map<string | number, string>();
        for (const contract of inventory.contracts.values()) {
            const clash = contract.id === undefined ? undefined : seen.get(contract.id);
            if (contract.id === undefined || clash !== undefined) {
                out.push(this.at(contract, `IPC ${contract.name} needs one uniquely identified @WpInternal id${clash ? ` (also used by ${clash})` : ''}.`));
            } else {
                seen.set(contract.id, contract.name);
            }
        }
        return out;
    }

    private judgeWireTable(inventory: IpcContractInventory, rows: readonly IpcWireRow[]): IpcFinding[] {
        const table = this.config.wireTableFile ?? '';
        const out: IpcFinding[] = [];
        const wires = new Set<string | number>();
        for (const row of rows) {
            const label = `${String(row.api)}.${String(row.method)}`;
            const contract = typeof row.api === 'string' ? inventory.contracts.get(row.api) : undefined;
            if (contract?.methods.some((method: IpcContractMethod) => method.name === row.method) !== true) {
                out.push(new IpcFinding(table, 1, label, `IPC metadata ${label} has no shared abstract API method.`));
            }
            if (row.wire === undefined || wires.has(row.wire)) {
                out.push(new IpcFinding(table, 1, label, `IPC wire registration is missing or duplicated: ${String(row.wire)}.`));
            }
            if (row.wire !== undefined) wires.add(row.wire);
            const since = row.since;
            if ((row.kind !== 'request' && row.kind !== 'event') || typeof since !== 'number' || !Number.isInteger(since) || since < 0) {
                out.push(new IpcFinding(table, 1, label, `IPC ${String(row.wire)} needs kind and since-protocol metadata.`));
            }
            const direction = typeof row.api === 'string' ? this.directionOf(row.api) : undefined;
            if (direction === undefined || row.direction !== direction.wireDirection) {
                out.push(new IpcFinding(table, 1, label, `IPC ${String(row.wire)} direction does not match ${String(row.api)}.`));
            }
        }
        for (const contract of inventory.contracts.values()) out.push(...this.judgeRowsOf(contract, rows));
        return out;
    }

    private judgeRowsOf(contract: IpcDirectionalContract, rows: readonly IpcWireRow[]): IpcFinding[] {
        const out: IpcFinding[] = [];
        for (const method of contract.methods) {
            const own = rows.filter((row: IpcWireRow) => row.api === contract.name && row.method === method.name);
            if (own.length !== 1) out.push(this.at(contract, `IPC ${contract.name}.${method.name} requires exactly one wire metadata entry.`));
            const expected = own[0]?.kind === 'event' ? 'notification' : 'request';
            if (method.hasEndpoint && method.kind !== expected) {
                out.push(this.at(contract, `IPC ${contract.name}.${method.name} decorator kind must be ${expected}.`));
            }
        }
        return out;
    }

    private judgeContract(
        contract: IpcDirectionalContract,
        clients: readonly IpcClientSite[],
        registrations: readonly IpcRegistration[],
    ): IpcFinding[] {
        const direction = this.directionOf(contract.name);
        if (direction === undefined) {
            return [this.at(contract, `IPC ${contract.name} matches no configured direction's apiSuffix.`)];
        }
        const out: IpcFinding[] = [];
        const sent = clients.some(
            (site: IpcClientSite) => site.contract === contract.name && matchesAnyGlob(site.relFile, direction.senderFiles),
        );
        if (!sent) out.push(this.at(contract, `IPC ${contract.name} has no generated client at its sending endpoint.`));
        const matches = registrations.filter((registration: IpcRegistration) => registration.contract === contract.name);
        if (matches.length !== 1) {
            out.push(this.at(contract, `IPC ${contract.name} requires exactly one framework receiver registration (found ${matches.length}).`));
            return out;
        }
        const registration = matches[0];
        const controller = registration.controller;
        if (controller === undefined || !this.controllers.extendsContract(controller, contract.name)) {
            out.push(registration.file.finding(
                registration.call,
                `IPC ${contract.name} registration must receive a concrete subclass of the same shared API ` +
                    '(pass `new <Controller>(…)`, a const initialised with one, or a scope whose `create` returns one).',
            ));
        }
        if (!matchesAnyGlob(registration.file.relFile, direction.receiverFiles)) {
            out.push(registration.file.finding(registration.call, `IPC ${contract.name} receiver is on the wrong endpoint.`));
        }
        return out;
    }

    private clientSites(rel: string): IpcClientSite[] {
        const file = this.reader.read(rel);
        if (file === undefined) return [];
        const out: IpcClientSite[] = [];
        const visit = (node: ts.Node): void => {
            const name = this.calledMember(node);
            const contract = name === 'createClient' ? this.contractArgument(file, node as ts.CallExpression) : undefined;
            if (contract !== undefined) out.push(new IpcClientSite(contract, rel));
            ts.forEachChild(node, visit);
        };
        visit(file.source);
        return out;
    }

    private readRegistrations(rel: string, into: IpcRegistration[]): IpcFinding[] {
        const file = this.reader.read(rel);
        if (file === undefined) return [];
        const out: IpcFinding[] = [];
        const visit = (node: ts.Node): void => {
            out.push(...this.judgeDispatchMap(file, node));
            const name = this.calledMember(node);
            if (name !== undefined && REGISTRATION_METHODS.includes(name)) {
                out.push(...this.readRegistration(file, node as ts.CallExpression, name, into));
            }
            ts.forEachChild(node, visit);
        };
        visit(file.source);
        return out;
    }

    private readRegistration(file: IpcSourceFile, call: ts.CallExpression, method: string, into: IpcRegistration[]): IpcFinding[] {
        const contract = this.contractArgument(file, call);
        if (contract === undefined) return [];
        const controllerArg = call.arguments[1];
        if (controllerArg === undefined) {
            return [file.finding(call, `IPC registration of ${contract} in ${file.relFile} lacks contract/controller.`)];
        }
        const controller = method === 'createScoped'
            ? this.controllers.scopedControllerOf(file, controllerArg)
            : this.controllers.controllerOf(file, controllerArg);
        into.push(new IpcRegistration(contract, file, call, controller));
        return [];
    }

    private judgeDispatchMap(file: IpcSourceFile, node: ts.Node): IpcFinding[] {
        if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return [];
        if (!this.config.forbiddenDispatchVariables.includes(node.name.text)) return [];
        if (node.initializer === undefined || !ts.isNewExpression(node.initializer)) return [];
        return [file.finding(node, `Remove the legacy receiver map in ${file.relFile}; IpcServerFactory is the dispatcher.`)];
    }

    /** `x.<member>(…)` → member, else undefined. */
    private calledMember(node: ts.Node): string | undefined {
        if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return undefined;
        return node.expression.name.text;
    }

    /** The contract class named by a call's first argument, through an import rename, or undefined. */
    private contractArgument(file: IpcSourceFile, call: ts.CallExpression): string | undefined {
        const first = call.arguments[0];
        if (first === undefined) return undefined;
        const name = ts.isIdentifier(first)
            ? (file.importOf(first.text)?.imported ?? first.text)
            : ts.isPropertyAccessExpression(first) ? first.name.text : undefined;
        if (name === undefined) return undefined;
        return this.suffixes.some((suffix: string) => name.endsWith(suffix)) ? name : undefined;
    }

    private at(contract: IpcDirectionalContract, message: string): IpcFinding {
        const source = contract.declaration.getSourceFile();
        const node = contract.declaration.name ?? contract.declaration;
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        return new IpcFinding(contract.relFile, line, contract.name, message);
    }
}
