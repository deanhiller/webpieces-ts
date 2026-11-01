#!/usr/bin/env node
import 'reflect-metadata';
import {
    CliArgs,
    CliUsage,
    DiffScope,
    RepoRootFinder,
    RuleFileExclusions,
    RuleFileScope,
    loadAndValidate,
    runMain,
} from '@webpieces/rules-config';
import { InformAiError } from '@webpieces/tooling-common';
import { IpcProtocolFingerprintConfig } from './configs/ipc-configs';
import { ProjectCatalog } from './scan-scope';
import { IPC_FINGERPRINT_RULE, IpcProtocolRecorder } from './ipc/ipc-protocol-recorder';
import { IpcRuleSupport } from './ipc/ipc-rule-support';

/**
 * `wp-ipc-record-protocol` (#1389) — re-record the `ipc-protocol-fingerprint` manifest after an intentional
 * wire change. It computes the snapshot exactly as the rule does (same config entry, same path
 * exclusions) and writes `manifestPath`. Recording never waives the rule's branch-base check: a changed
 * fingerprint still fails until the version constant is incremented past the base's protocol.
 */
runMain(async (): Promise<void> => {
    new CliArgs().assertNoArgs(
        new CliUsage(
            'wp-ipc-record-protocol',
            `Re-record the ${IPC_FINGERPRINT_RULE} manifest from the current IPC contract. Increment the version ` +
                'constant first for a wire change; the branch-base comparison still requires it.',
        ),
    );
    const workspaceRoot = new RepoRootFinder().resolveRepoRoot(process.cwd());
    const loaded = loadAndValidate(workspaceRoot);
    const config = loaded.rulesConfig[IPC_FINGERPRINT_RULE as keyof typeof loaded.rulesConfig] as
        | IpcProtocolFingerprintConfig
        | undefined;
    if (config === undefined) {
        throw new InformAiError(`No "${IPC_FINGERPRINT_RULE}" entry is configured; add it to its code-rules owner file first.`);
    }
    const diffScope = new DiffScope();
    const support = new IpcRuleSupport(diffScope, new ProjectCatalog(diffScope));
    const recorder = new IpcProtocolRecorder(support);
    const exclusions = new RuleFileExclusions(IPC_FINGERPRINT_RULE, loaded.excludePaths.paths, config.excludePaths ?? []);
    const snapshot = await new RuleFileScope().runWithin(exclusions, () => recorder.current(workspaceRoot, config));
    const written = recorder.record(workspaceRoot, config, snapshot);
    process.stdout.write(
        `Recorded IPC contract fingerprint (protocol ${snapshot.protocol}) to ${written}; the branch-base comparison ` +
            'still requires a protocol increment for a contract change.\n',
    );
});
