import { existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';

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

function wireLocalRulesConfig(cwd: string, distRulesConfigPath: string): void {
    // Place the symlink in dist/packages/tooling/node_modules/ — one level above
    // the ai-hook-rules package output but still below the workspace root node_modules.
    // Node's require() resolution walks up from the requiring file and finds this
    // node_modules entry before reaching the workspace root's stale published package.
    // This directory is NOT wiped by any individual package build (each build only
    // cleans its own output subfolder), so it survives pnpm run build-all.
    const overrideDir = join(cwd, 'dist', 'packages', 'tooling', 'node_modules', '@webpieces');
    const overrideLink = join(overrideDir, 'rules-config');
    mkdirSync(overrideDir, { recursive: true });
    if (existsSync(overrideLink)) {
        rmSync(overrideLink, { recursive: true });
    }
    symlinkSync(distRulesConfigPath, overrideLink);
}

export function main(): void {
    const cwd = process.cwd();
    const distHookPath = join(cwd, 'dist', 'packages', 'tooling', 'ai-hook-rules', 'src', 'adapters', 'claude-code-hook.js');

    if (!existsSync(distHookPath)) {
        console.error(`[wp-dev-hook-install] Local build not found at: ${distHookPath}`);
        console.error('  Run `pnpm run build-all` first.');
        process.exit(1);
    }

    const distRulesConfigPath = join(cwd, 'dist', 'packages', 'tooling', 'rules-config');
    if (!existsSync(distRulesConfigPath)) {
        console.error(`[wp-dev-hook-install] Local rules-config build not found at: ${distRulesConfigPath}`);
        console.error('  Run `pnpm run build-all` first.');
        process.exit(1);
    }

    const homeDir = homedir();
    const webpiecesDir = join(homeDir, '.webpieces');
    const backupPath = join(webpiecesDir, 'dev-hook-backup.json');
    const claudeSettingsPath = join(homeDir, '.claude', 'settings.json');

    if (existsSync(backupPath)) {
        console.error('[wp-dev-hook-install] Dev hook is already installed (backup file exists).');
        console.error('  Run `wp-dev-hook-uninstall` first to remove the current dev hook.');
        process.exit(1);
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

    const hookCommand = `node ${distHookPath}`;
    settings.hooks = {
        PreToolUse: [
            {
                matcher: 'Write|Edit|MultiEdit|Bash',
                hooks: [{ type: 'command', command: hookCommand }],
            },
        ],
    };

    mkdirSync(dirname(claudeSettingsPath), { recursive: true });
    writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 4) + '\n');

    console.log(`  Dev hook installed → ${hookCommand}`);
    console.log('  Run `wp-dev-hook-uninstall` when done testing.');
}

if (require.main === module) {
    main();
}
