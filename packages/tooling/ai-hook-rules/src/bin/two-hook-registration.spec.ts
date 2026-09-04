import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { applyHook, installTargets, GUARDS_HOOK, RULES_HOOK, InstallTarget } from './setup';
import {
    GUARDS_BIN, RULES_BIN, REGISTRATION_SURFACE, ENV_SURFACE, ClaudeSettings, LEGACY_GUARANTEE_ROOT_MARKER,
    HookEntry, managedSurfaceDrift, readSettings, registrationStale, expectedEntries,
    repairRegistration, writeSettings, SHIM_SURFACE, CLAUDE_REGISTRATION,
} from './hook-registration';
import { BASH_CWD_ENV_KEY, BASH_CWD_ENV_VALUE } from './managed-env';
import { SHIM_MARKER, renderShim, shimPath } from './shim';
import { runUpgradeShim } from './upgrade-shim';

/**
 * THE TWO-HOOK ABSOLUTE REGISTRATION, end to end.
 *
 * This replaces `three-hook-registration.spec.ts`. That form was H1 `guarantee-root.sh` ABSOLUTE plus
 * H2/H3 RELATIVE, on the theory that a relative path lets each git tree run its own release. MEASURED:
 * it never did — a linked worktree has no `node_modules`, so the shim's upward walk always executed the
 * MAIN tree's binary. The relative pair only bought a hazard (a hook that cannot resolve exits 127, a
 * NON-BLOCKING error, i.e. a silent unguarded allow), and L-1 existed solely to police it by denying
 * every `cd` into a subdirectory.
 *
 * Both hooks are ABSOLUTE now, so resolution is structural and L-1 is deleted. What this suite must
 * pin, in order of how badly it hurts to get wrong:
 *   1. an OLD three-hook settings file MIGRATES — the retired H1 entry is REMOVED, not left behind;
 *   2. the retired FILE is deleted;
 *   3. drift reports THREE surfaces, never the retired fourth.
 */

function mktmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'wp-2hook-'));
}

function targetsIn(root: string): InstallTarget[] {
    return installTargets(root, path.join(root, 'fake-home'));
}

function commandsIn(settingsPath: string): string[] {
    const entries: readonly HookEntry[] = readSettings(settingsPath).hooks?.PreToolUse ?? [];
    return entries.flatMap((e: HookEntry): string[] => e.hooks.map((h: { command: string }): string => h.command));
}

/** A settings.json exactly as the RETIRED three-hook release wrote it: H1 absolute, H2/H3 relative. */
function stageRetiredThreeHookForm(root: string): string {
    const settingsPath = path.join(root, '.claude', 'settings.json');
    const settings: ClaudeSettings = {
        hooks: {
            PreToolUse: [
                { matcher: 'Bash', hooks: [{ type: 'command', command: `sh "$CLAUDE_PROJECT_DIR/${LEGACY_GUARANTEE_ROOT_MARKER}"` }] },
                { matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: `sh "${SHIM_MARKER}" ${RULES_BIN}` }] },
                { matcher: 'Write|Edit|MultiEdit|Bash|Read', hooks: [{ type: 'command', command: `sh "${SHIM_MARKER}" ${GUARDS_BIN}` }] },
            ],
        },
        env: { [BASH_CWD_ENV_KEY]: BASH_CWD_ENV_VALUE },
    };
    writeSettings(settingsPath, settings);
    fs.mkdirSync(path.join(root, '.claude', 'webpieces'), { recursive: true });
    fs.writeFileSync(path.join(root, LEGACY_GUARANTEE_ROOT_MARKER), '#!/bin/sh\nexit 0\n');
    return settingsPath;
}

