import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'fs';
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

export function main(): void {
    const homeDir = homedir();
    const webpiecesDir = join(homeDir, '.webpieces');
    const globalHookDest = join(webpiecesDir, 'global-hook.js');
    const claudeSettingsPath = join(homeDir, '.claude', 'settings.json');

    // Find compiled global-hook.js relative to this compiled file (src/bin/ → src/adapters/)
    const shimSource = join(__dirname, '..', 'adapters', 'global-hook.js');

    if (!existsSync(shimSource)) {
        console.error(`[wp-setup-global-ai-hooks] Cannot find compiled hook at: ${shimSource}`);
        console.error('  Make sure the package is built first.');
        process.exit(1);
    }

    // Create ~/.webpieces/ if needed
    if (!existsSync(webpiecesDir)) {
        mkdirSync(webpiecesDir, { recursive: true });
    }

    copyFileSync(shimSource, globalHookDest);
    console.log(`  Installed global hook → ${globalHookDest}`);

    // Wire into ~/.claude/settings.json using absolute path (~ is not expanded by Claude Code)
    const hookCommand = `node ${globalHookDest}`;

    let settings: ClaudeSettings = {};
    if (existsSync(claudeSettingsPath)) {
        settings = JSON.parse(readFileSync(claudeSettingsPath, 'utf8')) as ClaudeSettings;
    }

    if (!settings.hooks) settings.hooks = {};
    if (!Array.isArray(settings.hooks.PreToolUse)) settings.hooks.PreToolUse = [];

    const alreadyWired = settings.hooks.PreToolUse.some((e) =>
        e.hooks.some((h) => h.command.includes('global-hook.js')),
    );

    if (alreadyWired) {
        console.log('  ~/.claude/settings.json already has the global hook — skipping.');
    } else {
        settings.hooks.PreToolUse.push({
            matcher: 'Write|Edit|MultiEdit|Bash',
            hooks: [{ type: 'command', command: hookCommand }],
        });
        mkdirSync(dirname(claudeSettingsPath), { recursive: true });
        writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 4) + '\n');
        console.log(`  Wired global hook into ~/.claude/settings.json`);
    }

    console.log('');
    console.log('✅ Global webpieces hook installed.');
    console.log('   IMPORTANT: Remove any per-project hook entries from .claude/settings.json files.');
    console.log('   The global hook delegates to each repo\'s ./node_modules/.bin/wp-ai-hook automatically.');
    console.log('');
    console.log('   If a project lacks webpieces, the hook will ask AI to warn you and offer:');
    console.log('     A) Install webpieces in that project');
    console.log('     B) Write a .skiphooks file to bypass temporarily or forever');
}

if (require.main === module) {
    main();
}
