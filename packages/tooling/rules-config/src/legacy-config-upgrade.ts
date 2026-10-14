/** Previous-root conversion is reachable only through an explicit upgrade command; normal loading never calls it. */
import { RulePackRegistry } from './rule-pack-registry';
import { allRuleNames, seedEntryForRule } from './validate-config';
import { schemaFieldNames } from './rule-schemas';
import { sectionForRule, isHookGuard } from './sections';
import { DEFAULT_MATCH_RULES } from './match-rules-config';
import { DEFAULT_BUILD_COMMAND } from './pr-gate-config';
import { RETIRED_SCOPE_RULE } from './retired-config-keys';

// Explicit upgrade applies owner-declared retirements and writes reviewed settings.
const DEFAULT_UPSERT_PR = 'pnpm wp-start-upsert-pr';
const DEFAULT_MERGE_COMPLETE = 'pnpm wp-finish-upsert-pr';
// ---------------------------------------------------------------------------
// webpieces.config.json seeding + migration to the rules / hookGuards / commands layout.
// ---------------------------------------------------------------------------
// webpieces-disable no-any-unknown -- webpieces.config.json / settings.json are opaque consumer JSON
type Json = Record<string, unknown>;
type RuleEntry = Json;
type Section = Record<string, RuleEntry>;

export class LegacyConfigDocument {
    readonly 'match-rules': Json[];
    readonly extends: string | undefined;
    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        readonly rules: Section,
        readonly hookGuards: Section,
        readonly commands: Json,
        readonly excludePaths: string[],
        matches: Json[],
        readonly rulesDir: string[],
        inheritedFrom: string | undefined,
    ) {
        this['match-rules'] = matches;
        this.extends = inheritedFrom;
    }
}

export class LegacyUpgradeResult {
    constructor(
        readonly config: LegacyConfigDocument,
        readonly changes: string[],
    ) {}
}

// webpieces-disable no-function-outside-class -- sibling of the other seed* helpers; this module is config-shape builders by design
function seedRule(ruleName: string, registry: RulePackRegistry): RuleEntry {
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
    return seedEntryForRule(ruleName, registry);
}

// The guard-hint command strings live under `guardHints`. The flat `upsertPr`/`mergeComplete` keys this
// used to seed are RETIRED and now fail validation — seeding them meant every freshly installed repo was
// born on a shape the validator rejects.

// Required excludePaths block: ONE glob list suppressing hook enforcement per file path. Seeded empty
// (enforce everywhere) — a client adds paths (e.g. "repositories/**") to exempt vendored trees.
//
// Deliberately NOT seeded with webpieces' own `.webpieces/` state dir. That exemption lives in CODE
// (`isWebpiecesStateDir`, consulted by `filterByExcludedPaths` ahead of this list and regardless of it),
// and a glob here would be a second, weaker spelling of it — weaker because `.webpieces/**` compiles to
// an anchored regex that misses the bare directory the predicate matches, and because a config entry
// invites a consumer to delete it and believe the exemption went with it.