describe('the expected registration is TWO absolute entries', () => {
    it('both commands are absolute via $CLAUDE_PROJECT_DIR, and neither is the retired hook', () => {
        const entries = expectedEntries(CLAUDE_REGISTRATION, [GUARDS_BIN, RULES_BIN]);
        expect(entries).toHaveLength(2);
        for (const entry of entries) {
            expect(entry.command).toContain('$CLAUDE_PROJECT_DIR');
            expect(entry.command).toContain(SHIM_MARKER);
            expect(entry.command).not.toContain(LEGACY_GUARANTEE_ROOT_MARKER);
        }
    });

    /**
     * THE REGRESSION THIS EXISTS FOR. A relative spelling silently reverts the repo to "each tree runs
     * its own script", which is the model this release removed — and it does so without any drift being
     * reported, because a relative command is still a managed command.
     */
    it('the shim command is never emitted RELATIVE again', () => {
        expect(CLAUDE_REGISTRATION.shimCommand(GUARDS_BIN)).toBe(`sh "$CLAUDE_PROJECT_DIR/${SHIM_MARKER}" ${GUARDS_BIN}`);
        expect(CLAUDE_REGISTRATION.shimCommand(GUARDS_BIN).startsWith(`sh "${SHIM_MARKER}"`)).toBe(false);
    });
});

describe('migrating a settings.json written by the RETIRED three-hook release', () => {
    it('registrationStale() reports it, so fault S fires and the cure runs', () => {
        const root = mktmp();
        const settingsPath = stageRetiredThreeHookForm(root);
        expect(registrationStale(CLAUDE_REGISTRATION, readSettings(settingsPath))).toBe(true);
    });

    /**
     * THE SINGLE MOST IMPORTANT ASSERTION IN THE MIGRATION. If `isManagedCommand()` ever stops matching
     * LEGACY_GUARANTEE_ROOT_MARKER, repair leaves the H1 entry registered against a file this release
     * deletes. That is exit 127 — a NON-BLOCKING error per the hooks reference — so every `cd` goes
     * unjudged while the cure reports success and no drift check can name it.
     */
    it('REMOVES the retired guarantee-root entry rather than leaving it behind', () => {
        const root = mktmp();
        const settingsPath = stageRetiredThreeHookForm(root);
        const settings = readSettings(settingsPath);
        expect(repairRegistration(CLAUDE_REGISTRATION, settings)).toBe(true);
        writeSettings(settingsPath, settings);

        const commands = commandsIn(settingsPath);
        expect(commands.join()).not.toContain(LEGACY_GUARANTEE_ROOT_MARKER);
        expect(commands.sort()).toEqual([CLAUDE_REGISTRATION.shimCommand(GUARDS_BIN), CLAUDE_REGISTRATION.shimCommand(RULES_BIN)].sort());
    });
});

describe('wp-upgrade-shim completes the migration', () => {
    it('deletes the retired guarantee-root.sh file and rewrites the registration', () => {
        const root = mktmp();
        const settingsPath = stageRetiredThreeHookForm(root);
        fs.mkdirSync(path.dirname(shimPath(root)), { recursive: true });
        fs.writeFileSync(shimPath(root), renderShim(), { mode: 0o755 });

        expect(runUpgradeShim(root)).toBe(0);

        expect(fs.existsSync(path.join(root, LEGACY_GUARANTEE_ROOT_MARKER))).toBe(false);
        expect(commandsIn(settingsPath).join()).not.toContain(LEGACY_GUARANTEE_ROOT_MARKER);
        expect(managedSurfaceDrift(root)).toEqual([]);
    });
});

/**
 * The half-state that must never exist: a settings entry naming a `.sh` file that is gone. A hook that
 * cannot launch exits 127, which the Claude Code hooks reference defines as a NON-BLOCKING error — so
 * the tool call PROCEEDS, unjudged, with nothing surfaced. That is strictly worse than either endpoint.
 *
 * `runUpgradeShim()` therefore repairs the REGISTRATION first and deletes the FILE second, so the only
 * transient state is an orphaned file nothing references. This pins the order by asserting the endpoint
 * both ways: whatever happens, the two never disagree.
 */
