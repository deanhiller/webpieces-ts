import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    migrate, applyHook, installTargets, readSettings, hasHook, renderShim,
    RULES_HOOK, GUARDS_HOOK,
} from './setup';

function shimFile(root: string): string {
    return path.join(root, '.claude', 'webpieces', 'ai-hook.sh');
}

function mktmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'wp-setup-'));
}

// A temp HOME so the "global" install target never touches the real ~/.claude/settings.json.
function targetsIn(root: string): ReturnType<typeof installTargets> {
    return installTargets(root, mktmp());
}

describe('migrate', () => {
    it('moves guards from rules → hookGuards and a top-level pr-gate → commands', () => {
        const result = migrate({
            rules: {
                'no-any-unknown': { mode: 'NEW_AND_MODIFIED_CODE', ignoreModifiedUntilEpoch: 0 },
                'pr-creation-guard': { mode: 'ON', ignoreModifiedUntilEpoch: 0 },
            },
            'pr-gate': { mode: 'OFF', buildCommand: 'echo ci', gates: [] },
        });

        expect(result.config.rules['no-any-unknown']).toBeDefined();
        expect(result.config.rules['pr-creation-guard']).toBeUndefined();
        expect(result.config.hookGuards['pr-creation-guard']).toBeDefined();
        expect(result.config.commands['pr-gate']).toBeDefined();
        expect((result.config as { 'pr-gate'?: unknown })['pr-gate']).toBeUndefined();
        expect(result.config.commands['upsertPr']).toBe('pnpm wp-start-upsert-pr');
        expect(result.config.commands['mergeComplete']).toBe('pnpm wp-finish-upsert-pr');
    });

    it('adds every missing built-in into its correct section (OFF)', () => {
        const result = migrate({ rules: {}, hookGuards: {}, commands: { 'pr-gate': { mode: 'OFF' } } });
        // A code rule and a guard both get seeded into the right section.
        expect(result.config.rules['max-file-lines']).toEqual({ mode: 'OFF', ignoreModifiedUntilEpoch: 0 });
        expect(result.config.hookGuards['branch-creation-guard']).toEqual({ mode: 'OFF', ignoreModifiedUntilEpoch: 0 });
    });

    it('reports no changes for an already-migrated config', () => {
        const once = migrate({ rules: {}, hookGuards: {}, commands: {} }).config;
        const twice = migrate({ ...once });
        expect(twice.changes).toEqual([]);
    });
});

describe('applyHook', () => {
    it('installs the rules hook into project-for-you (settings.local.json) with the right matcher', () => {
        const root = mktmp();
        const targets = targetsIn(root);
        const projectForYou = targets[1];
        applyHook(RULES_HOOK, projectForYou, targets, root);

        const settings = readSettings(projectForYou.settingsPath);
        expect(hasHook(settings, 'wp-ai-rules-hook')).toBe(true);
        const entry = settings.hooks!.PreToolUse![0];
        expect(entry.matcher).toBe('Write|Edit|MultiEdit');
        // Project install points at the checked-in shim via $CLAUDE_PROJECT_DIR (so the hook
        // resolves from any cwd — a subdir or a nested clone — instead of 127ing), passing the bin.
        expect(entry.hooks[0].command).toBe('"$CLAUDE_PROJECT_DIR/.claude/webpieces/ai-hook.sh" wp-ai-rules-hook');
    });

    it('installs the guards hook globally with an absolute exact path (no bridge)', () => {
        const root = mktmp();
        const targets = targetsIn(root);
        const global = targets[2];
        applyHook(GUARDS_HOOK, global, targets, root);

        const settings = readSettings(global.settingsPath);
        const cmd = settings.hooks!.PreToolUse!.find(e => e.matcher === 'Write|Edit|MultiEdit|Bash')!.hooks[0].command;
        expect(cmd).toBe(`node ${path.join(root, 'node_modules', '.bin', 'wp-ai-guards-hook')}`);
        expect(cmd).not.toContain('global-hook.js');
    });

    it('moves a hook between locations and uninstalls cleanly', () => {
        const root = mktmp();
        const targets = targetsIn(root);
        // Install to project, then move to project-for-you.
        applyHook(RULES_HOOK, targets[0], targets, root);
        applyHook(RULES_HOOK, targets[1], targets, root);
        expect(hasHook(readSettings(targets[0].settingsPath), 'wp-ai-rules-hook')).toBe(false);
        expect(hasHook(readSettings(targets[1].settingsPath), 'wp-ai-rules-hook')).toBe(true);

        // Uninstall (choose none).
        applyHook(RULES_HOOK, null, targets, root);
        expect(hasHook(readSettings(targets[1].settingsPath), 'wp-ai-rules-hook')).toBe(false);
    });
});

