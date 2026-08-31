import * as fs from 'fs';
import * as path from 'path';

import {
    allRuleNames, seedEntryForRule, schemaFieldNames, sectionForRule, isHookGuard, DEFAULT_MATCH_RULES,
    DEFAULT_BUILD_COMMAND, RETIRED_CONFIG_KEYS, RETIRED_SCOPE_RULE,
} from '@webpieces/rules-config';

import { toError } from '../core/to-error';

/**
 * SEEDING AND MIGRATING `webpieces.config.json` — the installer's OTHER job.
 *
 * Split out of ./setup.ts purely for size, and along the seam that was already there: setup.ts is now
 * hook WIRING (which settings file gets which matcher and which shim command) and this module is CONFIG
 * SHAPE (which rules exist, where a retired key moves to). They share only `main()`, which calls this
 * once and then wires the hooks.
 *
 * Like setup.ts it is deliberately DI-FREE: `wp-install-ai-hooks` has to run on a half-written
 * node_modules (see install-entry.ts), so every function here is module-scope and imports nothing that
 * needs a container.
 */
const CONFIG_FILENAME = 'webpieces.config.json';
// The seeded buildCommand comes from @webpieces/rules-config, NOT from a copy here. This file used to
// hold its own — with `--base=origin/main`, a DIFFERENT base from the one the gate documents — so a
// freshly set-up repo was seeded with a command that rebuilds projects touched by other people's
// merged PRs, and whole-repo-build-guard then quoted that command back in its refusals.
const DEFAULT_UPSERT_PR = 'pnpm wp-start-upsert-pr';
const DEFAULT_MERGE_COMPLETE = 'pnpm wp-finish-upsert-pr';
// ---------------------------------------------------------------------------
// webpieces.config.json seeding + migration to the rules / hookGuards / commands layout.
// ---------------------------------------------------------------------------
// webpieces-disable no-any-unknown -- webpieces.config.json / settings.json are opaque consumer JSON
type Json = Record<string, unknown>;
type RuleEntry = Json;
type Section = Record<string, RuleEntry>;

interface ConfigFile {
    extends?: string;
    rules: Section;
    hookGuards: Section;
    commands: Json;
    excludePaths: string[];
    'match-rules': Json[];
    rulesDir: string[];
}

interface MigrateResult {
    config: ConfigFile;
    changes: string[];
}

// webpieces-disable no-function-outside-class -- sibling of the other seed* helpers; this module is config-shape builders by design
function seedRule(ruleName: string): RuleEntry {
    // Both escape hatches are seeded (and REQUIRED) so every rule block shows them: 0 = active,
    // null = no branch scoping. A human/AI edits these to time-box or branch-scope a rule off.
    //
    // The ENTIRE entry comes from rules-config's seedEntryForRule() — the same module that owns the
    // schema the loader validates against, so the installer can never emit an entry the loader
    // rejects. It supplies: the recommended mode (the SAME recommendation the validator prints in its
    // copy-paste snippet, so seed and advice cannot disagree), both hatches, and a default for every
    // other schema-REQUIRED field. Seeding used to be a flat 'OFF' plus the two hatches, which was
    // wrong twice over: adopters got nothing enforced, AND the entry was missing required fields
    // (e.g. branch-creation-guard.autoReapMergedBranches), so the config failed to load on first run.
    return seedEntryForRule(ruleName);
}

// The guard-hint command strings live under `guardHints`. The flat `upsertPr`/`mergeComplete` keys this
// used to seed are RETIRED and now fail validation — seeding them meant every freshly installed repo was
// born on a shape the validator rejects.
// webpieces-disable no-function-outside-class -- this module is deliberately DI-FREE: `wp-install-ai-hooks` must run on a half-written node_modules (see install-entry.ts), so it cannot build a container to hold a method
function seedCommands(): Json {
    return {
        'pr-gate': { mode: 'OFF', buildCommand: DEFAULT_BUILD_COMMAND, gates: [] },
        guardHints: { prCreationOrPush: DEFAULT_UPSERT_PR, mergeInProgress: DEFAULT_MERGE_COMPLETE },
    };
}

