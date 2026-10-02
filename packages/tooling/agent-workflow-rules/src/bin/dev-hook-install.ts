import { existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { runMain, CliExitError } from '@webpieces/rules-config';

interface HookEntry {
    matcher: string;
    hooks: Array<{ type: string; command: string }>;
}

interface ClaudeSettings {
    hooks?: {
        PreToolUse?: HookEntry[];
    };
    // webpieces-disable no-any-unknown -- opaque settings bag; arbitrary keys allowed
    [key: string]: unknown;
}

interface DevHookBackup {
    previousHooks: ClaudeSettings['hooks'] | null;
}

// webpieces-disable no-function-outside-class -- existing CLI/shim bootstrap function moved intact; it must remain callable without constructing a DI container
function wireLocalRulesConfig(cwd: string, distRulesConfigPath: string): void {
    // Place the symlink in dist/packages/tooling/node_modules/ — one level above
    // the agent-workflow-rules package output but still below the workspace root node_modules.
    // Node's require() resolution walks up from the requiring file and finds this
    // node_modules entry before reaching the workspace root's stale published package.
    // This directory is NOT wiped by any individual package build (each build only
    // cleans its own output subfolder), so it survives a full workspace build too.
    const overrideDir = join(cwd, 'dist', 'packages', 'tooling', 'node_modules', '@webpieces');
    const overrideLink = join(overrideDir, 'rules-config');
    mkdirSync(overrideDir, { recursive: true });
    if (existsSync(overrideLink)) {
        rmSync(overrideLink, { recursive: true });
    }
    symlinkSync(distRulesConfigPath, overrideLink);
}

// NOTE: this is a dev-only tool, no longer a `wp-*` bin. Run it directly with node against the local
// build: `node dist/packages/tooling/agent-workflow-rules/src/bin/dev-hook-install.js`.
// webpieces-disable no-function-outside-class -- existing CLI/shim bootstrap function moved intact; it must remain callable without constructing a DI container
export async function runDevHookInstall(): Promise<void> {
    const cwd = process.cwd();
    // Mirror production .claude/settings.json: two independent PreToolUse hooks, one per category.
    const rulesHookPath = join(cwd, 'dist', 'packages', 'tooling', 'ai-hook-rules', 'src', 'adapters', 'rules-hook.js');
    const guardsHookPath = join(cwd, 'dist', 'packages', 'tooling', 'agent-workflow-rules', 'src', 'adapters', 'guards-hook.js');

    if (!existsSync(rulesHookPath)) {
        console.error(`[dev-hook-install] Local build not found at: ${rulesHookPath}`);
        console.error('  Run `pnpm nx run ai-hook-rules:build` first.');
        throw new CliExitError(1, '');
    }
    if (!existsSync(guardsHookPath)) {
        console.error(`[dev-hook-install] Local build not found at: ${guardsHookPath}`);
        console.error('  Run `pnpm nx run agent-workflow-rules:build` first.');
        throw new CliExitError(1, '');
    }

    const distRulesConfigPath = join(cwd, 'dist', 'packages', 'tooling', 'rules-config');
    if (!existsSync(distRulesConfigPath)) {
        console.error(`[dev-hook-install] Local rules-config build not found at: ${distRulesConfigPath}`);
        console.error('  Run `pnpm nx run rules-config:build` first.');
        throw new CliExitError(1, '');
    }

    const homeDir = homedir();
    const webpiecesDir = join(homeDir, '.webpieces');
    const backupPath = join(webpiecesDir, 'dev-hook-backup.json');
    const claudeSettingsPath = join(homeDir, '.claude', 'settings.json');

    if (existsSync(backupPath)) {
        console.error('[dev-hook-install] Dev hook is already installed (backup file exists).');
        console.error('  Run `node dist/packages/tooling/agent-workflow-rules/src/bin/dev-hook-uninstall.js` first to remove the current dev hook.');
        throw new CliExitError(1, '');
    }

    wireLocalRulesConfig(cwd, distRulesConfigPath);

    let settings: ClaudeSettings = {};
    if (existsSync(claudeSettingsPath)) {
        settings = JSON.parse(readFileSync(claudeSettingsPath, 'utf8')) as ClaudeSettings;
    }

    // Save whatever hooks exist now (may be undefined/null) so uninstall can restore them
    const backup: DevHookBackup = { previousHooks: settings.hooks ?? null };
    if (!existsSync(webpiecesDir)) {
        mkdirSync(webpiecesDir, { recursive: true });
    }
    writeFileSync(backupPath, JSON.stringify(backup, null, 4) + '\n');

    // Mirror production wiring: rules hook on file tools, guards hook on file + Bash tools.
    settings.hooks = {
        PreToolUse: [
            {
                matcher: 'Write|Edit|MultiEdit',
                hooks: [{ type: 'command', command: `node ${rulesHookPath}` }],
            },
            {
                matcher: 'Write|Edit|MultiEdit|Bash|Read',
                hooks: [{ type: 'command', command: `node ${guardsHookPath}` }],
            },
        ],
    };

    mkdirSync(dirname(claudeSettingsPath), { recursive: true });
    writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 4) + '\n');

    console.log(`  Dev hooks installed → node ${rulesHookPath} (rules), node ${guardsHookPath} (guards)`);
    console.log('  Run `node dist/packages/tooling/agent-workflow-rules/src/bin/dev-hook-uninstall.js` when done testing.');
}

if (require.main === module) runMain(runDevHookInstall);
