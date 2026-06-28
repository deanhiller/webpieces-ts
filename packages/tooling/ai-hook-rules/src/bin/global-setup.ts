import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync } from 'fs';
import { createInterface } from 'readline';
import { homedir } from 'os';
import { join, dirname } from 'path';

interface HookCommand {
    type: string;
    command: string;
}

interface HookEntry {
    matcher: string;
    hooks: Array<HookCommand>;
}

interface ClaudeSettings {
    hooks?: {
        PreToolUse?: HookEntry[];
    };
    // webpieces-disable no-any-unknown -- opaque settings bag; arbitrary keys allowed
    [key: string]: unknown;
}

function prompt(question: string): Promise<string> {
    return new Promise((resolve: (answer: string) => void) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, (answer: string) => {
            rl.close();
            resolve(answer.trim().toLowerCase());
        });
    });
}

function isWired(settings: ClaudeSettings): boolean {
    return (settings.hooks?.PreToolUse ?? []).some((e: HookEntry) =>
        e.hooks.some((h: HookCommand) => h.command.includes('global-hook.js')),
    );
}

function installHook(settings: ClaudeSettings, shimSource: string, globalHookDest: string, claudeSettingsPath: string): void {
    mkdirSync(dirname(globalHookDest), { recursive: true });
    copyFileSync(shimSource, globalHookDest);

    const hookCommand = `node ${globalHookDest}`;
    if (!settings.hooks) settings.hooks = {};
    if (!Array.isArray(settings.hooks.PreToolUse)) settings.hooks.PreToolUse = [];
    settings.hooks.PreToolUse.push({
        matcher: 'Write|Edit|MultiEdit|Bash',
        hooks: [{ type: 'command', command: hookCommand }],
    });
    mkdirSync(dirname(claudeSettingsPath), { recursive: true });
    writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 4) + '\n');

    console.log(`  Installed global hook → ${globalHookDest}`);
    console.log(`  Wired into ~/.claude/settings.json`);
    console.log('');
    console.log('✅ Global webpieces hook installed.');
    console.log('   The global hook delegates to each repo\'s ./node_modules/.bin/wp-ai-hook automatically.');
}

function uninstallHook(settings: ClaudeSettings, globalHookDest: string, claudeSettingsPath: string): void {
    if (settings.hooks?.PreToolUse) {
        settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter((e: HookEntry) =>
            !e.hooks.some((h: HookCommand) => h.command.includes('global-hook.js')),
        );
    }
    writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 4) + '\n');
    if (existsSync(globalHookDest)) {
        rmSync(globalHookDest);
    }
    console.log('✅ Global webpieces hook removed.');
}

export async function main(): Promise<void> {
    const homeDir = homedir();
    const globalHookDest = join(homeDir, '.webpieces', 'global-hook.js');
    const claudeSettingsPath = join(homeDir, '.claude', 'settings.json');
    const shimSource = join(__dirname, '..', 'adapters', 'global-hook.js');

    if (!existsSync(shimSource)) {
        console.error(`[wp-setup-global-ai-hooks] Cannot find compiled hook at: ${shimSource}`);
        process.exit(1);
    }

    let settings: ClaudeSettings = {};
    if (existsSync(claudeSettingsPath)) {
        settings = JSON.parse(readFileSync(claudeSettingsPath, 'utf8')) as ClaudeSettings;
    }

    if (isWired(settings)) {
        const answer = await prompt('Global hook is already installed. Uninstall? [y/N]: ');
        if (answer === 'y') {
            uninstallHook(settings, globalHookDest, claudeSettingsPath);
        } else {
            console.log('  No changes made.');
        }
    } else {
        const answer = await prompt('Install global webpieces hook into ~/.claude/settings.json? [Y/n]: ');
        if (answer !== 'n') {
            installHook(settings, shimSource, globalHookDest, claudeSettingsPath);
        } else {
            console.log('  No changes made.');
        }
    }
}

if (require.main === module) {
    void main();
}