// Required excludePaths block: ONE glob list suppressing hook enforcement per file path. Seeded empty
// (enforce everywhere) — a client adds paths (e.g. "repositories/**") to exempt vendored trees.
//
// Deliberately NOT seeded with webpieces' own `.webpieces/` state dir. That exemption lives in CODE
// (`isWebpiecesStateDir`, consulted by `filterByExcludedPaths` ahead of this list and regardless of it),
// and a glob here would be a second, weaker spelling of it — weaker because `.webpieces/**` compiles to
// an anchored regex that misses the bare directory the predicate matches, and because a config entry
// invites a consumer to delete it and believe the exemption went with it.
// webpieces-disable no-function-outside-class -- sibling of the other seed* helpers; this module is config-shape builders by design
function seedExcludePaths(): string[] {
    return [];
}

// Bring an existing `excludePaths` forward to the single-list shape. Already a list → untouched.
// Legacy `{ rules, guards }` → unioned (order preserved, duplicates dropped) and recorded as a change
// so `wp-install-ai-hooks` is the migration path rather than a hand-edit. Anything else → seeded [].
// webpieces-disable no-any-unknown -- `raw` is opaque consumer JSON until narrowed here
// webpieces-disable no-function-outside-class -- sibling of the other seed*/migrate* helpers; this module is config-shape builders by design
function migrateExcludePaths(raw: unknown, changes: string[]): string[] {
    if (Array.isArray(raw)) return (raw as string[]).filter(p => typeof p === 'string');
    if (typeof raw === 'object' && raw !== null) {
        // webpieces-disable no-any-unknown -- narrowing the opaque legacy block from consumer JSON
        const legacy = raw as Record<string, unknown>;
        const rules = Array.isArray(legacy['rules']) ? (legacy['rules'] as string[]) : [];
        const guards = Array.isArray(legacy['guards']) ? (legacy['guards'] as string[]) : [];
        const merged = [...new Set([...rules, ...guards].filter(p => typeof p === 'string'))];
        changes.push(`migrated excludePaths {rules,guards} -> one list (${merged.length} path(s))`);
        return merged;
    }
    changes.push('added excludePaths ([])');
    return seedExcludePaths();
}

/** One retired flat command string and the guardHints field it becomes. Data-only (per CLAUDE.md). */
class GuardHintMove {
    retiredKey: string;
    hintKey: string;
    fallback: string;

    constructor(retiredKey: string, hintKey: string, fallback: string) {
        this.retiredKey = retiredKey;
        this.hintKey = hintKey;
        this.fallback = fallback;
    }
}

/**
 * Bring `commands` forward to the `guardHints` shape, moving the RETIRED flat `upsertPr`/`mergeComplete`
 * strings and DELETING them. Deleting is the point: the validator now rejects them, so leaving them behind
 * would keep the config failing after a "successful" sync.
 *
 * The consumer's own value wins over the default — a repo that renamed its gated command keeps that name.
 */
// webpieces-disable no-function-outside-class -- sibling of the other seed*/migrate* helpers; this module is config-shape builders by design
function migrateGuardHints(commands: Json, changes: string[]): void {
    const hints: Json = (typeof commands['guardHints'] === 'object' && commands['guardHints'] !== null)
        ? (commands['guardHints'] as Json) : {};
    const moves: readonly GuardHintMove[] = [
        new GuardHintMove('upsertPr', 'prCreationOrPush', DEFAULT_UPSERT_PR),
        new GuardHintMove('mergeComplete', 'mergeInProgress', DEFAULT_MERGE_COMPLETE),
    ];
    for (const move of moves) {
        const retiredKey = move.retiredKey;
        const hintKey = move.hintKey;
        const fallback = move.fallback;
        const carried = commands[retiredKey];
        if (carried !== undefined) {
            delete commands[retiredKey];
            if (hints[hintKey] === undefined) hints[hintKey] = carried;
            changes.push(`moved retired commands.${retiredKey} -> commands.guardHints.${hintKey}`);
        }
        if (hints[hintKey] === undefined) {
            hints[hintKey] = fallback;
            changes.push(`added commands.guardHints.${hintKey}`);
        }
    }
    commands['guardHints'] = hints;
}

