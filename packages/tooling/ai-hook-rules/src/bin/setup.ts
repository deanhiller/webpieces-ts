import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';

import { RepoRootFinder, writeTemplate, writeTemplateIfMissing, CONFIG_POLICY_DOC } from '@webpieces/rules-config';

import { SHIM_MARKER, shimPath, renderShim } from './shim';
import {
    ClaudeSettings, HookCommand, HookEntry, HookRegistrationEntry, GUARDS_BIN, LEGACY_GUARANTEE_ROOT_MARKER,
    RULES_BIN, addHookEntry, applyManagedEnv, readSettings, writeSettings,
    HarnessRegistration, CLAUDE_REGISTRATION, CODEX_REGISTRATION,
} from './hook-registration';
import { BASH_CWD_ENV_KEY, BASH_CWD_ENV_VALUE } from './managed-env';
import { CodexTrustProbe } from './codex-trust';
// The config half of the installer — seeding and migrating webpieces.config.json. Split for size along
// the seam that was already there: this module is hook WIRING, that one is CONFIG SHAPE.
import { seedOrSyncConfig } from './setup-config';


// ---------------------------------------------------------------------------
// The two independently-installable GUARD hooks. Each can land in a different settings file (see
// InstallTarget) so a team can ship the guards while a developer keeps the code-style rules local
// while iterating. Both are registered ABSOLUTE via $CLAUDE_PROJECT_DIR, so the MAIN tree governs every
// tree. There used to be a third — the L-1 hook, which existed only to keep a RELATIVE registration
// resolvable; it is retired, and purgeRetiredGuaranteeRoot() removes anything left of it.
// ---------------------------------------------------------------------------
class HookSpec {
    constructor(
        readonly key: string,
        readonly label: string,
        readonly bin: string,
    ) {}

    /**
     * WHICH TOOL NAMES this hook must see, in the harness the target belongs to.
     *
     * It is a lookup on the target rather than a field on the spec because the answer is not a property
     * of the hook: the rules hook matches `Write|Edit|MultiEdit` under Claude Code and `apply_patch`
     * under Codex, and a single stored matcher is exactly how `.codex/hooks.json` came to be registered
     * against tool names Codex never emits.
     */
    matcherFor(target: InstallTarget): string {
        return target.harness.matcherFor(this.bin);
    }

    // Absolute targets (global) need the exact path to this repo's bin — no ~/.webpieces bridge.
    // Project targets get the ABSOLUTE shim command, anchored on the harness's own project-root variable
    // (see HarnessRegistration.shimCommand): it resolves from ANY cwd, so a hook can never fail to
    // launch — which per the hooks reference would be exit 127, a SILENT UNGUARDED ALLOW, not a block.
    commandFor(target: InstallTarget, projectRoot: string): string {
        if (target.absolute) {
            return `node ${path.join(projectRoot, 'node_modules', '.bin', this.bin)}`;
        }
        return target.harness.shimCommand(this.bin);
    }
}

// Idempotent: re-running the installer overwrites the managed shim in place.
function writeShim(projectRoot: string): void {
    const target = shimPath(projectRoot);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, renderShim(), { mode: 0o755 });
    // writeFileSync's mode is only applied when creating the file; force it on overwrite too.
    fs.chmodSync(target, 0o755);
}

function removeShim(projectRoot: string): void {
    const target = shimPath(projectRoot);
    if (fs.existsSync(target)) fs.rmSync(target);
}

// A managed .sh is shared by the project hooks — only safe to delete once no project settings file
// references it anymore (i.e. the other hook was moved to global or uninstalled too).
// webpieces-disable no-function-outside-class -- setup.ts is deliberately DI-free (it must run on a half-written node_modules; see install-entry.ts), so every function here is module-scope
function markerReferenced(targets: InstallTarget[], marker: string): boolean {
    return targets.some((t: InstallTarget) => {
        const entries = readSettings(t.settingsPath).hooks?.PreToolUse ?? [];
        return entries.some((e: HookEntry) => e.hooks.some((h: HookCommand) => h.command.includes(marker)));
    });
}