describe('the retired hook is never left registered-but-missing', () => {
    it('removes the entry and the file together, entry first', () => {
        const root = mktmp();
        const settingsPath = stageRetiredThreeHookForm(root);
        fs.mkdirSync(path.dirname(shimPath(root)), { recursive: true });
        fs.writeFileSync(shimPath(root), renderShim(), { mode: 0o755 });

        expect(runUpgradeShim(root)).toBe(0);

        const registered = commandsIn(settingsPath).join().includes(LEGACY_GUARANTEE_ROOT_MARKER);
        const present = fs.existsSync(path.join(root, LEGACY_GUARANTEE_ROOT_MARKER));
        expect(registered, 'entry survived').toBe(false);
        expect(present, 'file survived').toBe(false);
        // The invariant, stated as such: registered implies present. Never the other way.
        expect(!registered || present, 'registered but missing = exit 127 = silent unguarded allow').toBe(true);
    });
});

describe('the managed surface names the shim, the registration, the env entry and neighbour anchoring', () => {
    it('never names a guarantee-root surface — L-1 is retired, not renamed', () => {
        const root = mktmp();
        stageRetiredThreeHookForm(root);
        const drifted = managedSurfaceDrift(root);
        expect(drifted).toContain(REGISTRATION_SURFACE);
        expect(drifted.join()).not.toContain('guarantee-root');
        expect([SHIM_SURFACE, REGISTRATION_SURFACE, ENV_SURFACE, CLAUDE_REGISTRATION.neighbourSurface]).toHaveLength(4);
    });
});

describe('a fresh install writes the two-hook absolute form', () => {
    it('installs both hooks absolute and creates no guarantee-root.sh', () => {
        const root = mktmp();
        const targets = targetsIn(root);
        applyHook(GUARDS_HOOK, targets[0], targets, root);
        applyHook(RULES_HOOK, targets[0], targets, root);

        const commands = commandsIn(targets[0].settingsPath);
        expect(commands.every((c: string): boolean => c.includes('$CLAUDE_PROJECT_DIR'))).toBe(true);
        expect(fs.existsSync(path.join(root, LEGACY_GUARANTEE_ROOT_MARKER))).toBe(false);
    });
});

/**
 * THE REFERENCE FILE — `templates/claude-settings-hook.json`, the thing a consumer copies.
 *
 * Nothing tested it, and it regressed twice in one branch: it lost the managed `env` entry (so a
 * consumer copying it would be reported STALE by the guard the same package ships) and it named
 * `wp-setup-ai-hooks`, a bin that has not existed since it was renamed. That dead name already has its
 * own spec at l0-matrix.spec.ts because a deny once prescribed it and was uninstallable — an install
 * reference is a worse place to reintroduce it than a deny.
 *
 * So it is pinned against the RENDERERS rather than proofread: a template that cannot drift from
 * expectedEntries() cannot teach a removed spelling.
 */
describe('templates/claude-settings-hook.json is the shape this release installs', () => {
    const template = (): ClaudeSettings => JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', '..', 'templates', 'claude-settings-hook.json'), 'utf8',
    )) as ClaudeSettings;

    it('registers exactly what expectedEntries() wants, absolute and with no retired hook', () => {
        const entries: readonly HookEntry[] = template().hooks?.PreToolUse ?? [];
        const commands = entries.flatMap((e: HookEntry): string[] => e.hooks.map((h: { command: string }): string => h.command));
        expect(commands.sort()).toEqual([CLAUDE_REGISTRATION.shimCommand(GUARDS_BIN), CLAUDE_REGISTRATION.shimCommand(RULES_BIN)].sort());
        expect(commands.join()).not.toContain(LEGACY_GUARANTEE_ROOT_MARKER);
    });

    it('carries the managed env entry — without it a consumer copying this file is instantly stale', () => {
        expect(template().env?.[BASH_CWD_ENV_KEY]).toBe(BASH_CWD_ENV_VALUE);
    });

    it('names the installer that exists, never the bin renamed away from', () => {
        const raw = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'claude-settings-hook.json'), 'utf8');
        expect(raw).toContain('wp-install-ai-hooks');
        expect(raw).not.toContain('wp-setup-ai-hooks');
    });
});
