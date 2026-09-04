import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { applyHook, applyChoice, installTargets, hasHook, RULES_HOOK, GUARDS_HOOK, InstallTarget } from './setup';
import { SHIM_MARKER } from './shim';
import {
    readSettings, writeSettings, SettingsRepair, GUARDS_BIN, RULES_BIN,
    CLAUDE_REGISTRATION, CODEX_REGISTRATION, CODEX_REGISTRATION_SURFACE, HarnessRegistration,
    HARNESS_REGISTRATIONS, managedSurfaceDrift, registrationStaleAt, repairRegistrationAt,
} from './hook-registration';
import type { HookEntry } from './settings-shape';
import { ShimTestkit } from './shim-testkit';

/**
 * THE PER-HARNESS REGISTRATION — matchers, the shim anchor, and `.codex/hooks.json` as a managed
 * surface. Split out of setup.spec.ts (which is at the file-size limit) along the seam the code has:
 * that file tests the INSTALLER's mechanics, this one tests WHAT it installs for each harness.
 *
 * The failure every test here exists for is SILENT. A matcher naming a tool the harness never emits
 * matches nothing and reports nothing; a shim path anchored on a variable the harness does not set
 * expands to a file that is not there, and a hook that cannot launch exits 127 — which the hooks
 * reference defines as a NON-BLOCKING error, i.e. an unguarded allow. Both were the live state of every
 * `.codex/hooks.json` a desktop sync had written.
 */
const kit = new ShimTestkit();
const mktmp = (): string => kit.mktmp();

// A temp HOME so the "global" install target never touches the real ~/.claude/settings.json.
function targetsIn(root: string): ReturnType<typeof installTargets> {
    return installTargets(root, mktmp());
}

/**
 * MATCHER-SUPERSET INVARIANT — the guards matcher must cover every tool the rules matcher covers.
 *
 * The rules hook deliberately SKIPS the committed-shim self-guard ("guards owns the shim", see
 * enforceCommittedShim's `mode === 'rules'` early return). That is only safe while every tool the
 * rules hook sees is ALSO seen by the guards hook. Narrow the guards matcher — drop Write, say — and
 * fault S silently stops being enforced for exactly the tools that fell out: no error, no test, just
 * a guard that quietly no longer runs on the writes it was written for.
 *
 * Nothing asserted this until now, and a matcher is a string literal one careless edit away.
 */