/**
 * Remove every trace of the RETIRED L-1 hook (`guarantee-root.sh`) — the file and any PreToolUse entry
 * still pointing at it. REMOVAL ONLY: nothing here can ever write one back.
 *
 * L-1 existed to guarantee a RELATIVE guard-hook path resolved, by refusing any `cd` that would park the
 * shell in a subdirectory. The guard hooks are ABSOLUTE now (`$CLAUDE_PROJECT_DIR/...`), so they resolve
 * from any cwd and the guarantee is structural — there is nothing left to police, and the subdirectory
 * denial that used to pay for it is gone with it.
 */
// webpieces-disable no-function-outside-class -- setup.ts is deliberately DI-free (it must run on a half-written node_modules; see install-entry.ts), so every function here is module-scope
function purgeRetiredGuaranteeRoot(targets: InstallTarget[], projectRoot: string): void {
    for (const target of targets) {
        const settings = readSettings(target.settingsPath);
        if (removeHookByMarker(settings, LEGACY_GUARANTEE_ROOT_MARKER)) {
            writeSettings(target.settingsPath, settings);
            console.log(`  🗑️  removed the retired L-1 guarantee-root hook from ${target.label}`);
        }
    }
    const legacyFile = path.join(projectRoot, LEGACY_GUARANTEE_ROOT_MARKER);
    if (fs.existsSync(legacyFile)) {
        fs.rmSync(legacyFile, { force: true });
        console.log('  🗑️  deleted the retired .claude/webpieces/guarantee-root.sh');
    }
}

export class InstallTarget {
    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        readonly choice: string,
        readonly label: string,
        readonly settingsPath: string,
        readonly absolute: boolean,
        /**
         * WHICH HARNESS this file arms — it decides the matcher and the shim anchor written into it.
         *
         * REQUIRED, with no default, and the absence of one is the point. A default of
         * CLAUDE_REGISTRATION would make "omit the harness" mean "Claude Code" — a widening that is an
         * ABSENCE rather than a token, so a target built for Codex without it would silently carry
         * `Write|Edit|MultiEdit` and `$CLAUDE_PROJECT_DIR`, which is EXACTLY the silently-unguarded
         * state this class exists to end, and ungreppable besides.
         */
        readonly harness: HarnessRegistration,
    ) {}
}

// The bin names come from ./hook-registration, which is also what the drift check and wp-upgrade-shim
// compare against — one spelling of the registration, or the installer and the validator can disagree
// about what "installed" means. The MATCHER is not here: it belongs to the harness, not the hook (see
// HookSpec.matcherFor).
export const RULES_HOOK = new HookSpec('rules', 'Rules hook (code-style validation)', RULES_BIN);
export const GUARDS_HOOK = new HookSpec('guards', 'Guards hook (git/PR/branch protection)', GUARDS_BIN);

/**
 * Every file the installer can write, keyed by the CHOICE a human makes.
 *
 * TWO TARGETS SHARE CHOICE `1`, and that is the design rather than an oversight: "the project, committed,
 * for the team" is ONE intention, and a repo that is worked on by both harnesses needs both files armed
 * to mean it. Splitting it into two questions would let a human answer them differently and end up with a
 * repo where Codex is silently unguarded — which is the state this whole change exists to end. Every
 * caller selects by choice id (`targets.filter(t => t.choice === answer)`), never by index, so adding a
 * harness adds a row and changes no numbering.
 *
 * `2` (personal) and `3` (global) stay Claude-only because neither has a Codex counterpart: Codex reads
 * one repo-local `hooks.json` and has no personal or home-scoped hook file.
 *
 * `homeDir` is injectable so tests can point the global target at a temp dir instead of the real
 * ~/.claude/settings.json (a unit test must never write the user's actual global settings).
 */
export function installTargets(projectRoot: string, homeDir: string = homedir()): InstallTarget[] {
    return [
        new InstallTarget('1', 'project (.claude/settings.json — committed, for the team)',
            path.join(projectRoot, '.claude', 'settings.json'), false, CLAUDE_REGISTRATION),
        new InstallTarget('2', 'project for you (.claude/settings.local.json — personal)',
            path.join(projectRoot, '.claude', 'settings.local.json'), false, CLAUDE_REGISTRATION),
        new InstallTarget('3', 'global (~/.claude/settings.json — exact path, this repo only)',
            path.join(homeDir, '.claude', 'settings.json'), true, CLAUDE_REGISTRATION),
        // Given choice `1` so one answer arms the whole project — see the docblock. Its position in the
        // array carries no meaning: every caller selects by choice id.
        new InstallTarget('1', 'project, for Codex too (.codex/hooks.json — committed, for the team)',
            path.join(projectRoot, ...CODEX_REGISTRATION.settingsFiles[0].split('/')), false, CODEX_REGISTRATION),
    ];
}

