import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
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

export function main(): void {
    const cwd = process.cwd();
    const distHookPath = join(cwd, 'dist', 'packages', 'tooling', 'ai-hook-rules', 'src', 'adapters', 'claude-code-hook.js');

    if (!existsSync(distHookPath)) {
        console.error(`[wp-dev-hook-install] Local build not found at: ${distHookPath}`);
        console.error('  Run `nx build ai-hook-rules` first.');
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

    // Replace hooks with a single entry pointing at the local dist build
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
    console.log('');
    console.log('  RESTART Claude Code to activate the local build hook.');
    console.log('  Run `wp-dev-hook-uninstall` when done testing.');
}

if (require.main === module) {
    main();
}