/**
 * Apply the RETIRED rule/guard retirements in place. These used to be rewritten silently at load time, so
 * a consumer's file kept the dead name forever; the loader now rejects it, which makes this the one
 * command that can fix the file. Skips a rename when the new name is already configured, so an explicit
 * entry is never clobbered by a stale one.
 *
 * NOT EVERY RETIREMENT IS A RENAME, and treating them all as one produced garbage. `whole-repo-build-guard`
 * moved OUT of webpieces.config.json entirely — its `movedTo` is the PROSE destination
 * `~/.webpieces/config.json → experimental.whole-repo-build-guard`, not a sibling key — so the rename
 * branch below would have created a hookGuards entry literally named that whole sentence, which no
 * validator knows and which the next run reports as another unknown rule. `prunable` is the discriminator:
 * when the entry says deleting is the whole fix, DELETE it, exactly as `ConfigPruner` does.
 */
// webpieces-disable no-function-outside-class -- sibling of the other seed*/migrate* helpers; this module is config-shape builders by design
function migrateRetiredRuleNames(section: Section, changes: string[]): void {
    for (const entry of RETIRED_CONFIG_KEYS) {
        if (entry.scope !== RETIRED_SCOPE_RULE) continue;
        if (!(entry.key in section)) continue;
        if (entry.prunable) {
            delete section[entry.key];
            changes.push(`deleted retired "${entry.key}" (it moved to ${entry.movedTo})`);
            continue;
        }
        mergeIntoDestination(section, entry.key, entry.movedTo, changes);
    }
    fillRequiredFields(section, changes);
}

/**
 * Fold one retired key's entry into its destination, whether the destination exists yet or not.
 *
 * THIS IS N→1, NOT 1:1, and the difference is the whole reason this helper exists. Four retired keys
 * now point at ONE destination (`branch-state-guard`, `pr-lifecycle-guard`). The previous code renamed
 * the first key it met and then, finding the destination already present, DELETED each of the other
 * three outright — so which guard's settings survived depended on RETIRED_CONFIG_KEYS declaration
 * order rather than on the consumer's file, and the survivor carried only that one guard's fields, so
 * it was missing required fields of the merged schema. `wp-install-ai-hooks` is the command advertised
 * as the migration path; half-migrating every consumer into an invalid config is not an option.
 *
 * UNION, first writer wins per field. Earlier-declared keys are the more specific ones (only
 * feature-branch-guard carries `branchNamingConvention`), and a field already present on the
 * destination — because the consumer wrote it, or an earlier key contributed it — is never overwritten.
 * Fields the merged schema does not know are dropped by the same pass, since carrying a deleted field
 * across (`upsertPrCommand`) would produce a config the validator immediately rejects.
 */
// webpieces-disable no-function-outside-class -- sibling of the other seed*/migrate* helpers; this module is config-shape builders by design
function mergeIntoDestination(section: Section, key: string, destination: string, changes: string[]): void {
    const source = asSection(section[key]);
    delete section[key];
    const fields = schemaFieldNames(destination);
    const target = asSection(section[destination]);
    const existed = destination in section;
    const carried: string[] = [];
    const dropped: string[] = [];
    for (const field of Object.keys(source)) {
        if (fields !== null && !fields.includes(field)) { dropped.push(field); continue; }
        if (field in target) continue;
        target[field] = source[field];
        carried.push(field);
    }
    section[destination] = target;
    const verb = existed ? 'merged' : 'renamed';
    const droppedNote = dropped.length > 0 ? `; dropped deleted field(s) ${dropped.join(', ')}` : '';
    changes.push(`${verb} retired "${key}" -> "${destination}" (carried ${carried.join(', ') || 'nothing new'}${droppedNote})`);
}

/**
 * Fill any schema-REQUIRED field a migrated entry ended up without.
 *
 * A union of four partial entries is not guaranteed to satisfy the destination's schema — the merged
 * `branch-state-guard` needs `mode` and both escape hatches, and a consumer whose four old entries
 * predate one of them would land short. Seeding the gap from the SAME source the installer and the
 * validator use (seedEntryForRule) is what makes the install command a complete instruction
 * rather than a first step. Only ever ADDS; a value the consumer stated is never touched.
 */
