#!/usr/bin/env node

/**
 * wp-ci — the universal webpieces CI entrypoint.
 *
 * Works in BOTH an Nx monorepo and a plain (non-Nx) repo, because the detection of
 * "are we even in Nx?" cannot live inside an Nx executor (by the time an executor runs,
 * Nx is already running). Dispatch:
 *
 *   - no nx.json (non-Nx repo)            -> run the standalone code validators, succeed.
 *   - nx.json present, plugin NOT in it   -> fail with the exact install command.
 *   - nx.json present, plugin registered  -> normal branch: validators + affected `ci`;
 *                                            `/hotfix/` branch: affected `hotfix-ci` (build + test only).
 *
 * Repos reference this as a bin (`"webpieces:ci": "wp-ci"`) so the logic is versioned in
 * the npm package instead of copy-pasted into each repo's package.json (which drifts).
 *
 * Every nx step goes through NxStepRunner, which spawns it into its own process group and refuses
 * to return until that group has drained — a step whose workers outlive it holds the CI step's
 * stdout open and hangs the job forever with all work already green. See wp-ci-survivors.ts.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
    loadAndValidate,
    RuleFailError,
    renderRuleFailForHuman,
    RepoRootFinder,
} from '@webpieces/rules-config';
import { InformAiError } from '@webpieces/tooling-common';
import { toError } from '@webpieces/tooling-common/to-error';
import { BranchIdentity } from '@webpieces/repo-workflow-core';
import { CodeRulesBootstrap } from './code-rules-bootstrap';
import { CodeRulesRunRequest } from './code-rules-run-request';
import { NxStepRunner } from './wp-ci-nx-runner';
import {
    GracePeriodResolver,
    ProcessGroupKiller,
    ProcessGroupScanner,
    SurvivorReporter,
    SurvivorWatchdog,
} from './wp-ci-survivors';

/** How often the watchdog re-runs `ps` while waiting for a finished step's process group to drain. */
const SURVIVOR_POLL_INTERVAL_MILLIS = 1000;

const NX_PLUGIN_NAME = '@webpieces/nx-webpieces-rules';

interface NxPluginObject {
    plugin?: string;
}

type NxPluginEntry = string | NxPluginObject;

interface RawNxJson {
    plugins?: NxPluginEntry[];
}

function findUp(filename: string, startDir: string): string | null {
    let dir = startDir;
    while (true) {
        const candidate = path.join(dir, filename);
        if (fs.existsSync(candidate)) return candidate;
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

function pluginEntryMatches(entry: NxPluginEntry): boolean {
    if (typeof entry === 'string') return entry === NX_PLUGIN_NAME;
    return entry.plugin === NX_PLUGIN_NAME;
}

function isPluginRegistered(nxJsonPath: string): boolean {
    const raw = fs.readFileSync(nxJsonPath, 'utf8');
    // webpieces-disable no-unmanaged-exceptions -- rethrow as InformAiError so global catch surfaces readable message to AI
    try {
        const parsed = JSON.parse(raw) as RawNxJson;
        const plugins = parsed.plugins ?? [];
        return plugins.some((entry: NxPluginEntry) => pluginEntryMatches(entry));
    // webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
    } catch (err: unknown) {
        const error = toError(err);
        throw new InformAiError(
            `nx.json has invalid JSON — fix the file, then retry.\nParse error: ${error.message}\nFile: ${nxJsonPath}`,
        );
    }
}

async function runStandalone(cwd: string): Promise<number> {
    const workspaceRoot = new RepoRootFinder().resolveRepoRoot(cwd);
    const loaded = loadAndValidate(workspaceRoot);
    if (loaded.configPath === null) {
        console.log('ℹ️  Not an Nx repo and no webpieces.config.json found — nothing to validate.');
        return 0;
    }
    console.log('ℹ️  Not an Nx repo — running standalone webpieces code validators.\n');

    const result = await new CodeRulesBootstrap().run(
        workspaceRoot,
        new CodeRulesRunRequest(undefined, undefined, undefined),
    );
    return result.success ? 0 : 1;
}

function reportPluginMissing(): void {
    console.error('\n❌ This is an Nx monorepo but the webpieces Nx plugin is not installed.\n');
    console.error('   Install it so the validators run during CI:\n');
    console.error(`       nx add ${NX_PLUGIN_NAME}\n`);
    console.error('   (or add it manually to the "plugins" array in nx.json).\n');
}

// webpieces-disable no-unmanaged-exceptions -- global entry point for wp-ci CLI
async function main(): Promise<void> {
    try {
        const cwd = process.cwd();
        const passthrough = process.argv.slice(2);

        const nxJsonPath = findUp('nx.json', cwd);
        if (!nxJsonPath) {
            const code = await runStandalone(cwd);
            process.exit(code);
        }

        const root = path.dirname(nxJsonPath);
        if (!isPluginRegistered(nxJsonPath)) {
            reportPluginMissing();
            process.exit(1);
        }

        const gracePeriod = new GracePeriodResolver().resolve(process.env);
        const runner = new NxStepRunner(
            root,
            gracePeriod,
            new SurvivorWatchdog(new ProcessGroupScanner(), SURVIVOR_POLL_INTERVAL_MILLIS),
            new SurvivorReporter(),
            new ProcessGroupKiller(),
        );
        const hotfix = new BranchIdentity().isHotfix();

        // Validate the root policy exactly once. webpieces.config.json is deliberately NOT a
        // sharedGlobal Nx input: making every project hash depend on it turned a policy-only edit into
        // a workspace-wide compile/lint/test. The scoped rules project preserves the gate without that
        // fan-out.
        const rules = await runner.run(['run', 'rules:check'], 'rules:check');
        // webpieces-disable no-process-exit-outside-main -- this file's main() is the wp-ci bin boundary
        if (rules !== 0) process.exit(rules);

        // Run the architecture + code validators next (this also runs the wiring guard,
        // which fails loudly if nx.json no longer wires validators into the build).
        if (!hotfix && fs.existsSync(path.join(root, 'architecture'))) {
            const validateCode = await runner.run(
                ['run', 'architecture:validate-complete'],
                'architecture:validate-complete',
            );
            // webpieces-disable no-process-exit-outside-main -- this file's main() is the wp-ci bin boundary
            if (validateCode !== 0) process.exit(validateCode);
        }

        // Hotfix deliberately schedules only compile/typecheck + tests. The shared branch resolver makes
        // this the same decision the local PR gate makes, including detached GitHub checkouts.
        const target = hotfix ? 'hotfix-ci' : 'ci';
        const ciCode = await runner.run(
            ['affected', `--target=${target}`, ...passthrough],
            `nx affected --target=${target}`,
        );
        // webpieces-disable no-process-exit-outside-main -- this file's main() is the wp-ci bin boundary
        process.exit(ciCode);
    // webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
    } catch (err: unknown) {
        const error = toError(err);
        if (error instanceof RuleFailError) {
            console.error(renderRuleFailForHuman(error));
        } else if (err instanceof InformAiError) {
            console.error(error.message);
        } else {
            console.error(`[wp-ci] unexpected error: ${error.message}`);
        }
        // webpieces-disable no-process-exit-outside-main -- this file's main() is the wp-ci bin boundary
        process.exit(1);
    }
}

void main();
