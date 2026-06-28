import { existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

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
    const homeDir = homedir();
    const backupPath = join(homeDir, '.webpieces', 'dev-hook-backup.json');
    const claudeSettingsPath = join(homeDir, '.claude', 'settings.json');

    if (!existsSync(backupPath)) {
        console.error('[wp-dev-hook-uninstall] No dev hook backup found — dev hook was not installed.');
        process.exit(1);
    }

    const backup = JSON.parse(readFileSync(backupPath, 'utf8')) as DevHookBackup;

    let settings: ClaudeSettings = {};
    if (existsSync(claudeSettingsPath)) {
        settings = JSON.parse(readFileSync(claudeSettingsPath, 'utf8')) as ClaudeSettings;
    }

    if (backup.previousHooks === null) {
        delete settings.hooks;
    } else {
        settings.hooks = backup.previousHooks;
    }

    writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 4) + '\n');
    rmSync(backupPath);

    // Remove the symlink created during install
    const overrideDir = join(cwd, 'dist', 'packages', 'tooling', 'node_modules', '@webpieces');
    const overrideLink = join(overrideDir, 'rules-config');
    if (existsSync(overrideLink)) {
        rmSync(overrideLink, { recursive: true });
    }
    if (existsSync(overrideDir) && readdirSync(overrideDir).length === 0) {
        rmSync(overrideDir, { recursive: true });
    }

    console.log('  Dev hook removed. Previous hook configuration restored.');
}

if (require.main === module) {
    main();
}
