import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { applyHook, installTargets, GUARDS_HOOK, RULES_HOOK, InstallTarget } from './setup';
import {
    GUARANTEE_ROOT_COMMAND, GUARDS_BIN, RULES_BIN, REGISTRATION_SURFACE, ENV_SURFACE, ClaudeSettings,
    HookEntry, envStale, managedEntries, managedSurfaceDrift, readSettings, registrationStale,
    repairRegistration, shimCommand, writeSettings,
} from './hook-registration';
import { BASH_CWD_ENV_KEY, BASH_CWD_ENV_VALUE } from './managed-env';
import { GUARANTEE_ROOT_MARKER, guaranteeRootPath, renderGuaranteeRoot } from './guarantee-root';
import { SHIM_MARKER, renderShim, shimPath } from './shim';
import { runUpgradeShim } from './upgrade-shim';

/**
 * THE THREE-HOOK REGISTRATION, end to end.
 *
 * `.claude/settings.json` used to register two hooks, BOTH absolute via `$CLAUDE_PROJECT_DIR` — a
 * variable that never moves, so every git tree was governed by the PRIMARY's shim, binary and pin
 * forever. This suite pins the replacement: H1 absolute (guarantee-root.sh) plus H2/H3 RELATIVE, so
 * each tree runs its own release.
 *
 * The parts that are POSIX sh are driven through a REAL /bin/sh against real payloads in real trees,
 * for the same reason guarantee-root.spec.ts does: a TypeScript string assertion proves nothing about
 * what `dirname`, `while` or `[ -x ]` actually do.
 */

function mktmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'wp-3hook-'));
}

function targetsIn(root: string): InstallTarget[] {
    return installTargets(root, path.join(root, 'fake-home'));
}

function envIn(settingsPath: string): Record<string, string> | undefined {
    return readSettings(settingsPath).env;
}

function commandsIn(settingsPath: string): string[] {
    const entries: readonly HookEntry[] = readSettings(settingsPath).hooks?.PreToolUse ?? [];
    return entries.flatMap((e: HookEntry): string[] => e.hooks.map((h: { command: string }): string => h.command));
}

/** A settings.json exactly as EVERY release before this one wrote it: two hooks, both absolute. */
function stageOldTwoAbsoluteHooks(root: string): string {
    const settingsPath = path.join(root, '.claude', 'settings.json');
    const settings: ClaudeSettings = {
        hooks: {
            PreToolUse: [
                { matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: `sh "$CLAUDE_PROJECT_DIR/${SHIM_MARKER}" ${RULES_BIN}` }] },
                { matcher: 'Write|Edit|MultiEdit|Bash|Read', hooks: [{ type: 'command', command: `sh "$CLAUDE_PROJECT_DIR/${SHIM_MARKER}" ${GUARDS_BIN}` }] },
            ],
        },
    };
    writeSettings(settingsPath, settings);
    return settingsPath;
}

