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
 *   - nx.json present, plugin registered  -> run validators (incl. the wiring guard),
 *                                            then `nx affected --target=ci`.
 *
 * Repos reference this as a bin (`"webpieces:ci": "wp-ci"`) so the logic is versioned in
 * the npm package instead of copy-pasted into each repo's package.json (which drifts).
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { loadAndValidate, InformAiError, RuleFailError, toError } from '@webpieces/rules-config';
import runValidateCode from './validate-code';

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
    } catch (err: unknown) {
        const error = toError(err);
        throw new InformAiError(`nx.json has invalid JSON — fix the file, then retry.\nParse error: ${error.message}\nFile: ${nxJsonPath}`);
    }
}

function nxBin(root: string): string {
    const local = path.join(root, 'node_modules', '.bin', 'nx');
    return fs.existsSync(local) ? local : 'nx';
}

function runNx(root: string, args: string[]): number {
    const result = spawnSync(nxBin(root), args, { stdio: 'inherit', cwd: root });
    if (typeof result.status === 'number') return result.status;
    return 1;
}

async function runStandalone(cwd: string): Promise<number> {
    const loaded = loadAndValidate(cwd);
    if (loaded.configPath === null) {
        console.log('ℹ️  Not an Nx repo and no webpieces.config.json found — nothing to validate.');
        return 0;
    }
    console.log('ℹ️  Not an Nx repo — running standalone webpieces code validators.\n');
    const result = await runValidateCode(cwd);
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

        // Run the architecture + code validators first (this also runs the wiring guard,
        // which fails loudly if nx.json no longer wires validators into the build).
        if (fs.existsSync(path.join(root, 'architecture'))) {
            const validateCode = runNx(root, ['run', 'architecture:validate-complete']);
            if (validateCode !== 0) process.exit(validateCode);
        }

        // Then the Gradle-style ci composite (lint + build + test) across affected projects.
        const ciCode = runNx(root, ['affected', '--target=ci', ...passthrough]);
        process.exit(ciCode);
    } catch (err: unknown) {
        const error = toError(err);
        if (error instanceof RuleFailError) {
            console.error(error.humanMessage);
        } else if (err instanceof InformAiError) {
            console.error(error.message);
        } else {
            console.error(`[wp-ci] unexpected error: ${error.message}`);
        }
        process.exit(1);
    }
}

void main();