describe('hook matchers — guards ⊇ rules, in EVERY harness', () => {
    const toolsOf = (matcher: string): Set<string> => new Set(matcher.split('|'));

    // Per harness, because the matchers are now per harness — and a superset relation that held for
    // Claude Code proves nothing about Codex, whose file tool has a different name entirely.
    it.each(HARNESS_REGISTRATIONS.map((h: HarnessRegistration): [string, HarnessRegistration] => [h.label, h]))(
        '%s: the guards matcher is a superset of the rules matcher', (label: string, harness: HarnessRegistration) => {
            const guards = toolsOf(harness.guardsMatcher);
            const missing = [...toolsOf(harness.rulesMatcher)].filter((t: string): boolean => !guards.has(t));
            expect(missing, `${label} guards hook does not match: ${missing.join('|')} — fault S stops being enforced there`).toEqual([]);
        });

    it('Claude Code: the guards matcher additionally covers Bash and Read', () => {
        const guards = toolsOf(CLAUDE_REGISTRATION.guardsMatcher);
        expect(guards.has('Bash')).toBe(true);   // the git/PR guards
        expect(guards.has('Read')).toBe(true);   // the log-and-allow audit + read-stale-guard
    });

    /**
     * CODEX'S MEASURED TOOL NAMES, pinned — this is the assertion that would have caught the broken
     * `.codex/hooks.json` a desktop sync wrote. Its file tool is `apply_patch` and nothing else; there
     * is no `Read` tool at all (a read arrives as `Bash` running a pager, which read-parity synthesizes
     * from the shell matcher). A matcher naming Claude's tool names here matches NOTHING, silently.
     */
    it('Codex: guards match Bash|apply_patch, rules match apply_patch, and no Claude tool name appears', () => {
        expect(CODEX_REGISTRATION.guardsMatcher).toBe('Bash|apply_patch');
        expect(CODEX_REGISTRATION.rulesMatcher).toBe('apply_patch');
        for (const claudeOnly of ['Write', 'Edit', 'MultiEdit', 'Read']) {
            expect(toolsOf(CODEX_REGISTRATION.guardsMatcher).has(claudeOnly), claudeOnly).toBe(false);
        }
    });

    /**
     * THE BYTE-STABILITY LOCK on the Codex shim command.
     *
     * Codex trusts a hook entry TOFU: `~/.codex/config.toml` records a `trusted_hash` per entry, so ANY
     * change to these bytes re-prompts every human who has already trusted it — and the prompt's third
     * option is "Continue without trusting (hooks won't run)", one keystroke to a silently unguarded
     * session. The hash cannot be recomputed by us (see codex-trust.ts), so there is no repair path.
     * That makes this string's bytes a public contract, and this the test that says so out loud.
     */
    it('pins the Codex shim command byte for byte — changing it re-prompts every trusting human', () => {
        expect(CODEX_REGISTRATION.shimCommand(GUARDS_BIN))
            .toBe('sh "$PWD/.claude/webpieces/ai-hook.sh" wp-ai-guards-hook');
        expect(CODEX_REGISTRATION.shimCommand(RULES_BIN))
            .toBe('sh "$PWD/.claude/webpieces/ai-hook.sh" wp-ai-rules-hook');
        // $CLAUDE_PROJECT_DIR does not exist in a Codex hook's environment (measured: 46 vars, no such
        // key), so anchoring on it expands to `sh "/.claude/…"`, which dies — and a non-2 non-zero exit
        // is a NON-BLOCKING error, i.e. a silent unguarded allow. That was the live bug.
        expect(CODEX_REGISTRATION.shimCommand(GUARDS_BIN)).not.toContain('CLAUDE_PROJECT_DIR');
    });

    /** ONE shim file, both harnesses — moving or duplicating it doubles every allowlist and every cure. */
    it('points both harnesses at the SAME committed shim', () => {
        for (const harness of HARNESS_REGISTRATIONS) {
            expect(harness.shimCommand(GUARDS_BIN), harness.label).toContain(SHIM_MARKER);
        }
    });
});

/**
 * THE CODEX TARGET the installer writes, and the one intention it shares with the Claude target.
 *
 * Choice `1` is "the project, committed, for the team" — and a repo worked on by both harnesses needs
 * BOTH files armed to mean that. Splitting it into two questions is how a repo ends up with Codex
 * silently unguarded, which is the whole failure this change exists to end.
 */
describe('installTargets — the Codex registration', () => {
    it('arms .codex/hooks.json under the same project choice as .claude/settings.json', () => {
        const targets = installTargets('/repo', '/home');
        const project = targets.filter((t: InstallTarget): boolean => t.choice === '1');
        expect(project.map((t: InstallTarget): string => t.settingsPath))
            .toEqual([path.join('/repo', '.claude', 'settings.json'), path.join('/repo', '.codex', 'hooks.json')]);
        expect(project.map((t: InstallTarget): string => t.harness.aiType)).toEqual(['claude-code', 'codex']);
    });

    it('keeps the three Claude rows in their historical positions', () => {
        const targets = installTargets('/repo', '/home');
        expect(targets.slice(0, 3).map((t: InstallTarget): string => t.choice)).toEqual(['1', '2', '3']);
        expect(targets.slice(0, 3).every((t: InstallTarget): boolean => t.harness === CLAUDE_REGISTRATION)).toBe(true);
    });

    it('writes the Codex matcher and the $PWD anchor into .codex/hooks.json, and no env block', () => {
        const root = mktmp();
        const targets = targetsIn(root);
        const codex = targets.filter((t: InstallTarget): boolean => t.harness === CODEX_REGISTRATION)[0];
        applyHook(GUARDS_HOOK, codex, targets, root);
        applyHook(RULES_HOOK, codex, targets, root);

        const written = readSettings(path.join(root, '.codex', 'hooks.json'));
        const entries = written.hooks?.PreToolUse ?? [];
        expect(entries.map((e: HookEntry): string => e.matcher).sort()).toEqual(['Bash|apply_patch', 'apply_patch']);
        for (const entry of entries) {
            expect(entry.hooks[0].command).toContain('$PWD/');
            expect(entry.hooks[0].command).not.toContain('CLAUDE_PROJECT_DIR');
        }
        // Codex has no settings `env` surface; writing one would be a managed key nothing reads.
        expect(written.env).toBeUndefined();
    });

    it('does NOT strip the Codex registration when the Claude hook is installed, and vice versa', () => {
        const root = mktmp();
        const targets = targetsIn(root);
        applyChoice(GUARDS_HOOK, '1', targets, root);
        applyChoice(RULES_HOOK, '1', targets, root);

        expect(hasHook(readSettings(path.join(root, '.claude', 'settings.json')), GUARDS_BIN)).toBe(true);
        expect(hasHook(readSettings(path.join(root, '.codex', 'hooks.json')), GUARDS_BIN)).toBe(true);
        expect(hasHook(readSettings(path.join(root, '.codex', 'hooks.json')), RULES_BIN)).toBe(true);
    });

    /** Uninstall is the one answer that must be true EVERYWHERE, or the hook is still armed somewhere. */
    it('uninstall clears both harnesses', () => {
        const root = mktmp();
        const targets = targetsIn(root);
        applyChoice(GUARDS_HOOK, '1', targets, root);
        applyChoice(GUARDS_HOOK, 'none-of-them', targets, root);

        expect(hasHook(readSettings(path.join(root, '.claude', 'settings.json')), GUARDS_BIN)).toBe(false);
        expect(hasHook(readSettings(path.join(root, '.codex', 'hooks.json')), GUARDS_BIN)).toBe(false);
    });
});

