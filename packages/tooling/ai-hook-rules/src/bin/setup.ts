import * as fs from 'fs';
import * as path from 'path';

import { builtInRuleNames } from '../core/rules/index';

const HOOK_COMMAND = './node_modules/.bin/wp-ai-hook';
const CONFIG_FILENAME = 'webpieces.config.json';

interface HookEntry {
    matcher: string;
    hooks: Array<{ type: string; command: string }>;
}

interface ClaudeSettings {
    hooks?: {
        PreToolUse?: HookEntry[];
    };
    // webpieces-disable no-any-unknown -- opaque settings bag allows arbitrary key access
    [key: string]: unknown;
}

interface RulesConfig {
    rules: Record<string, object>;
    rulesDir?: string[];
}

function settingsAlreadyHasHook(settingsPath: string): boolean {
    if (!fs.existsSync(settingsPath)) return false;
    const content = fs.readFileSync(settingsPath, 'utf8');
    return content.includes('wp-ai-hook');
}

function wireSettings(projectRoot: string): void {
    const claudeDir = path.join(projectRoot, '.claude');
    if (!fs.existsSync(claudeDir)) {
        console.log('  [ai-hook-rules] No .claude/ directory found — add the hook manually:');
        console.log('  In .claude/settings.json under hooks.PreToolUse, add:');
        console.log(`  { "matcher": "Write|Edit|MultiEdit|Bash", "hooks": [{ "type": "command", "command": "${HOOK_COMMAND}" }] }`);
        return;
    }

    const settingsPath = path.join(claudeDir, 'settings.json');

    if (settingsAlreadyHasHook(settingsPath)) {
        console.log('  [ai-hook-rules] .claude/settings.json already has the hook — skipping.');
        return;
    }

    let settings: ClaudeSettings = {};
    if (fs.existsSync(settingsPath)) {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as ClaudeSettings;
    }

    if (!settings.hooks) settings.hooks = {};
    if (!Array.isArray(settings.hooks.PreToolUse)) settings.hooks.PreToolUse = [];

    settings.hooks.PreToolUse.push({
        matcher: 'Write|Edit|MultiEdit|Bash',
        hooks: [{ type: 'command', command: HOOK_COMMAND }],
    });

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4) + '\n');
    console.log(`  [ai-hook-rules] Wired ${HOOK_COMMAND} into .claude/settings.json`);
}

function seedConfig(projectRoot: string): void {
    const configPath = path.join(projectRoot, CONFIG_FILENAME);
    if (fs.existsSync(configPath)) {
        console.log(`  [ai-hook-rules] ${CONFIG_FILENAME} already exists — run with --sync to add missing rules.`);
        return;
    }

    const rules: Record<string, object> = {};
    for (const name of builtInRuleNames) {
        rules[name] = { mode: 'OFF' };
    }

    const config: RulesConfig = { rules, rulesDir: [] };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4) + '\n');
    console.log(`  [ai-hook-rules] Created ${CONFIG_FILENAME} with all rules set to OFF.`);
    console.log('  Review and enable the rules you want by changing "mode" to "ON" or "MODIFIED_CODE" etc.');
}

function syncConfig(projectRoot: string): void {
    const configPath = path.join(projectRoot, CONFIG_FILENAME);

    let config: RulesConfig = { rules: {}, rulesDir: [] };
    if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as RulesConfig;
    }
    if (!config.rules) config.rules = {};

    const added: string[] = [];
    for (const name of builtInRuleNames) {
        if (!Object.prototype.hasOwnProperty.call(config.rules, name)) {
            config.rules[name] = { mode: 'OFF' };
            added.push(name);
        }
    }

    if (added.length === 0) {
        console.log(`  [ai-hook-rules] ${CONFIG_FILENAME} is already up to date — no new rules to add.`);
        return;
    }

    fs.writeFileSync(configPath, JSON.stringify(config, null, 4) + '\n');
    console.log(`  [ai-hook-rules] Added ${added.length} new rule(s) to ${CONFIG_FILENAME} (set to OFF):`);
    for (const name of added) {
        console.log(`    - ${name}`);
    }
    console.log('  Review each new rule and set "mode" to ON/MODIFIED_CODE/etc. as desired.');
}

export function main(): void {
    const args = process.argv.slice(2);
    const isSync = args.includes('--sync');

    const projectRoot = process.cwd();

    if (isSync) {
        syncConfig(projectRoot);
    } else {
        seedConfig(projectRoot);
        console.log('');
        console.log('  To install the global Claude Code hook (one-time, per machine):');
        console.log('    ./node_modules/.bin/wp-setup-global-ai-hooks');
    }
}

if (require.main === module) {
    main();
}
