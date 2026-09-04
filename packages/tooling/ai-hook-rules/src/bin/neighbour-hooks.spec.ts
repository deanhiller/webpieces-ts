import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    CLAUDE_REGISTRATION, CODEX_REGISTRATION, ClaudeSettings, GUARDS_BIN, RULES_BIN,
    managedSurfaceDrift, readSettings, repairRegistrationAt, writeSettings,
} from './hook-registration';
import { NeighbourHookAnchor, anchorNeighbourHooks, neighbourHooksStale } from './neighbour-hooks';
import { BASH_CWD_ENV_KEY, BASH_CWD_ENV_VALUE } from './managed-env';
import { renderShim, shimPath } from './shim';

/**
 * NEIGHBOUR HOOKS — the consumer's own hook entries in the settings file webpieces manages.
 *
 * Issue #852: five of them were registered with RELATIVE entry paths beside webpieces' one absolute
 * entry. A relative path resolves against the hook process's cwd, so off the repo root node could not
 * load the module and the guard died before running a line — and per the hooks reference that non-zero
 * exit is a NON-BLOCKING error, i.e. a SILENT UNGUARDED ALLOW. The three guards that stopped running
 * were a cleartext-credentials blocker, a `gcloud` blocker and a raw-deploy blocker.
 *
 * What this suite pins, in order of how badly it hurts to get wrong:
 *   1. a relative neighbour IS anchored, to the harness's OWN prefix;
 *   2. a token that is NOT a real file under the root is left alone — that existence test is the whole
 *      reason the cure always converges, because a token we decline to anchor never becomes drift;
 *   3. drift NAMES the surface, and `repairRegistrationAt` clears it (fault S can lift);
 *   4. a settings file with no webpieces hooks in it is never touched at all.
 */

function mktmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'wp-neighbour-'));
}

/** A repo whose settings.json is fully current EXCEPT for the neighbour hooks the caller adds. */
function stageRepo(root: string, neighbours: readonly string[]): string {
    fs.mkdirSync(path.join(root, '.claude', 'webpieces'), { recursive: true });
    fs.writeFileSync(shimPath(root), renderShim(), { mode: 0o755 });
    fs.mkdirSync(path.join(root, '.claude', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'hooks', 'guard-deploy.mjs'), '// guard\n');
    const settingsPath = path.join(root, '.claude', 'settings.json');
    const settings: ClaudeSettings = {
        hooks: {
            PreToolUse: [
                { matcher: CLAUDE_REGISTRATION.guardsMatcher, hooks: [{ type: 'command', command: CLAUDE_REGISTRATION.shimCommand(GUARDS_BIN) }] },
                { matcher: CLAUDE_REGISTRATION.rulesMatcher, hooks: [{ type: 'command', command: CLAUDE_REGISTRATION.shimCommand(RULES_BIN) }] },
                ...neighbours.map((command: string): { matcher: string; hooks: { type: string; command: string }[] } =>
                    ({ matcher: 'Bash', hooks: [{ type: 'command', command }] })),
            ],
        },
        env: { [BASH_CWD_ENV_KEY]: BASH_CWD_ENV_VALUE },
    };
    writeSettings(settingsPath, settings);
    return settingsPath;
}

function commandsIn(settingsPath: string): string[] {
    return (readSettings(settingsPath).hooks?.PreToolUse ?? [])
        .flatMap((e: { hooks: { command: string }[] }): string[] => e.hooks.map((h: { command: string }): string => h.command));
}

