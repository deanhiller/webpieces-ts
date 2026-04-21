#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

const BRIDGE_CONTENT = `#!/usr/bin/env node\nrequire('@webpieces/ai-hook-rules/claude-code').main();\n`;

function findProjectRoot(): string | null {
    // Walk up from this file's location to escape node_modules
    // e.g. /project/node_modules/@webpieces/ai-hook-rules/src/bin/postinstall.js -> /project
    let dir = __dirname;
    while (dir !== path.dirname(dir)) {
        dir = path.dirname(dir);
        const base = path.basename(dir);
        if (base === 'node_modules') {
            return path.dirname(dir);
        }
    }
    return null;
}

function createBridgeFile(projectRoot: string): void {
    const hooksDir = path.join(projectRoot, '.webpieces', 'ai-hooks');
    const bridgePath = path.join(hooksDir, 'claude-code-hook.js');

    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(bridgePath, BRIDGE_CONTENT);
    fs.chmodSync(bridgePath, 0o755);
    console.log('  [ai-hook-rules] Created .webpieces/ai-hooks/claude-code-hook.js');
}

function seedConfigIfMissing(projectRoot: string): void {
    const configPath = path.join(projectRoot, 'webpieces.ai-hooks.json');
    if (fs.existsSync(configPath)) return;

    const templatePath = path.join(__dirname, '..', '..', 'templates', 'webpieces.ai-hooks.seed.json');
    if (!fs.existsSync(templatePath)) return;

    fs.copyFileSync(templatePath, configPath);
    console.log('  [ai-hook-rules] Created webpieces.ai-hooks.json (default config)');
}

function settingsAlreadyHasHook(settingsPath: string): boolean {
    if (!fs.existsSync(settingsPath)) return false;

    const content = fs.readFileSync(settingsPath, 'utf8');
    return content.includes('claude-code-hook.js');
}

interface HookEntry {
    matcher: string;
    hooks: Array<{ type: string; command: string }>;
}

interface SettingsTemplate {
    hooks: {
        PreToolUse: HookEntry[];
    };
}

interface ClaudeSettings {
    hooks?: {
        PreToolUse?: HookEntry[];
    };
    [key: string]: string | number | boolean | object | null | undefined;
}

function loadTemplate(): SettingsTemplate {
    const templatePath = path.join(__dirname, '..', '..', 'templates', 'claude-settings-hook.json');
    const raw = fs.readFileSync(templatePath, 'utf8');
    return JSON.parse(raw) as SettingsTemplate;
}

function mergeHookIntoSettings(settingsPath: string): void {
    const template = loadTemplate();
    const hookEntry = template.hooks.PreToolUse[0];

    let settings: ClaudeSettings = {};
    if (fs.existsSync(settingsPath)) {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as ClaudeSettings;
    }

    if (!settings.hooks) {
        settings.hooks = {};
    }
    if (!Array.isArray(settings.hooks.PreToolUse)) {
        settings.hooks.PreToolUse = [];
    }

    settings.hooks.PreToolUse.push(hookEntry);
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4) + '\n');
}

function backupSettings(settingsPath: string): void {
    if (fs.existsSync(settingsPath)) {
        const bakPath = settingsPath + '.bak';
        fs.copyFileSync(settingsPath, bakPath);
        console.log('  [ai-hook-rules] Backed up .claude/settings.json to .claude/settings.json.bak');
    }
}

function printManualInstructions(): void {
    console.log('');
    console.log('  [ai-hook-rules] To enable AI code-quality hooks, add this to .claude/settings.json:');
    console.log('');
    console.log('  {');
    console.log('      "hooks": {');
    console.log('          "PreToolUse": [{');
    console.log('              "matcher": "Write|Edit|MultiEdit|Bash",');
    console.log('              "hooks": [{');
    console.log('                  "type": "command",');
    console.log('                  "command": "node .webpieces/ai-hooks/claude-code-hook.js"');
    console.log('              }]');
    console.log('          }]');
    console.log('      }');
    console.log('  }');
    console.log('');
}

function promptUser(settingsPath: string): Promise<void> {
    return new Promise((resolve: () => void) => {
        const isInteractive = process.stdin.isTTY && process.stdout.isTTY;
        if (!isInteractive) {
            console.log('  [ai-hook-rules] Non-interactive terminal detected, skipping .claude/settings.json setup.');
            printManualInstructions();
            resolve();
            return;
        }

        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

        console.log('');
        console.log('  [ai-hook-rules] Would like to add a PreToolUse hook to .claude/settings.json');
        console.log('  This enables AI code-quality validation (rules configured in webpieces.ai-hooks.json).');
        if (fs.existsSync(settingsPath)) {
            console.log('  Your current settings.json will be backed up to .claude/settings.json.bak');
        }
        console.log('');

        rl.question('  Proceed? [y/N] ', (answer: string) => {
            rl.close();
            const yes = answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
            if (yes) {
                backupSettings(settingsPath);
                mergeHookIntoSettings(settingsPath);
                console.log('  [ai-hook-rules] Added PreToolUse hook to .claude/settings.json');
            } else {
                printManualInstructions();
            }
            resolve();
        });
    });
}

export async function main(): Promise<void> {
    const projectRoot = findProjectRoot();
    if (!projectRoot) {
        // Not running from node_modules (maybe local dev / workspace) — skip
        return;
    }

    // 1. Always create the bridge file
    createBridgeFile(projectRoot);

    // 2. Seed config if missing
    seedConfigIfMissing(projectRoot);

    // 3. Check if .claude/ exists — if not, skip settings.json
    const claudeDir = path.join(projectRoot, '.claude');
    if (!fs.existsSync(claudeDir)) {
        return;
    }

    // 4. Check if settings.json already has the hook — if yes, done
    const settingsPath = path.join(claudeDir, 'settings.json');
    if (settingsAlreadyHasHook(settingsPath)) {
        return;
    }

    // 5. Prompt user to add the hook
    await promptUser(settingsPath);
}

// eslint-disable-next-line @webpieces/no-unmanaged-exceptions
if (require.main === module) {
    main().catch((err: Error) => {
        // Fail open — don't break pnpm install if postinstall crashes
        console.error('  [ai-hook-rules] postinstall warning:', err.message);
    });
}