// webpieces-disable no-function-outside-class -- sibling of the other seed*/migrate* helpers; this module is config-shape builders by design
function fillRequiredFields(section: Section, changes: string[]): void {
    for (const name of Object.keys(section)) {
        if (schemaFieldNames(name) === null) continue;
        // A rule ENTRY is a flat bag of scalars, so it is read as Json here rather than through
        // asSection (whose values are whole entries). Same object either way; only the view differs.
        const entry: Json = asSection(section[name]);
        const seed = seedEntryForRule(name);
        const added: string[] = [];
        for (const field of Object.keys(seed)) {
            if (field in entry) continue;
            entry[field] = seed[field];
            added.push(field);
        }
        if (added.length === 0) continue;
        section[name] = entry;
        changes.push(`filled required field(s) on "${name}": ${added.join(', ')}`);
    }
}

// Deep-copy the framework's default match-rules (the no-fetch guard) into plain JSON for the config
// file. Round-tripping through JSON turns the MatchRuleConfig instances into plain objects.
// webpieces-disable no-function-outside-class -- this module is deliberately DI-FREE: `wp-install-ai-hooks` must run on a half-written node_modules (see install-entry.ts), so it cannot build a container to hold a method
function seedMatchRules(): Json[] {
    return JSON.parse(JSON.stringify(DEFAULT_MATCH_RULES)) as Json[];
}

// webpieces-disable no-function-outside-class -- this module is deliberately DI-FREE: `wp-install-ai-hooks` must run on a half-written node_modules (see install-entry.ts), so it cannot build a container to hold a method
function buildSeedConfig(): ConfigFile {
    const rules: Section = {};
    const hookGuards: Section = {};
    for (const name of allRuleNames()) {
        if (sectionForRule(name) === 'hookGuards') hookGuards[name] = seedRule(name);
        else rules[name] = seedRule(name);
    }
    return {
        rules, hookGuards, commands: seedCommands(), excludePaths: seedExcludePaths(),
        // Seed the required match-rules array with the framework's default no-fetch guard. A fresh
        // project gets contract-first enforcement out of the box; clients edit it and add more entries.
        'match-rules': seedMatchRules(),
        rulesDir: [],
    };
}

// webpieces-disable no-function-outside-class -- this module is deliberately DI-FREE: `wp-install-ai-hooks` must run on a half-written node_modules (see install-entry.ts), so it cannot build a container to hold a method
function writeConfig(configPath: string, config: ConfigFile): void {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4) + '\n');
}

// webpieces-disable no-function-outside-class -- this module is deliberately DI-FREE: `wp-install-ai-hooks` must run on a half-written node_modules (see install-entry.ts), so it cannot build a container to hold a method
function readConfig(configPath: string): Json {
    const raw = fs.readFileSync(configPath, 'utf8');
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        return JSON.parse(raw) as Json;
    } catch (err: unknown) {
        const error = toError(err);
        throw new Error(`${CONFIG_FILENAME} has invalid JSON — fix it, then retry: ${error.message}`, { cause: error });
    }
}

// webpieces-disable no-function-outside-class -- this module is deliberately DI-FREE: `wp-install-ai-hooks` must run on a half-written node_modules (see install-entry.ts), so it cannot build a container to hold a method
function asSection(value: Json[string]): Section {
    return (typeof value === 'object' && value !== null && !Array.isArray(value)) ? (value as Section) : {};
}