describe('a fresh install writes THREE hooks and BOTH managed .sh files', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => { logSpy = vi.spyOn(console, 'log').mockImplementation((): void => undefined); });
    afterEach(() => { logSpy.mockRestore(); });

    it('registers H1 absolute and H2/H3 relative, and commits both .sh files', () => {
        const root = mktmp();
        const targets = targetsIn(root);
        applyHook(RULES_HOOK, targets[0], targets, root);
        applyHook(GUARDS_HOOK, targets[0], targets, root);

        const commands = commandsIn(targets[0].settingsPath);
        expect(commands).toHaveLength(3);
        expect(commands).toContain(shimCommand(RULES_BIN));
        expect(commands).toContain(shimCommand(GUARDS_BIN));
        expect(commands).toContain(GUARANTEE_ROOT_COMMAND);

        // H2/H3 carry NO $CLAUDE_PROJECT_DIR — that is the whole point of the change.
        expect(shimCommand(GUARDS_BIN)).not.toContain('$CLAUDE_PROJECT_DIR');
        // H1 does, because it is the one hook that must resolve from ANY cwd or it cannot fail closed.
        expect(GUARANTEE_ROOT_COMMAND).toContain('$CLAUDE_PROJECT_DIR');

        expect(fs.readFileSync(shimPath(root), 'utf8')).toBe(renderShim());
        expect(fs.readFileSync(guaranteeRootPath(root), 'utf8')).toBe(renderGuaranteeRoot());
        expect(fs.statSync(guaranteeRootPath(root)).mode & 0o777).toBe(0o755);

        // The FOURTH managed thing: the env entry that pins the Bash cwd, so the RELATIVE H2/H3 above
        // always resolve — and, being inherited, resolve identically inside every subagent.
        expect(envIn(targets[0].settingsPath)).toEqual({ [BASH_CWD_ENV_KEY]: BASH_CWD_ENV_VALUE });
    });

    it('writes the env entry into settings.local.json when that is the chosen target', () => {
        const root = mktmp();
        const targets = targetsIn(root);
        applyHook(GUARDS_HOOK, targets[1], targets, root);
        expect(envIn(targets[1].settingsPath)).toEqual({ [BASH_CWD_ENV_KEY]: BASH_CWD_ENV_VALUE });
        // and NOT into the file it did not install into
        expect(fs.existsSync(targets[0].settingsPath)).toBe(false);
    });

    it('matches H1 on Bash alone — only Bash can move the shell', () => {
        const root = mktmp();
        const targets = targetsIn(root);
        applyHook(GUARDS_HOOK, targets[0], targets, root);
        const entries: readonly HookEntry[] = readSettings(targets[0].settingsPath).hooks!.PreToolUse!;
        const h1 = entries.find((e: HookEntry): boolean => e.hooks[0].command === GUARANTEE_ROOT_COMMAND)!;
        expect(h1.matcher).toBe('Bash');
    });

    // A GLOBAL install names the bin path directly, so there is no relative path that could fail to
    // resolve — which is the only thing L-1 protects against. It must not be installed there.
    it('installs no L-1 hook and no .sh files for a global (absolute) install', () => {
        const root = mktmp();
        const targets = targetsIn(root);
        applyHook(GUARDS_HOOK, targets[2], targets, root);
        expect(commandsIn(targets[2].settingsPath).join()).not.toContain(GUARANTEE_ROOT_MARKER);
        expect(fs.existsSync(guaranteeRootPath(root))).toBe(false);
    });

    it('removes the L-1 hook and its file on uninstall', () => {
        const root = mktmp();
        const targets = targetsIn(root);
        applyHook(GUARDS_HOOK, targets[0], targets, root);
        expect(fs.existsSync(guaranteeRootPath(root))).toBe(true);
        applyHook(GUARDS_HOOK, null, targets, root);
        expect(commandsIn(targets[0].settingsPath).join()).not.toContain(GUARANTEE_ROOT_MARKER);
        expect(fs.existsSync(guaranteeRootPath(root))).toBe(false);
    });
});

/**
 * THE UPGRADE. The old registration must be REMOVED, not left beside the new one — two spellings of one
 * registration is the compatibility shim the review policy rejects, and in this case it is also a live
 * defect: the absolute entry would keep running the PRIMARY's binary alongside the tree's own.
 */