// Bring an existing `excludePaths` forward to the single-list shape. Already a list → untouched.
// Legacy `{ rules, guards }` → unioned (order preserved, duplicates dropped) and recorded as a change
// so `pnpm wp-rules-sync --upgrade` is the migration path rather than a hand-edit. Anything else → seeded [].
// webpieces-disable no-any-unknown -- opaque legacy JSON is narrowed before use
// webpieces-disable no-function-outside-class -- pure legacy config conversion helper
function migrateExcludePaths(raw: unknown, changes: string[]): string[] {
    if (Array.isArray(raw)) return (raw as string[]).filter((p: string) => typeof p === 'string');
    if (typeof raw === 'object' && raw !== null) {
        // webpieces-disable no-any-unknown -- narrowing the opaque legacy block from consumer JSON
        const legacy = raw as Record<string, unknown>;
        const rules = Array.isArray(legacy['rules']) ? (legacy['rules'] as string[]) : [];
        const guards = Array.isArray(legacy['guards']) ? (legacy['guards'] as string[]) : [];
        const merged = [
            ...new Set([...rules, ...guards].filter((p: string) => typeof p === 'string')),
        ];
        changes.push(`migrated excludePaths {rules,guards} -> one list (${merged.length} path(s))`);
        return merged;
    }
    changes.push('added excludePaths ([])');
    return [];
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
    const hints: Json =
        typeof commands['guardHints'] === 'object' && commands['guardHints'] !== null
            ? (commands['guardHints'] as Json)
            : {};
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
function migrateRetiredRuleNames(
    section: Section,
    changes: string[],
    registry: RulePackRegistry,
): void {
    for (const entry of registry.migrations()) {
        if (entry.scope !== RETIRED_SCOPE_RULE) continue;
        if (!(entry.key in section)) continue;
        if (entry.prunable) {
            delete section[entry.key];
            changes.push(`deleted retired "${entry.key}" (it moved to ${entry.movedTo})`);
            continue;
        }
        mergeIntoDestination(section, entry.key, entry.movedTo, changes, registry);
    }
    fillRequiredFields(section, changes, registry);
}

/**
 * Fold one retired key's entry into its destination, whether the destination exists yet or not.
 *
 * THIS IS N→1, NOT 1:1, and the difference is the whole reason this helper exists. Four retired keys
 * now point at ONE destination (`branch-state-guard`, `pr-lifecycle-guard`). The previous code renamed
 * the first key it met and then, finding the destination already present, DELETED each of the other
 * three outright — so which guard's settings survived depended on RETIRED_CONFIG_KEYS declaration
 * order rather than on the consumer's file, and the survivor carried only that one guard's fields, so
 * it was missing required fields of the merged schema. `pnpm wp-rules-sync --upgrade` is the command advertised
 * as the migration path; half-migrating every consumer into an invalid config is not an option.
 *
 * UNION, first writer wins per field. Earlier-declared keys are the more specific ones (only
 * feature-branch-guard carries `branchNamingConvention`), and a field already present on the
 * destination — because the consumer wrote it, or an earlier key contributed it — is never overwritten.
 * Fields the merged schema does not know are dropped by the same pass, since carrying a deleted field
 * across (`upsertPrCommand`) would produce a config the validator immediately rejects.
 */
// webpieces-disable no-function-outside-class -- sibling of the other seed*/migrate* helpers; this module is config-shape builders by design
function mergeIntoDestination(
    section: Section,
    key: string,
    destination: string,
    changes: string[],
    registry: RulePackRegistry,
): void {
    const source = asSection(section[key]);
    delete section[key];
    const fields = schemaFieldNames(destination, registry);
    const target = asSection(section[destination]);
    const existed = destination in section;
    const carried: string[] = [];
    const dropped: string[] = [];
    for (const field of Object.keys(source)) {
        if (fields !== null && !fields.includes(field)) {
            dropped.push(field);
            continue;
        }
        if (field in target) continue;
        target[field] = source[field];
        carried.push(field);
    }
    section[destination] = target;
    const verb = existed ? 'merged' : 'renamed';
    const droppedNote =
        dropped.length > 0 ? `; dropped deleted field(s) ${dropped.join(', ')}` : '';
    changes.push(
        `${verb} retired "${key}" -> "${destination}" (carried ${carried.join(', ') || 'nothing new'}${droppedNote})`,
    );
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
function fillRequiredFields(section: Section, changes: string[], registry: RulePackRegistry): void {
    for (const name of Object.keys(section)) {
        if (schemaFieldNames(name, registry) === null) continue;
        // A rule ENTRY is a flat bag of scalars, so it is read as Json here rather than through
        // asSection (whose values are whole entries). Same object either way; only the view differs.
        const entry: Json = asSection(section[name]);
        const seed = seedEntryForRule(name, registry);
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
// webpieces-disable no-function-outside-class -- this module is deliberately DI-FREE: `pnpm wp-rules-sync --upgrade` must run on a half-written node_modules (see install-entry.ts), so it cannot build a container to hold a method
function seedMatchRules(): Json[] {
    return JSON.parse(JSON.stringify(DEFAULT_MATCH_RULES)) as Json[];
}

// webpieces-disable no-function-outside-class -- this module is deliberately DI-FREE: `pnpm wp-rules-sync --upgrade` must run on a half-written node_modules (see install-entry.ts), so it cannot build a container to hold a method
function asSection(value: Json[string]): Section {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Section)
        : {};
}

// Migrate an existing config to the rules / hookGuards / commands layout and add any missing rules.
// Returns a human-readable list of what changed (empty = already up to date).
// webpieces-disable no-function-outside-class -- this module is deliberately DI-FREE: `pnpm wp-rules-sync --upgrade` must run on a half-written node_modules (see install-entry.ts), so it cannot build a container to hold a method
export function prepareLegacyUpgrade(
    existing: Json,
    registry: RulePackRegistry,
): LegacyUpgradeResult {
    const changes: string[] = [];
    const rules: Section = asSection(existing['rules']);
    const hookGuards: Section = asSection(existing['hookGuards']);
    const commands: Json =
        typeof existing['commands'] === 'object' && existing['commands'] !== null
            ? (existing['commands'] as Json)
            : {};

    // Move a deprecated top-level pr-gate block under commands.
    if (existing['pr-gate'] !== undefined && commands['pr-gate'] === undefined) {
        commands['pr-gate'] = existing['pr-gate'];
        changes.push('moved top-level "pr-gate" → commands["pr-gate"]');
    }
    // Apply retired RENAMES first, so a renamed guard is placed and presence-checked under its new name
    // rather than being treated as unknown and re-added alongside its own stale entry.
    migrateRetiredRuleNames(rules, changes, registry);
    migrateRetiredRuleNames(hookGuards, changes, registry);

    migratePolicySections(rules, hookGuards, changes, registry);
    // Add any missing built-in into its correct section, ENFORCING at its recommended mode (not OFF).
    for (const name of allRuleNames(registry)) {
        const target = sectionForRule(name, registry) === 'hookGuards' ? hookGuards : rules;
        if (!(name in target)) {
            const entry = seedRule(name, registry);
            target[name] = entry;
            changes.push(
                `added "${name}" (${String(entry['mode'])}) to ${sectionForRule(name, registry)}`,
            );
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

    const matchRules = upgradeMatchRules(existing, changes);

    const rulesDir: string[] = Array.isArray(existing['rulesDir'])
        ? (existing['rulesDir'] as string[])
        : [];
    const inherited = typeof existing['extends'] === 'string' ? existing['extends'] : undefined;
    return new LegacyUpgradeResult(
        new LegacyConfigDocument(
            rules,
            hookGuards,
            commands,
            excludePaths,
            matchRules,
            rulesDir,
            inherited,
        ),
        changes,
    );
}

// webpieces-disable no-function-outside-class -- explicit upgrade conversion remains independent of DI
function migratePolicySections(rules: Section, hookGuards: Section, changes: string[], registry: RulePackRegistry): void {
    // Move guards mistakenly left in rules into hookGuards.
    for (const name of Object.keys(rules)) {
        if (isHookGuard(name, registry)) {
            hookGuards[name] = rules[name];
            delete rules[name];
            changes.push(`moved "${name}" from rules → hookGuards`);
        }
    }
    // Move code rules mistakenly placed in hookGuards back into rules.
    for (const name of Object.keys(hookGuards)) {
        if (!isHookGuard(name, registry) && allRuleNames(registry).includes(name)) {
            rules[name] = hookGuards[name];
            delete hookGuards[name];
            changes.push(`moved "${name}" from hookGuards → rules`);
        }
    }
}

// webpieces-disable no-function-outside-class -- pure explicit-upgrade conversion
function upgradeMatchRules(existing: Json, changes: string[]): Json[] {
    // Seed the now-required match-rules array (with the default no-fetch guard) if the config predates
    // it. A client that has already customized it keeps their array untouched.
    let matchRules: Json[];
    if (Array.isArray(existing['match-rules'])) {
        matchRules = existing['match-rules'] as Json[];
    } else {
        matchRules = seedMatchRules();
        changes.push('added "match-rules" (seeded with the no-fetch guard)');
    }

    return matchRules;
}