// Migrate an existing config to the rules / hookGuards / commands layout and add any missing rules.
// Returns a human-readable list of what changed (empty = already up to date).
// webpieces-disable no-function-outside-class -- this module is deliberately DI-FREE: `wp-install-ai-hooks` must run on a half-written node_modules (see install-entry.ts), so it cannot build a container to hold a method
export function migrate(existing: Json): MigrateResult {
    const changes: string[] = [];
    const rules: Section = asSection(existing['rules']);
    const hookGuards: Section = asSection(existing['hookGuards']);
    const commands: Json = (typeof existing['commands'] === 'object' && existing['commands'] !== null)
        ? (existing['commands'] as Json) : {};

    // Move a deprecated top-level pr-gate block under commands.
    if (existing['pr-gate'] !== undefined && commands['pr-gate'] === undefined) {
        commands['pr-gate'] = existing['pr-gate'];
        changes.push('moved top-level "pr-gate" → commands["pr-gate"]');
    }
    // Apply retired RENAMES first, so a renamed guard is placed and presence-checked under its new name
    // rather than being treated as unknown and re-added alongside its own stale entry.
    migrateRetiredRuleNames(rules, changes);
    migrateRetiredRuleNames(hookGuards, changes);

    // Move guards mistakenly left in rules into hookGuards.
    for (const name of Object.keys(rules)) {
        if (isHookGuard(name)) {
            hookGuards[name] = rules[name];
            delete rules[name];
            changes.push(`moved "${name}" from rules → hookGuards`);
        }
    }
    // Move code rules mistakenly placed in hookGuards back into rules.
    for (const name of Object.keys(hookGuards)) {
        if (!isHookGuard(name) && allRuleNames().includes(name)) {
            rules[name] = hookGuards[name];
            delete hookGuards[name];
            changes.push(`moved "${name}" from hookGuards → rules`);
        }
    }
    // Add any missing built-in into its correct section, ENFORCING at its recommended mode (not OFF).
    for (const name of allRuleNames()) {
        const target = sectionForRule(name) === 'hookGuards' ? hookGuards : rules;
        if (!(name in target)) {
            const entry = seedRule(name);
            target[name] = entry;
            changes.push(`added "${name}" (${String(entry['mode'])}) to ${sectionForRule(name)}`);
        }
    }
    // Fill command defaults.
    if (commands['pr-gate'] === undefined) {
        commands['pr-gate'] = { mode: 'OFF', buildCommand: DEFAULT_BUILD_COMMAND, gates: [] };
        changes.push('added commands["pr-gate"] (OFF)');
    }
    migrateGuardHints(commands, changes);

    // Seed the now-required excludePaths list (empty = enforce everywhere) if the config predates it,
    // and MIGRATE the legacy `{ rules: [], guards: [] }` object to the single list by unioning them.
    // The union is behaviour-preserving for every config we have seen (both lists set identically), and
    // widening is the safe direction anyway: a path either side excluded stays excluded.
    const excludePaths: string[] = migrateExcludePaths(existing['excludePaths'], changes);

    // Seed the now-required match-rules array (with the default no-fetch guard) if the config predates
    // it. A client that has already customized it keeps their array untouched.
    let matchRules: Json[];
    if (Array.isArray(existing['match-rules'])) {
        matchRules = existing['match-rules'] as Json[];
    } else {
        matchRules = seedMatchRules();
        changes.push('added "match-rules" (seeded with the no-fetch guard)');
    }

    const rulesDir: string[] = Array.isArray(existing['rulesDir']) ? (existing['rulesDir'] as string[]) : [];
    const config: ConfigFile = { rules, hookGuards, commands, excludePaths, 'match-rules': matchRules, rulesDir };
    if (typeof existing['extends'] === 'string') config.extends = existing['extends'];
    return { config, changes };
}

// Seed the config when it is missing, migrate it when it is not. ONE behaviour, always — there is no
// "migrate but stop here" mode any more. The flag that used to select it was never NECESSARY (the validator prints
// the exact edit for every error at once, and editing webpieces.config.json is always allowed through the
// guard — the documented primary cure), it REFUSED to act when the config was missing (useless in the one
// case automation would have helped), and it gave deny messages a second competing path when they are
// supposed to end in exactly one action. Readers also mistook it for the shim-repair command, which it
// never was — `wp-upgrade-shim` is that.
// webpieces-disable no-function-outside-class -- setup.ts is deliberately DI-free (it must run on a half-written node_modules; see install-entry.ts), so every function here is module-scope
export function seedOrSyncConfig(projectRoot: string): void {
    const configPath = path.join(projectRoot, CONFIG_FILENAME);
    if (!fs.existsSync(configPath)) {
        writeConfig(configPath, buildSeedConfig());
        console.log(`  [ai-hooks] Created ${CONFIG_FILENAME} (rules / hookGuards / commands); each rule seeded at its recommended mode — gradual where supported, so only code you change is enforced.`);
        console.log('  Enable the ones you want by changing "mode".');
        return;
    }
    const result = migrate(readConfig(configPath));
    if (result.changes.length === 0) {
        console.log(`  [ai-hooks] ${CONFIG_FILENAME} already uses the rules / hookGuards / commands layout — no changes.`);
        return;
    }
    writeConfig(configPath, result.config);
    console.log(`  [ai-hooks] Migrated ${CONFIG_FILENAME}:`);
    for (const change of result.changes) console.log(`    - ${change}`);
}