describe('an UPGRADE from the two-absolute-hook form leaves exactly the three-hook form', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => { logSpy = vi.spyOn(console, 'log').mockImplementation((): void => undefined); });
    afterEach(() => { logSpy.mockRestore(); });

    it('via the installer: one registration per bin, no $CLAUDE_PROJECT_DIR-prefixed guard entry left', () => {
        const root = mktmp();
        const settingsPath = stageOldTwoAbsoluteHooks(root);
        const targets = targetsIn(root);

        applyHook(RULES_HOOK, targets[0], targets, root);
        applyHook(GUARDS_HOOK, targets[0], targets, root);

        const commands = commandsIn(settingsPath);
        expect(commands).toHaveLength(3);
        for (const bin of [RULES_BIN, GUARDS_BIN]) {
            expect(commands.filter((c: string): boolean => c.includes(bin))).toHaveLength(1);
        }
        // The specific regression: NO surviving `$CLAUDE_PROJECT_DIR/`-prefixed guards/rules entry.
        for (const c of commands) {
            if (c.includes(SHIM_MARKER)) expect(c).not.toContain('$CLAUDE_PROJECT_DIR');
        }
    });

    it('via wp-upgrade-shim: same end state, and it also writes the two .sh files', () => {
        const root = mktmp();
        const settingsPath = stageOldTwoAbsoluteHooks(root);
        fs.mkdirSync(path.dirname(shimPath(root)), { recursive: true });
        fs.writeFileSync(shimPath(root), '# a shim from an older release\n');

        const logs: string[] = [];
        const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown): void => { logs.push(String(m)); });
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            expect(runUpgradeShim(root)).toBe(0);
        } finally {
            spy.mockRestore();
        }

        expect(fs.readFileSync(shimPath(root), 'utf8')).toBe(renderShim());
        expect(fs.readFileSync(guaranteeRootPath(root), 'utf8')).toBe(renderGuaranteeRoot());

        const commands = commandsIn(settingsPath);
        expect(commands.sort()).toEqual([GUARANTEE_ROOT_COMMAND, shimCommand(GUARDS_BIN), shimCommand(RULES_BIN)].sort());
        // It has to SAY what it did — an agent reading a cure's output is how it decides it worked.
        expect(logs.join('\n')).toContain('three-hook form');
        expect(logs.join('\n')).toContain('L-1 hook');
    });

    // A settings.local.json install is supported (a team ships the guards, a developer keeps the rules
    // local). The repair must follow the file the hooks are actually in, not assume settings.json.
    it('repairs settings.local.json too, and gives a rules-only file NO L-1 hook', () => {
        const root = mktmp();
        const localPath = path.join(root, '.claude', 'settings.local.json');
        writeSettings(localPath, {
            hooks: { PreToolUse: [{ matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: `sh "$CLAUDE_PROJECT_DIR/${SHIM_MARKER}" ${RULES_BIN}` }] }] },
        });
        fs.mkdirSync(path.dirname(shimPath(root)), { recursive: true });
        fs.writeFileSync(shimPath(root), renderShim());

        const spy = vi.spyOn(console, 'log').mockImplementation((): void => undefined);
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            expect(runUpgradeShim(root)).toBe(0);
        } finally {
            spy.mockRestore();
        }
        // L-1 judges `cd`, which arrives on Bash, and Bash is in the GUARDS matcher — a rules-only file
        // has no Bash hook to protect, so it gets no L-1 entry.
        expect(commandsIn(localPath)).toEqual([shimCommand(RULES_BIN)]);
    });

    it('leaves a GLOBAL (absolute) registration alone — it carries no shim marker to judge', () => {
        const settings: ClaudeSettings = {
            hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/abs/node_modules/.bin/wp-ai-guards-hook' }] }] },
        };
        expect(registrationStale(settings)).toBe(false);
        expect(managedEntries(settings)).toHaveLength(0);
    });
});

