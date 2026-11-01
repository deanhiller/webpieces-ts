/**
 * `ipc-pairing` at the build gate (#1389) — see {@link IpcPairingAnalyzer} for what it checks. Project
 * scoped: under MODIFIED_PROJECTS it runs when the diff touches a configured IPC file or a project owning
 * one, and then judges the whole IPC file set. The only `ts.Program` is rooted at `contractPaths`.
 */

import { DiffScope } from '@webpieces/rules-config';
import { InformAiError } from '@webpieces/tooling-common';
import { injectable, bindingScopeValues } from 'inversify';
import { IpcDirectionEntry, IpcPairingConfig } from './configs/ipc-configs';
import { CodeValidator, ExecutorResult } from './code-validator';
import { ProjectCatalog, ScanScope } from './scan-scope';
import { IpcContractInventoryReader, IpcWireTableConfig } from './ipc/ipc-contract-inventory';
import { IpcControllerResolver } from './ipc/ipc-controller-resolver';
import { IpcPairingAnalyzer } from './ipc/ipc-pairing-analyzer';
import { IpcRuleSupport } from './ipc/ipc-rule-support';
import { IpcCompilerOptionsReader, IpcFileReader, IpcFinding, IpcModuleResolver } from './ipc/ipc-source';

const RULE = 'ipc-pairing';

@injectable(bindingScopeValues.Singleton)
export class IpcPairingValidator extends CodeValidator<IpcPairingConfig> {
    private readonly support: IpcRuleSupport;

    constructor(
        config: IpcPairingConfig,
        private readonly scanScope: ScanScope,
        diffScope: DiffScope,
        catalog: ProjectCatalog,
    ) {
        super(config, RULE, RULE);
        this.support = new IpcRuleSupport(diffScope, catalog);
    }

    async run(workspaceRoot: string): Promise<ExecutorResult> {
        const mode = this.config.mode;
        if (mode === undefined || mode === 'OFF') return { success: true };
        const wireTable = new IpcWireTableConfig().of(RULE, this.config.wireTableFile, this.config.wireTableExport);
        if (!(await this.support.triggered(workspaceRoot, mode, RULE, this.triggerGlobs()))) return { success: true };
        const sourceFiles = await this.support.sourceFiles(workspaceRoot);
        const contractFiles = await this.support.sourceFilesMatching(workspaceRoot, this.config.contractPaths);
        if (contractFiles.length === 0) {
            throw new InformAiError(`${RULE}: no source file matches "contractPaths" ${JSON.stringify(this.config.contractPaths)}.`);
        }
        const options = new IpcCompilerOptionsReader().read(workspaceRoot, this.config.tsconfigPath);
        const suffixes = this.config.directions.map((direction: IpcDirectionEntry) => direction.apiSuffix);
        const inventory = new IpcContractInventoryReader().read(workspaceRoot, options, contractFiles, suffixes, wireTable);
        const reader = new IpcFileReader(workspaceRoot);
        const controllers = new IpcControllerResolver(reader, new IpcModuleResolver(workspaceRoot, options), this.config.contractPaths);
        const findings = new IpcPairingAnalyzer(this.config, reader, controllers).analyze(inventory, sourceFiles);
        if (findings.length === 0) return { success: true };
        this.scanScope.recordSites(RULE, findings.map((each: IpcFinding) => each.relFile));
        throw this.support.failure(
            RULE,
            'every shared directional API needs a generated client at its sender and exactly one framework ' +
                'registration at its receiver, whose controller extends that same shared API.',
            findings,
        );
    }

    private triggerGlobs(): string[] {
        const globs = [...this.config.contractPaths];
        for (const direction of this.config.directions) globs.push(...direction.senderFiles, ...direction.receiverFiles);
        if (this.config.wireTableFile !== null) globs.push(this.config.wireTableFile);
        return globs;
    }
}
