/**
 * `ipc-protocol-fingerprint` at the build gate (#1389). Project scoped like `ipc-pairing`: under
 * MODIFIED_PROJECTS it runs when the diff touches a configured IPC file or a project owning one. It
 * recomputes the fingerprint (contract-rooted program only), compares it with the committed manifest, and
 * with the manifest at the branch base (merge-base with main, or NX_BASE), so the protocol can neither
 * decrease nor stay put across a wire change. `pnpm wp-ipc-record-protocol` re-records the manifest.
 */

import { DiffScope } from '@webpieces/rules-config';
import { GitProcessApi } from '@webpieces/tooling-common';
import { injectable, bindingScopeValues } from 'inversify';
import { IpcProtocolFingerprintConfig } from './configs/ipc-configs';
import { CodeValidator, ExecutorResult } from './code-validator';
import { ProjectCatalog } from './scan-scope';
import { IpcProtocolComparison, IpcProtocolSnapshot } from './ipc/ipc-protocol-fingerprint';
import { IPC_FINGERPRINT_RULE, IPC_RECORD_COMMAND, IpcProtocolRecorder } from './ipc/ipc-protocol-recorder';
import { IpcRuleSupport } from './ipc/ipc-rule-support';
import { IpcFinding } from './ipc/ipc-source';

@injectable(bindingScopeValues.Singleton)
export class IpcProtocolFingerprintValidator extends CodeValidator<IpcProtocolFingerprintConfig> {
    private readonly support: IpcRuleSupport;
    private readonly recorder: IpcProtocolRecorder;

    constructor(
        config: IpcProtocolFingerprintConfig,
        private readonly diffScope: DiffScope,
        catalog: ProjectCatalog,
        private readonly git: GitProcessApi,
    ) {
        super(config, IPC_FINGERPRINT_RULE, IPC_FINGERPRINT_RULE);
        this.support = new IpcRuleSupport(diffScope, catalog);
        this.recorder = new IpcProtocolRecorder(this.support);
    }

    async run(workspaceRoot: string): Promise<ExecutorResult> {
        const mode = this.config.mode;
        if (mode === undefined || mode === 'OFF') return { success: true };
        if (!(await this.support.triggered(workspaceRoot, mode, IPC_FINGERPRINT_RULE, this.triggerGlobs()))) {
            return { success: true };
        }
        const current = await this.recorder.current(workspaceRoot, this.config);
        const committed = this.recorder.committed(workspaceRoot, this.config);
        const base = await this.baseline(workspaceRoot);
        const errors = new IpcProtocolComparison(this.config.versionConstant, IPC_RECORD_COMMAND).compare(
            current,
            committed,
            base,
        );
        if (errors.length === 0) return { success: true };
        const findings = errors.map((error: string) =>
            new IpcFinding(this.config.manifestPath, 1, `protocol ${current.protocol}, fingerprint ${current.fingerprint}`, error));
        throw this.support.failure(
            IPC_FINGERPRINT_RULE,
            `the recorded wire fingerprint must match the source, and a wire change must raise ${this.config.versionConstant}.`,
            findings,
        );
    }

    /** The branch base's manifest; without a base, FAIL refuses and VERIFY_COMMITTED skips the increment check. */
    private async baseline(workspaceRoot: string): Promise<IpcProtocolSnapshot | undefined> {
        const range = await this.diffScope.resolveBase(workspaceRoot);
        if (range.base !== undefined) return this.recorder.atBase(workspaceRoot, this.config, range.base, this.git);
        if (this.config.withoutBaseline === 'VERIFY_COMMITTED') {
            console.log(`\nℹ️  ${IPC_FINGERPRINT_RULE}: no branch base; verifying the committed manifest only.\n`);
            return undefined;
        }
        throw this.support.failure(IPC_FINGERPRINT_RULE, 'the protocol increment cannot be checked without the branch base.', [
            new IpcFinding(
                this.config.manifestPath,
                1,
                '',
                'IPC protocol baseline lookup failed: no merge-base with origin/main or main. Fetch origin main (or set ' +
                    'NX_BASE) and retry; an archive/shallow build checkout configures withoutBaseline: "VERIFY_COMMITTED".',
            ),
        ]);
    }

    private triggerGlobs(): string[] {
        const globs = [...this.config.contractPaths, ...this.config.normalizedSourceFiles, this.config.versionFile, this.config.manifestPath];
        if (this.config.wireTableFile !== null) globs.push(this.config.wireTableFile);
        return globs;
    }
}