// ---------------------------------------------------------------------------
// Claude Code settings.json hook wiring.
// ---------------------------------------------------------------------------
export function hasHook(settings: ClaudeSettings, bin: string): boolean {
    const entries = settings.hooks?.PreToolUse ?? [];
    return entries.some((e: HookEntry) => e.hooks.some((h: HookCommand) => h.command.includes(bin)));
}

// Drop every PreToolUse command containing `marker` (a bin name, or a managed .sh path); returns true
// if anything was removed. REMOVE-then-ADD is what keeps an upgrade from leaving a superseded spelling
// (a relative command, or the retired L-1 entry) beside the current one — two spellings of one
// registration is the compatibility shim the backwards-compat reviewer rejects.
// webpieces-disable no-function-outside-class -- setup.ts is deliberately DI-free (it must run on a half-written node_modules; see install-entry.ts), so every function here is module-scope
function removeHookByMarker(settings: ClaudeSettings, marker: string): boolean {
    const entries = settings.hooks?.PreToolUse;
    if (!entries) return false;
    let changed = false;
    const kept: HookEntry[] = [];
    for (const entry of entries) {
        const hooks = entry.hooks.filter((h: HookCommand) => !h.command.includes(marker));
        if (hooks.length !== entry.hooks.length) changed = true;
        if (hooks.length > 0) kept.push({ matcher: entry.matcher, hooks });
    }
    if (changed) settings.hooks!.PreToolUse = kept;
    return changed;
}

// Apply the chosen install for one hook: remove it from every target file, then add it back to the
// chosen one (or nowhere, for uninstall). Writes only the files that changed.
export function applyHook(hook: HookSpec, chosen: InstallTarget | null, targets: InstallTarget[], projectRoot: string): void {
    // SCOPED TO THE CHOSEN HARNESS, and this is what makes one call per target composable. Installing
    // the Claude hook must not strip the Codex one, so "remove it from everywhere else" means everywhere
    // else THIS HARNESS could live. Uninstall (chosen === null) is the one case that means every
    // harness, because "not installed" has to be true everywhere or the hook is still armed somewhere.
    const scope = chosen === null ? targets : targets.filter((t: InstallTarget) => t.harness === chosen.harness);
    for (const target of scope) {
        const settings = readSettings(target.settingsPath);
        const removed = removeHookByMarker(settings, hook.bin);
        const isChosen = chosen !== null && chosen.settingsPath === target.settingsPath;
        if (isChosen) {
            addHookEntry(settings, new HookRegistrationEntry(hook.matcherFor(target), hook.commandFor(target, projectRoot)));
            // The managed `env` entry goes into the SAME file the hooks go into, on every path that
            // writes hooks — interactive or `--target=`. It pins the Bash cwd to the project root, so a
            // guard's answer depends on the command rather than on where an earlier `cd` left the shell,
            // and settings `env` is inherited, so every subagent gets the identical cwd and therefore the
            // identical guard verdict. (It no longer has a RESOLUTION job — the hooks are absolute.) See
            // hook-registration.ts for the full argument; `wp-upgrade-shim` self-heals it afterwards.
            // …in the harness that HAS that surface. Codex has no settings `env`, and needs none: its
            // cwd is MEASURED not to drift, which is the whole thing this entry buys under Claude Code.
            if (target.harness.managesEnv && applyManagedEnv(settings)) {
                console.log(`  ✅ env.${BASH_CWD_ENV_KEY}=${BASH_CWD_ENV_VALUE} → ${target.label} (pins the Bash cwd to the project root, for this session and every subagent)`);
            }
            writeSettings(target.settingsPath, settings);
            console.log(`  ✅ ${hook.label} → ${target.label}`);
        } else if (removed) {
            writeSettings(target.settingsPath, settings);
        }
    }
    // Manage the shared checked-in shim: (re)write it whenever a project (relative) install exists,
    // otherwise clean it up once neither hook references it anymore.
    if (chosen !== null && !chosen.absolute) {
        writeShim(projectRoot);
    } else if (!markerReferenced(targets, SHIM_MARKER)) {
        removeShim(projectRoot);
    }
    // The RETIRED L-1 hook rode with the GUARDS hook, so its removal does too. Doing it here rather than
    // at a separate call site means every existing caller of applyHook — the installer's interactive and
    // --target paths, and every test — converges on the two-hook absolute form with no second step.
    if (hook.bin === GUARDS_BIN) purgeRetiredGuaranteeRoot(targets, projectRoot);
    if (chosen === null) console.log(`  ⛔ ${hook.label} not installed (removed from all locations).`);
}