/**
 * `.codex/hooks.json` IS A MANAGED SURFACE now, which is the point of the whole exercise: before this,
 * something else wrote that file with a matcher matching nothing and an anchor that did not resolve, and
 * NO check in this package could see it. A file the guards depend on and nothing validates is that
 * incident's exact shape.
 */
describe('managedSurfaceDrift — the fourth surface', () => {
    it('reports .codex/hooks.json when its registration is on a superseded spelling', () => {
        const root = mktmp();
        const targets = targetsIn(root);
        applyChoice(GUARDS_HOOK, '1', targets, root);

        const hooksPath = path.join(root, '.codex', 'hooks.json');
        const settings = readSettings(hooksPath);
        // The exact shape a Codex Desktop sync produced: Claude's matcher, Claude's anchor.
        settings.hooks!.PreToolUse = [{
            matcher: 'Write|Edit|MultiEdit|Bash|Read',
            hooks: [{ type: 'command', command: `sh "$CLAUDE_PROJECT_DIR/${SHIM_MARKER}" ${GUARDS_BIN}` }],
        }];
        writeSettings(hooksPath, settings);

        expect(registrationStaleAt(CODEX_REGISTRATION, root)).toBe(true);
        expect(managedSurfaceDrift(root)).toContain(CODEX_REGISTRATION_SURFACE);
    });

    it('says nothing about a repo that never armed Codex', () => {
        const root = mktmp();
        expect(registrationStaleAt(CODEX_REGISTRATION, root)).toBe(false);
        expect(managedSurfaceDrift(root)).not.toContain(CODEX_REGISTRATION_SURFACE);
    });

    it('repairRegistrationAt() brings a drifted .codex/hooks.json back to this release', () => {
        const root = mktmp();
        const targets = targetsIn(root);
        applyChoice(GUARDS_HOOK, '1', targets, root);
        const hooksPath = path.join(root, '.codex', 'hooks.json');
        const settings = readSettings(hooksPath);
        settings.hooks!.PreToolUse = [{
            matcher: 'Write|Edit|MultiEdit|Bash|Read',
            hooks: [{ type: 'command', command: `sh "$CLAUDE_PROJECT_DIR/${SHIM_MARKER}" ${GUARDS_BIN}` }],
        }];
        writeSettings(hooksPath, settings);

        const repaired = repairRegistrationAt(root);
        expect(repaired.map((r: SettingsRepair): string => r.settingsPath)).toContain(hooksPath);
        expect(registrationStaleAt(CODEX_REGISTRATION, root)).toBe(false);
        const entries = readSettings(hooksPath).hooks?.PreToolUse ?? [];
        expect(entries[0].matcher).toBe('Bash|apply_patch');
        expect(entries[0].hooks[0].command).toBe(CODEX_REGISTRATION.shimCommand(GUARDS_BIN));
    });
});
