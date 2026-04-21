#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';

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
    const configPath = path.join(projectRoot, 'webpieces.config.json');
    if (fs.existsSync(configPath)) return;

    const templatePath = path.join(__dirname, '..', '..', 'templates', 'webpieces.config.seed.json');
    if (!fs.existsSync(templatePath)) return;

    fs.copyFileSync(templatePath, configPath);
    console.log('  [ai-hook-rules] Created webpieces.config.json (default config)');
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


function setupSettings(settingsPath: string): void {
    // pnpm hides all postinstall output, so no point prompting or logging.
    // The user already consented by running `pnpm approve-builds`.
    backupSettings(settingsPath);
    mergeHookIntoSettings(settingsPath);
}

export function main(): void {
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

    // 5. Backup and add the hook (user consented via pnpm approve-builds)
    setupSettings(settingsPath);
}

if (require.main === module) {
    main();
}