/** The DRIFT SIGNAL. Nothing validated `.claude/settings.json` before, at any layer. */
describe('managedSurfaceDrift reports each of the four managed things independently', () => {
    function stageHealthy(): string {
        const root = mktmp();
        fs.mkdirSync(path.dirname(shimPath(root)), { recursive: true });
        fs.writeFileSync(shimPath(root), renderShim());
        fs.writeFileSync(guaranteeRootPath(root), renderGuaranteeRoot());
        writeSettings(path.join(root, '.claude', 'settings.json'), {
            hooks: {
                PreToolUse: [
                    { matcher: 'Bash', hooks: [{ type: 'command', command: GUARANTEE_ROOT_COMMAND }] },
                    { matcher: 'Write|Edit|MultiEdit|Bash|Read', hooks: [{ type: 'command', command: shimCommand(GUARDS_BIN) }] },
                    { matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: shimCommand(RULES_BIN) }] },
                ],
            },
            env: { [BASH_CWD_ENV_KEY]: BASH_CWD_ENV_VALUE },
        });
        return root;
    }

    it('reports nothing for a tree on this release', () => {
        expect(managedSurfaceDrift(stageHealthy())).toEqual([]);
    });

    it('reports nothing for a null root — there is nothing to govern', () => {
        expect(managedSurfaceDrift(null)).toEqual([]);
    });

    it('reports the shim when the committed shim was reverted', () => {
        const root = stageHealthy();
        fs.writeFileSync(shimPath(root), '# reverted\n');
        expect(managedSurfaceDrift(root)).toEqual([SHIM_MARKER]);
    });

    it('reports the L-1 hook when its committed copy was hand-edited', () => {
        const root = stageHealthy();
        fs.writeFileSync(guaranteeRootPath(root), '#!/bin/sh\nexit 0\n');
        expect(managedSurfaceDrift(root)).toEqual([GUARANTEE_ROOT_MARKER]);
    });

    // REGISTERED but ABSENT is the worst case: the hook exits 127, which per the hooks reference is a
    // non-blocking error, so every `cd` proceeds unjudged with nothing surfaced.
    it('reports the L-1 hook when it is registered but the file is gone', () => {
        const root = stageHealthy();
        fs.rmSync(guaranteeRootPath(root));
        expect(managedSurfaceDrift(root)).toEqual([GUARANTEE_ROOT_MARKER]);
    });

    it('reports the REGISTRATION when settings is still on the old two-absolute-hook form', () => {
        const root = stageHealthy();
        stageOldTwoAbsoluteHooks(root);
        // No L-1 entry any more, so the file is simply not adopted — the registration is the fault, and
        // that old form predates the managed env entry too, so both surfaces are named.
        expect(managedSurfaceDrift(root)).toEqual([REGISTRATION_SURFACE, ENV_SURFACE]);
    });

    it('reports the registration when a stray duplicate entry survives', () => {
        const root = stageHealthy();
        const settingsPath = path.join(root, '.claude', 'settings.json');
        const settings = readSettings(settingsPath);
        settings.hooks!.PreToolUse!.push({ matcher: 'Bash', hooks: [{ type: 'command', command: `sh "$CLAUDE_PROJECT_DIR/${SHIM_MARKER}" ${GUARDS_BIN}` }] });
        writeSettings(settingsPath, settings);
        expect(managedSurfaceDrift(root)).toEqual([REGISTRATION_SURFACE]);
    });

    /**
     * THE FOURTH SURFACE. `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1` pins the Bash cwd to the project
     * root, which is what keeps the RELATIVE guard hooks resolvable (an unresolvable hook exits 127 =
     * a SILENT UNGUARDED ALLOW) and — because settings `env` is inherited — keeps every subagent on the
     * same cwd, hence the same verdict. A settings file missing it is drift like any other surface.
     */
    it('reports the env entry when a hooked settings file is missing it', () => {
        const root = stageHealthy();
        const settingsPath = path.join(root, '.claude', 'settings.json');
        const settings = readSettings(settingsPath);
        delete settings.env;
        writeSettings(settingsPath, settings);
        expect(managedSurfaceDrift(root)).toEqual([ENV_SURFACE]);
    });

    // A user-set value is not a second spelling of the decision — it is drift, and it is repaired.
    it('reports the env entry when it is set to anything other than 1', () => {
        const root = stageHealthy();
        const settingsPath = path.join(root, '.claude', 'settings.json');
        writeSettings(settingsPath, { ...readSettings(settingsPath), env: { [BASH_CWD_ENV_KEY]: '0' } });
        expect(managedSurfaceDrift(root)).toEqual([ENV_SURFACE]);

        const spy = vi.spyOn(console, 'log').mockImplementation((): void => undefined);
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            expect(runUpgradeShim(root)).toBe(0);
        } finally {
            spy.mockRestore();
        }
        expect(envIn(settingsPath)).toEqual({ [BASH_CWD_ENV_KEY]: BASH_CWD_ENV_VALUE });
        expect(managedSurfaceDrift(root)).toEqual([]);
    });

    // Other env keys are the consumer's, not ours: the repair MERGES, it does not replace the block.
    it('keeps unrelated env keys when it repairs the managed one', () => {
        const root = stageHealthy();
        const settingsPath = path.join(root, '.claude', 'settings.json');
        writeSettings(settingsPath, { ...readSettings(settingsPath), env: { BASH_DEFAULT_TIMEOUT_MS: '600000' } });

        const spy = vi.spyOn(console, 'log').mockImplementation((): void => undefined);
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            expect(runUpgradeShim(root)).toBe(0);
        } finally {
            spy.mockRestore();
        }
        expect(envIn(settingsPath)).toEqual({ BASH_DEFAULT_TIMEOUT_MS: '600000', [BASH_CWD_ENV_KEY]: BASH_CWD_ENV_VALUE });
    });

    /**
     * THE BUG THIS ORDERING EXISTS TO PREVENT. `repairRegistration()` used to early-return when the
     * hooks were already current — so the state EVERY existing consumer is in when this release lands
     * (three-hook form already installed, `env` entry not yet written) would have been reported as drift
     * by fault S and then left unrepaired by fault S's own prescribed cure. The two repairs are
     * evaluated independently, and this is the case that proves it.
     */
    it('repairs the env entry even when the hook registration is already current', () => {
        const root = stageHealthy();
        const settingsPath = path.join(root, '.claude', 'settings.json');
        const settings = readSettings(settingsPath);
        delete settings.env;
        writeSettings(settingsPath, settings);
        expect(registrationStale(readSettings(settingsPath))).toBe(false);   // hooks already current

        const spy = vi.spyOn(console, 'log').mockImplementation((): void => undefined);
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            expect(runUpgradeShim(root)).toBe(0);
        } finally {
            spy.mockRestore();
        }
        expect(envIn(settingsPath)).toEqual({ [BASH_CWD_ENV_KEY]: BASH_CWD_ENV_VALUE });
        expect(managedSurfaceDrift(root)).toEqual([]);
    });

    // The in-place predicate half of the same case, asserted without going through the bin.
    it('repairRegistration returns true for hooks-current-but-env-missing', () => {
        const settings: ClaudeSettings = {
            hooks: {
                PreToolUse: [
                    { matcher: 'Bash', hooks: [{ type: 'command', command: GUARANTEE_ROOT_COMMAND }] },
                    { matcher: 'Write|Edit|MultiEdit|Bash|Read', hooks: [{ type: 'command', command: shimCommand(GUARDS_BIN) }] },
                ],
            },
        };
        expect(registrationStale(settings)).toBe(false);
        expect(envStale(settings)).toBe(true);
        expect(repairRegistration(settings)).toBe(true);
        expect(settings.env).toEqual({ [BASH_CWD_ENV_KEY]: BASH_CWD_ENV_VALUE });
        expect(repairRegistration(settings)).toBe(false);   // idempotent
    });

    /**
     * A settings file that registers NO webpieces hooks is not a project install and is never judged —
     * the same gate `registrationStale()` uses. A global/absolute install names the bin path directly,
     * so there is no relative resolution for the env pin to protect, and webpieces must not write into
     * a file it does not own.
     */
    it('leaves a settings file with no webpieces hooks completely untouched', () => {
        const root = stageHealthy();
        const settingsPath = path.join(root, '.claude', 'settings.json');
        const foreign: ClaudeSettings = {
            hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/abs/node_modules/.bin/wp-ai-guards-hook' }] }] },
        };
        writeSettings(settingsPath, foreign);
        const before = fs.readFileSync(settingsPath, 'utf8');

        expect(envStale(foreign)).toBe(false);
        expect(repairRegistration(foreign)).toBe(false);
        expect(managedSurfaceDrift(root)).toEqual([]);

        const spy = vi.spyOn(console, 'log').mockImplementation((): void => undefined);
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            expect(runUpgradeShim(root)).toBe(0);
        } finally {
            spy.mockRestore();
        }
        expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);   // byte-identical: not one key added
    });

    it('reports all four at once, and wp-upgrade-shim clears all four', () => {
        const root = stageHealthy();
        fs.writeFileSync(shimPath(root), '# reverted\n');
        fs.writeFileSync(guaranteeRootPath(root), '# reverted\n');
        stageOldTwoAbsoluteHooks(root);   // also drops the env block — the pre-adoption state
        expect(managedSurfaceDrift(root)).toHaveLength(4);

        const spy = vi.spyOn(console, 'log').mockImplementation((): void => undefined);
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            expect(runUpgradeShim(root)).toBe(0);
        } finally {
            spy.mockRestore();
        }
        expect(managedSurfaceDrift(root)).toEqual([]);
    });
});