/**
 * Say whether Codex will actually RUN what we just registered — the one thing the installer cannot do
 * anything about and therefore must not leave silent.
 *
 * Codex trusts a hook entry TOFU and re-prompts whenever its bytes change, and the prompt's third option
 * is "Continue without trusting (hooks won't run)". So a perfectly successful install can be followed by
 * a fully unguarded session, and the only honest thing to print is what is true plus the one action a
 * HUMAN has to take. Nothing here writes `~/.codex/config.toml` — see codex-trust.ts for why forging a
 * `trusted_hash` is not on the table.
 *
 * Silent when this repo did not arm Codex, so a Claude-only install gains no noise.
 */
// webpieces-disable no-function-outside-class -- setup.ts is deliberately DI-free (it must run on a half-written node_modules; see install-entry.ts), so every function here is module-scope
function reportCodexTrust(projectRoot: string, targets: InstallTarget[], choice: string): void {
    const armed = targets.some((t: InstallTarget): boolean => t.choice === choice && t.harness === CODEX_REGISTRATION);
    if (!armed) return;
    const lines = new CodexTrustProbe().read(projectRoot).lines();
    if (lines.length === 0) return;
    console.log('');
    for (const line of lines) console.log(line);
}

function currentLocation(hook: HookSpec, targets: InstallTarget[]): string {
    const here = targets.filter((t: InstallTarget) => hasHook(readSettings(t.settingsPath), hook.bin));
    return here.length === 0 ? 'none' : here.map((t: InstallTarget) => t.label.split(' (')[0]).join(', ');
}

function prompt(question: string): Promise<string> {
    return new Promise((resolve: (answer: string) => void) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, (answer: string) => { rl.close(); resolve(answer.trim()); });
    });
}

// Map a friendly `--target` name to an InstallTarget choice id (see installTargets). Returns null
// for an unknown name so the caller can error out. Kept separate + exported for unit testing.
export function resolveTargetChoice(name: string): string | null {
    switch (name) {
        case 'project': return '1';
        case 'project-personal':
        case 'projectpersonal':
        case 'local': return '2';
        case 'global': return '3';
        case 'none':
        case 'uninstall': return '4';
        default: return null;
    }
}

// Extract the value of `--target=<name>` from argv (null if the flag is absent).
export function parseTargetArg(args: string[]): string | null {
    const flag = args.find((a: string): boolean => a.startsWith('--target='));
    return flag ? flag.slice('--target='.length) : null;
}

/**
 * Apply ONE choice for one hook: every target that answer selects, or uninstall when it selects none.
 *
 * The loop is what lets one choice arm several harnesses (choice `1` writes both the Claude settings
 * file and the Codex hooks file — see installTargets). `applyHook` scopes its removals to the chosen
 * target's harness, which is what keeps these calls from undoing one another.
 */
// webpieces-disable no-function-outside-class -- setup.ts is deliberately DI-free (it must run on a half-written node_modules; see install-entry.ts), so every function here is module-scope
export function applyChoice(hook: HookSpec, choice: string, targets: InstallTarget[], projectRoot: string): void {
    const chosen = targets.filter((t: InstallTarget): boolean => t.choice === choice);
    if (chosen.length === 0) {
        applyHook(hook, null, targets, projectRoot);
        return;
    }
    for (const target of chosen) applyHook(hook, target, targets, projectRoot);
}

async function wireHook(hook: HookSpec, targets: InstallTarget[], projectRoot: string): Promise<void> {
    console.log('');
    console.log(`${hook.label}`);
    console.log(`  currently installed in: ${currentLocation(hook, targets)}`);
    // The matcher is printed PER TARGET now, because it differs per harness — Codex's file tool is
    // `apply_patch`, Claude's are Write|Edit|MultiEdit — and one matcher printed above the list would be
    // wrong for whichever harness it did not describe.
    for (const target of targets) console.log(`    ${target.choice}) ${target.label}  [matcher: ${hook.matcherFor(target)}]`);
    console.log('    4) none / uninstall');
    const answer = await prompt('  Where should it live? [1/2/3/4, default 4]: ');
    applyChoice(hook, answer, targets, projectRoot);
}