describe('NeighbourHookAnchor — which tokens get anchored', () => {
    const root = mktmp();
    fs.mkdirSync(path.join(root, '.claude', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'hooks', 'guard-deploy.mjs'), '// guard\n');
    const anchorer = new NeighbourHookAnchor('$CLAUDE_PROJECT_DIR', root);

    it('anchors the exact shape from issue #852, keeping the double quotes', () => {
        expect(anchorer.rewrite('node ".claude/hooks/guard-deploy.mjs"'))
            .toBe('node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-deploy.mjs"');
    });

    it('strips a leading ./ so the anchored path has exactly one spelling', () => {
        expect(anchorer.rewrite('node ./.claude/hooks/guard-deploy.mjs'))
            .toBe('node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-deploy.mjs"');
    });

    it('QUOTES a bare token on the way out — the anchor expands to a path that may contain spaces', () => {
        expect(anchorer.rewrite('node .claude/hooks/guard-deploy.mjs'))
            .toBe('node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-deploy.mjs"');
    });

    it("keeps single quotes single, so a command's own quoting style survives the repair", () => {
        expect(anchorer.rewrite("node '.claude/hooks/guard-deploy.mjs'"))
            .toBe("node '$CLAUDE_PROJECT_DIR/.claude/hooks/guard-deploy.mjs'");
    });

    /**
     * THE EXISTENCE TEST IS THE CONVERGENCE GUARANTEE. A slash-carrying token that is not a real file
     * under the root is left exactly as it is — so it is never reported as drift, and fault S can never
     * name a surface its own cure declines to repair.
     */
    it.each([
        ['a non-path with a slash', 'npm run build/foo'],
        ['a file that does not exist under the root', 'node ".claude/hooks/does-not-exist.mjs"'],
        ['an already-absolute path', 'node "/etc/hooks/guard.mjs"'],
        ['a variable-anchored path', 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-deploy.mjs"'],
        ['a home-anchored path', 'node "~/.claude/hooks/guard-deploy.mjs"'],
        ['a path escaping the root', 'node "../.claude/hooks/guard-deploy.mjs"'],
        ['a token with no slash at all', 'true'],
    ])('leaves %s alone', (_label: string, command: string) => {
        expect(anchorer.rewrite(command)).toBe(command);
    });

    it('never touches the webpieces-managed directory — repairRegistration owns that spelling', () => {
        fs.mkdirSync(path.join(root, '.claude', 'webpieces'), { recursive: true });
        fs.writeFileSync(shimPath(root), renderShim(), { mode: 0o755 });
        const relativeManaged = `sh ".claude/webpieces/ai-hook.sh" ${GUARDS_BIN}`;
        expect(anchorer.rewrite(relativeManaged)).toBe(relativeManaged);
    });

    it('anchors to the CODEX prefix when the harness is Codex', () => {
        expect(new NeighbourHookAnchor(CODEX_REGISTRATION.shimAnchor, root).rewrite('node ".claude/hooks/guard-deploy.mjs"'))
            .toBe('node "$PWD/.claude/hooks/guard-deploy.mjs"');
    });
});

describe('drift and repair, end to end', () => {
    it('reports the neighbour surface, then repairs it so the block can lift', () => {
        const root = mktmp();
        const settingsPath = stageRepo(root, ['node ".claude/hooks/guard-deploy.mjs"']);

        expect(managedSurfaceDrift(root)).toEqual([CLAUDE_REGISTRATION.neighbourSurface]);

        const repairs = repairRegistrationAt(root);
        expect(repairs).toHaveLength(1);
        expect(repairs[0].anchoredNeighbours).toEqual(['node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-deploy.mjs"']);
        expect(repairs[0].registration).toBe(false);
        expect(repairs[0].env).toBe(false);
        expect(commandsIn(settingsPath)).toContain('node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-deploy.mjs"');
        // The cure CONVERGES — this is the property verifyRepaired() asserts on every wp-upgrade-shim.
        expect(managedSurfaceDrift(root)).toEqual([]);
    });

    it('is silent, and rewrites nothing, when every neighbour is already anchored', () => {
        const root = mktmp();
        stageRepo(root, ['node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-deploy.mjs"']);
        expect(managedSurfaceDrift(root)).toEqual([]);
        expect(repairRegistrationAt(root)).toEqual([]);
    });

    /**
     * A settings file that registers NO webpieces hooks is not a webpieces install. Rewriting somebody's
     * unrelated hook lines there would be webpieces editing a file it was never given — the same gate
     * `registrationStale()` has always had.
     */
    it('never judges or edits a settings file that registers no webpieces hooks', () => {
        const root = mktmp();
        fs.mkdirSync(path.join(root, '.claude', 'webpieces'), { recursive: true });
        fs.writeFileSync(shimPath(root), renderShim(), { mode: 0o755 });
        fs.mkdirSync(path.join(root, '.claude', 'hooks'), { recursive: true });
        fs.writeFileSync(path.join(root, '.claude', 'hooks', 'guard-deploy.mjs'), '// guard\n');
        const settingsPath = path.join(root, '.claude', 'settings.json');
        writeSettings(settingsPath, {
            hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node ".claude/hooks/guard-deploy.mjs"' }] }] },
        });
        expect(managedSurfaceDrift(root)).toEqual([]);
        expect(repairRegistrationAt(root)).toEqual([]);
        expect(commandsIn(settingsPath)).toEqual(['node ".claude/hooks/guard-deploy.mjs"']);
    });

    /**
     * NOT scoped to PreToolUse. A PostToolUse hook dies from the same cwd for the same reason, and a
     * repair that fixed half a file would report success over a still-broken one.
     */
    it('anchors hooks under every event, not just PreToolUse', () => {
        const root = mktmp();
        const settingsPath = stageRepo(root, []);
        const settings = readSettings(settingsPath);
        settings.hooks!['PostToolUse'] = [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node ".claude/hooks/guard-deploy.mjs"' }] }];
        writeSettings(settingsPath, settings);

        expect(neighbourHooksStale(CLAUDE_REGISTRATION.shimAnchor, readSettings(settingsPath), root)).toBe(true);
        const reloaded = readSettings(settingsPath);
        expect(anchorNeighbourHooks(CLAUDE_REGISTRATION.shimAnchor, reloaded, root))
            .toEqual(['node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-deploy.mjs"']);
    });
});