/** A primary clone plus the nested worktree that borrows its node_modules. Data-only → a class. */
class NestedTrees {
    constructor(
        readonly primary: string,
        readonly worktree: string,
    ) {}
}

/**
 * THE BIN WALK-UP, driven through a real /bin/sh.
 *
 * `BIN="$ROOT/node_modules/.bin/$BIN_NAME"` was a LITERAL path with no upward walk. That was harmless
 * only while the hooks were ABSOLUTE, because then ROOT was always the primary clone. The moment H2/H3
 * became relative, ROOT became the tree the call is in — and a nested worktree has no node_modules of
 * its own, so every subagent would have hard-blocked on fault X at its first tool call.
 */
describe('the shim resolves its BIN by walking UP, and refuses to straddle two versions', () => {
    /** A primary clone with an installed guard bin, and a nested worktree carrying no node_modules. */
    function stageNested(primaryPin: string, worktreePin: string | null): NestedTrees {
        const primary = mktmp();
        const binDir = path.join(primary, 'node_modules', '.bin');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(path.join(binDir, GUARDS_BIN), '#!/bin/sh\nprintf EXECED\n', { mode: 0o755 });
        const manifestDir = path.join(primary, 'node_modules', '@webpieces', 'ai-hook-rules');
        fs.mkdirSync(manifestDir, { recursive: true });
        fs.writeFileSync(path.join(manifestDir, 'package.json'), JSON.stringify({ version: primaryPin }));
        fs.writeFileSync(path.join(primary, 'package.json'),
            JSON.stringify({ devDependencies: { '@webpieces/ai-hook-rules': primaryPin } }));

        const worktree = path.join(primary, '.claude', 'worktrees', 'agent-1');
        fs.mkdirSync(worktree, { recursive: true });
        fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: /nowhere\n');
        if (worktreePin !== null) {
            fs.writeFileSync(path.join(worktree, 'package.json'),
                JSON.stringify({ devDependencies: { '@webpieces/ai-hook-rules': worktreePin } }));
        }
        return new NestedTrees(primary, worktree);
    }

    /** Run the rendered shim as the RELATIVE hook does: from the tree's own committed copy. */
    function runIn(tree: string, command: string): string {
        const shim = shimPath(tree);
        fs.mkdirSync(path.dirname(shim), { recursive: true });
        fs.writeFileSync(shim, renderShim(), { mode: 0o755 });
        const payload = JSON.stringify({ tool_name: 'Bash', cwd: tree, tool_input: { command } });
        const r = spawnSync('/bin/sh', [shim, GUARDS_BIN], { cwd: tree, input: payload, encoding: 'utf8' });
        return r.stdout ?? '';
    }

    it('finds a PARENT tree bin from a nested worktree that has none of its own', () => {
        const trees = stageNested('0.4.600', '0.4.600');
        // The fake bin prints EXECED, so "the guards actually ran" is observable rather than inferred.
        expect(runIn(trees.worktree, 'ls')).toContain('EXECED');
    });

    it('walks up even when the worktree declares no package.json at all', () => {
        const trees = stageNested('0.4.600', null);
        expect(runIn(trees.worktree, 'ls')).toContain('EXECED');
    });

    /**
     * Walking up ALONE would rebuild the non-convergent two-tree straddle: the worktree's shim paired
     * with the primary's binary at a different version. So the walk is paired with the version check —
     * DECLARED from the tree being judged, INSTALLED from the tree the bin came from.
     */
    it('faults D instead of straddling when the tree pin disagrees with the inherited bin', () => {
        const trees = stageNested('0.4.600', '0.4.700');
        const out = runIn(trees.worktree, 'ls');
        expect(out).toContain('"permissionDecision":"deny"');
        expect(out).toContain('version drift');
        expect(out).toContain('0.4.700');
        expect(out).toContain('0.4.600');
        // The cure has to run in THIS tree, or it installs into the primary and re-fires forever.
        expect(out).toContain(`cd ${trees.worktree} && pnpm install`);
        expect(out).toContain('NO node_modules of its own');
    });

    it('lets the cd-anchored install through, so the fault is not a deadlock', () => {
        const trees = stageNested('0.4.600', '0.4.700');
        expect(runIn(trees.worktree, `cd ${trees.worktree} && pnpm install`)).toBe('');
    });

    // A SIBLING worktree (not nested under the primary) legitimately finds nothing and must still say
    // so: walking up must not be allowed to reach sideways into an unrelated tree.
    it('still faults X for a sibling worktree with no node_modules anywhere above it', () => {
        const base = mktmp();
        const sibling = path.join(base, 'sibling');
        fs.mkdirSync(sibling, { recursive: true });
        fs.writeFileSync(path.join(sibling, 'package.json'),
            JSON.stringify({ devDependencies: { '@webpieces/ai-hook-rules': '0.4.600' } }));
        const out = runIn(sibling, 'ls');
        expect(out).toContain('"permissionDecision":"deny"');
        expect(out).toContain('is not installed');
    });
});