/**
 * Scaffold the SERVER-SIDE PR gate: the CI workflow plus the doc explaining how to turn it on.
 *
 * This lives in the installer, not the PR flow. `wp-start-upsert-pr` used to do it — printing
 * copy-to-`.github` and branch-protection instructions on EVERY run, at an agent doing feature work
 * that could not act on them anyway (marking a check required needs a repo admin). Setup is a
 * one-time, admin-shaped act, so it belongs with the other one-time setup.
 *
 * Written UNCONDITIONALLY, unlike the old version which required a `gateSalt` to already be set: the
 * whole point of the doc is to tell you to set one, so gating it on the thing it teaches meant the
 * instructions only appeared to repos that no longer needed them.
 *
 * Both land in gitignored `.webpieces/instruct-ai/`, never `.github/` directly — writing there would
 * dirty the tree, and copying it is the human's decision. `IfMissing` for the yml so a repo that has
 * customized its workflow never gets it clobbered; the doc itself is refreshed so it cannot go stale.
 */
// webpieces-disable no-function-outside-class -- setup.ts is deliberately DI-free (it must run on a half-written node_modules; see install-entry.ts), so every function here is module-scope
function scaffoldCiGate(projectRoot: string): void {
    writeTemplateIfMissing(projectRoot, 'webpieces-pr-gate.yml');
    writeTemplate(projectRoot, 'webpieces.ci-gate-setup.md');
    console.log('');
    console.log('ℹ️  Optional: server-side PR gate (stops an UNHOOKED teammate opening a PR in the web UI).');
    console.log('   It is OFF until you set a gateSalt. Three steps, one of which needs a repo admin:');
    console.log('     .webpieces/instruct-ai/webpieces.ci-gate-setup.md');
}

export async function main(): Promise<void> {
    const args = process.argv.slice(2);
    // Anchor the install at the repo root (git toplevel — webpieces.config.json may not exist yet on
    // a first install), never a subdir cwd, so `.webpieces`/hooks/config all land at the root.
    const projectRoot = new RepoRootFinder().resolveRepoRoot(process.cwd());

    seedOrSyncConfig(projectRoot);
    // Always refreshed: it explains why a retired key is rejected rather than accepted, and what to do
    // about it — which is exactly what an agent needs on the run where a migration just moved keys out
    // from under its config.
    writeTemplate(projectRoot, CONFIG_POLICY_DOC);

    scaffoldCiGate(projectRoot);

    const targets = installTargets(projectRoot);

    // Non-interactive: `--target=project|project-personal|global|none` installs BOTH hooks at that
    // location without prompting, so an agent or CI can run the installer unattended (e.g. after a
    // @webpieces upgrade that changed the hook entry). Omit the flag for the interactive per-hook chooser.
    const targetName = parseTargetArg(args);
    if (targetName !== null) {
        const choice = resolveTargetChoice(targetName);
        if (choice === null) {
            console.error(`❌ Unknown --target '${targetName}'. Use one of: project | project-personal | global | none`);
            process.exitCode = 1;
            return;
        }
        applyChoice(RULES_HOOK, choice, targets, projectRoot);
        applyChoice(GUARDS_HOOK, choice, targets, projectRoot);
        console.log(`\nDone. Both hooks set to: ${targetName}.`);
        reportCodexTrust(projectRoot, targets, choice);
        return;
    }

    console.log('');
    console.log('Two webpieces hooks can be installed independently — choose a location for each:');
    await wireHook(RULES_HOOK, targets, projectRoot);
    await wireHook(GUARDS_HOOK, targets, projectRoot);
    // Whichever choices were made above, report Codex trust for the project choice — an interactive run
    // that armed Codex needs the same warning the --target path prints.
    reportCodexTrust(projectRoot, targets, '1');
    console.log('');
    console.log('Done. Re-run `pnpm wp-install-ai-hooks` anytime to move or uninstall a hook.');
    console.log('(Non-interactive: pnpm wp-install-ai-hooks --target=project|project-personal|global|none)');
}

if (require.main === module) {
    void main();
}
