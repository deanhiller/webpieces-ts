/**
 * Builds the current {@link IpcProtocolSnapshot} from an `ipc-protocol-fingerprint` config, and reads the
 * committed and branch-base manifests (#1389). Shared by the validator and the `wp-ipc-record-protocol`
 * bin, so what the bin records is exactly what the rule later verifies.
 */

import * as fs from 'fs';
import * as path from 'path';
import { GitProcessApi, InformAiError } from '@webpieces/tooling-common';
import { toError } from '@webpieces/tooling-common/to-error';
import { IpcProtocolFingerprintConfig } from '../configs/ipc-configs';
import { IpcContractInventoryReader, IpcWireTableConfig } from './ipc-contract-inventory';
import { IpcFingerprintInputs, IpcProtocolFingerprinter, IpcProtocolSnapshot } from './ipc-protocol-fingerprint';
import { IpcRuleSupport } from './ipc-rule-support';
import { IpcCompilerOptionsReader } from './ipc-source';

export const IPC_FINGERPRINT_RULE = 'ipc-protocol-fingerprint';

/** The command that re-records the manifest; every refusal names it. */
export const IPC_RECORD_COMMAND = 'pnpm wp-ipc-record-protocol';

/** The two fields of a manifest file. */
type RawManifest = { protocol?: number; fingerprint?: string };

export class IpcProtocolRecorder {
    constructor(private readonly support: IpcRuleSupport) {}

    /** The snapshot of the working tree's contract, as the rule computes it. */
    async current(workspaceRoot: string, config: IpcProtocolFingerprintConfig): Promise<IpcProtocolSnapshot> {
        const wireTable = new IpcWireTableConfig().of(IPC_FINGERPRINT_RULE, config.wireTableFile, config.wireTableExport);
        const contractFiles = await this.support.sourceFilesMatching(workspaceRoot, config.contractPaths);
        if (contractFiles.length === 0) {
            throw new InformAiError(`${IPC_FINGERPRINT_RULE}: no source file matches "contractPaths" ${JSON.stringify(config.contractPaths)}.`);
        }
        const normalized: string[] = [];
        for (const glob of config.normalizedSourceFiles) {
            for (const rel of await this.support.sourceFilesMatching(workspaceRoot, [glob])) {
                if (!normalized.includes(rel)) normalized.push(rel);
            }
        }
        if (normalized.length === 0) {
            throw new InformAiError(
                `${IPC_FINGERPRINT_RULE}: no source file matches "normalizedSourceFiles" ${JSON.stringify(config.normalizedSourceFiles)}.`,
            );
        }
        const options = new IpcCompilerOptionsReader().read(workspaceRoot, config.tsconfigPath);
        const inventory = new IpcContractInventoryReader().read(workspaceRoot, options, contractFiles, config.apiClassSuffixes, wireTable);
        if (inventory.errors.length > 0) {
            throw new InformAiError(
                `${IPC_FINGERPRINT_RULE}: cannot fingerprint the contract until its wire table is readable — ` +
                    `${inventory.errors.join(' ')} Fix ${config.wireTableFile ?? 'the wire table'} and retry.`,
            );
        }
        return new IpcProtocolFingerprinter().snapshot(
            new IpcFingerprintInputs(workspaceRoot, inventory, normalized, config.versionFile, config.versionConstant),
        );
    }

    /** Write `snapshot` to the configured manifest path, creating its directory. */
    record(workspaceRoot: string, config: IpcProtocolFingerprintConfig, snapshot: IpcProtocolSnapshot): string {
        const absFile = path.join(workspaceRoot, config.manifestPath);
        fs.mkdirSync(path.dirname(absFile), { recursive: true });
        fs.writeFileSync(absFile, snapshot.toManifestText());
        return absFile;
    }

    /** The committed manifest in the working tree; a missing one names the record command. */
    committed(workspaceRoot: string, config: IpcProtocolFingerprintConfig): IpcProtocolSnapshot {
        const absFile = path.join(workspaceRoot, config.manifestPath);
        if (!fs.existsSync(absFile)) {
            throw new InformAiError(
                `${IPC_FINGERPRINT_RULE}: manifest ${config.manifestPath} does not exist. Run ${IPC_RECORD_COMMAND} and commit it.`,
            );
        }
        return this.parse(fs.readFileSync(absFile, 'utf8'), config.manifestPath);
    }

    /** The manifest at `base`, or undefined when that commit has none at this path. */
    async atBase(workspaceRoot: string, config: IpcProtocolFingerprintConfig, base: string, git: GitProcessApi): Promise<IpcProtocolSnapshot | undefined> {
        const listed = await git.run(['ls-tree', '--name-only', base, '--', config.manifestPath], workspaceRoot);
        if (!listed.ok) {
            throw new InformAiError(
                `IPC protocol baseline lookup of ${config.manifestPath} at ${base} failed: ${listed.stderr.trim()}. ` +
                    'Fetch origin main (or set NX_BASE to a reachable commit) and retry.',
            );
        }
        if (listed.stdout.trim() === '') return undefined;
        const shown = await git.run(['show', `${base}:${config.manifestPath}`], workspaceRoot);
        if (!shown.ok) {
            throw new InformAiError(`IPC protocol baseline read of ${config.manifestPath} at ${base} failed: ${shown.stderr.trim()}.`);
        }
        return this.parse(shown.stdout, `${base}:${config.manifestPath}`);
    }

    private parse(text: string, where: string): IpcProtocolSnapshot {
        let raw: RawManifest;
        // webpieces-disable no-unmanaged-exceptions -- name the manifest that failed to parse while preserving the parse failure as cause
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            raw = JSON.parse(text) as RawManifest;
        } catch (err: unknown) {
            const error = toError(err);
            throw new InformAiError(`${IPC_FINGERPRINT_RULE}: ${where} is not valid JSON. Re-run ${IPC_RECORD_COMMAND}.`, { cause: error });
        }
        if (typeof raw.protocol !== 'number' || typeof raw.fingerprint !== 'string') {
            throw new InformAiError(
                `${IPC_FINGERPRINT_RULE}: ${where} must hold { "protocol": <integer>, "fingerprint": "<sha256>" }. Re-run ${IPC_RECORD_COMMAND}.`,
            );
        }
        return new IpcProtocolSnapshot(raw.protocol, raw.fingerprint);
    }
}