describe('applyHook — checked-in shim management', () => {
    it('writes an executable checked-in shim for a project install', () => {
        const root = mktmp();
        const targets = targetsIn(root);
        applyHook(RULES_HOOK, targets[0], targets, root);

        const shim = shimFile(root);
        expect(fs.existsSync(shim)).toBe(true);
        expect(fs.statSync(shim).mode & 0o111).not.toBe(0); // executable bit set
        // Generic shim: no hard-coded bin, reads it from $1 and degrades gracefully.
        const body = fs.readFileSync(shim, 'utf8');
        expect(body).toContain('BIN_NAME="$1"');
        expect(body).toContain("Run 'pnpm install'");
        // Fail closed when the bin is missing: deny via the PreToolUse JSON protocol (blocks the call
        // AND surfaces the reason), not a bare exit 2 (blocks but hides the reason in the UI).
        expect(body).toContain('"permissionDecision":"deny"');
    });

    it('keeps the shared shim while the other hook still uses it, removes it once neither does', () => {
        const root = mktmp();
        const targets = targetsIn(root);
        applyHook(RULES_HOOK, targets[0], targets, root);
        applyHook(GUARDS_HOOK, targets[0], targets, root);
        expect(fs.existsSync(shimFile(root))).toBe(true);

        // Uninstall rules — guards still references the shim, so it must stay.
        applyHook(RULES_HOOK, null, targets, root);
        expect(fs.existsSync(shimFile(root))).toBe(true);

        // Uninstall guards too — now nothing references it, so it's removed.
        applyHook(GUARDS_HOOK, null, targets, root);
        expect(fs.existsSync(shimFile(root))).toBe(false);
    });

    it('does not write a shim for a global (absolute) install', () => {
        const root = mktmp();
        const targets = targetsIn(root);
        applyHook(GUARDS_HOOK, targets[2], targets, root);
        expect(fs.existsSync(shimFile(root))).toBe(false);
    });
});

describe('renderShim (runtime behavior via /bin/sh)', () => {
    // Run the rendered shim exactly as Claude Code would: `sh <shim> <bin> ...`, from a repo cwd,
    // piping tool-payload JSON on stdin. spawnSync never throws on non-zero exit.
    function runShim(root: string, bin: string, stdin: string): { status: number | null; stdout: string; stderr: string } {
        // Place the shim at its REAL relative location (<root>/.claude/webpieces/ai-hook.sh) so its
        // self-location (`dirname $0/../..` → <root>) resolves the bin correctly. Run it from a
        // SUBDIR to prove it no longer depends on the caller's cwd (the whole point of the change).
        const shimAbs = path.join(root, '.claude', 'webpieces', 'ai-hook.sh');
        fs.mkdirSync(path.dirname(shimAbs), { recursive: true });
        fs.writeFileSync(shimAbs, renderShim(), { mode: 0o755 });
        const subdir = path.join(root, 'packages', 'deep', 'sub');
        fs.mkdirSync(subdir, { recursive: true });
        const r = spawnSync('/bin/sh', [shimAbs, bin], { cwd: subdir, input: stdin, encoding: 'utf8' });
        return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    }

    it('execs the bin and forwards stdin when it is installed', () => {
        const root = mktmp();
        // Fake bin that echoes its stdin so we can prove stdin was forwarded through exec.
        const binDir = path.join(root, 'node_modules', '.bin');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(path.join(binDir, 'wp-ai-guards-hook'), '#!/bin/sh\ncat\n', { mode: 0o755 });

        const out = runShim(root, 'wp-ai-guards-hook', '{"tool":"Bash"}');
        expect(out.status).toBe(0);
        expect(out.stdout).toBe('{"tool":"Bash"}');
    });

    it('fails closed by DENYING via the PreToolUse JSON protocol (exit 0, reason on stdout) when the bin is absent', () => {
        const root = mktmp(); // no node_modules/.bin here
        const out = runShim(root, 'wp-ai-guards-hook', '{"tool":"Bash"}');
        // Deny via JSON + exit 0 (NOT exit 2): permissionDecision "deny" still blocks the tool, and
        // its reason is surfaced to the user in the terminal UI + to the model — an exit-2 stderr line
        // is not reliably shown on a blocked call. Exit 0 with NO decision would silently allow.
        expect(out.status).toBe(0);
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        const decision = JSON.parse(out.stdout) as {
            hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string };
        };
        expect(decision.hookSpecificOutput.hookEventName).toBe('PreToolUse');
        expect(decision.hookSpecificOutput.permissionDecision).toBe('deny');
        const reason = decision.hookSpecificOutput.permissionDecisionReason;
        expect(reason).toContain("Run 'pnpm install'");
        expect(reason).toContain('not installed');
        expect(reason).toContain('wp-ai-guards-hook');
    });
});
