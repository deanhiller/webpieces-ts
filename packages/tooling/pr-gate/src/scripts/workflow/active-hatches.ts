import * as path from 'path';

import {
    CONFIG_FILENAME,
    ConfigFile,
    PackPolicyFiles,
    PackPolicyDeclaration,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

/** One rule that is currently NOT being enforced, and which of the two hatches is doing it. Data-only. */
export class ActiveHatch {
    /** The rule/guard/match-rule name as it appears in webpieces.config.json. */
    ruleName: string;
    /** `turnOffRuleWhileOnBranch` or `turnOffRuleUntilEpoch` — the field, spelled the way the config spells it. */
    hatchField: string;
    /** Already rendered for a human: a quoted branch name, or the ISO date the epoch expires. */
    value: string;

    constructor(ruleName: string, hatchField: string, value: string) {
        this.ruleName = ruleName;
        this.hatchField = hatchField;
        this.value = value;
    }
}

/**
 * One named block of webpieces.config.json — a `rules`/`hookGuards` entry, or a `match-rules` array element
 * that carries its own `name`. Data-only, so the three config shapes are scanned as one list.
 */
export class ConfigEntry {
    ruleName: string;
    // webpieces-disable no-any-unknown -- an unvalidated config block: the values are opaque JSON here, and each hatch field is type-checked before it is read
    fields: Record<string, unknown>;

    // webpieces-disable no-any-unknown -- see the field above
    constructor(ruleName: string, fields: Record<string, unknown>) {
        this.ruleName = ruleName;
        this.fields = fields;
    }
}

/**
 * The active-hatch section of the `wp-review-upsert-pr` dashboard: every rule that is currently switched
 * off, listed once per PR.
 *
 * PURELY INFORMATIONAL — it never fails a build, never blocks a PR, and never asks for anything. It exists
 * because a hatch is the one config change that makes the build QUIETER, so nothing else in the flow will
 * ever mention it. The motivating case is an EPOCH hatch: it is repo-wide while it lasts, so a long window
 * shelters every unrelated change landing in it, and a fleet repo was found with max-file-lines and
 * max-method-lines switched off until 2026-10-01 — 43 days out — with nobody aware. (The ONE-WEEK cap in
 * rules-config stops new ones from getting that far; this is how you SEE the ones you have.)
 *
 * A branch hatch is listed for completeness, not as a complaint. It fires on ONE exact branch name, so a
 * stale one is close to harmless — and deliberately there is NO "does that branch still exist on the
 * remote?" check here, because a pruned remote would make that a false alarm on every PR.
 */
@injectable(bindingScopeValues.Singleton)
export class ActiveHatchReport {
    constructor(
        private readonly configFile: ConfigFile,
        private readonly files: PackPolicyFiles,
    ) {}

    /**
     * Every active hatch in the repo's config: a non-null `turnOffRuleWhileOnBranch`, or a
     * `turnOffRuleUntilEpoch` still in the future. An epoch in the PAST is inert — it skips nothing — and
     * listing those would bury the live ones under every rule in the file.
     */
    scan(repoRoot: string): ActiveHatch[] {
        const raw = this.configFile.readRawConfig(path.join(repoRoot, CONFIG_FILENAME));
        const found: ActiveHatch[] = [];
        const declarations = this.files.declarations(raw.rulePacks, repoRoot);
        const entries = declarations.flatMap((declaration: PackPolicyDeclaration) =>
            this.keyedEntries(this.files.read(this.files.configPath(repoRoot, declaration.config))),
        );
        entries.push(...this.matchRuleEntries(raw['match-rules']));
        for (const entry of entries) found.push(...this.hatchesOf(entry));
        return found;
    }

    /** The section, or an empty string when nothing is hatched — the common case prints nothing at all. */
    render(hatches: readonly ActiveHatch[]): string {
        if (hatches.length === 0) return '';
        const width = Math.max(...hatches.map((h: ActiveHatch): number => h.ruleName.length));
        const lines = hatches.map(
            (h: ActiveHatch): string =>
                `      ${h.ruleName.padEnd(width)}  ${h.hatchField.padEnd(24)} = ${h.value}`,
        );
        return (
            `\n⚠️  ${hatches.length} rule hatch(es) are currently active in ${CONFIG_FILENAME}:\n` +
            lines.join('\n') +
            '\n' +
            '      Not blocking, and not necessarily wrong — just so a rule that is OFF is never off silently.\n'
        );
    }

    /** An owner file's `name → block` map as entries, without requiring valid lock/schema data. */
    // webpieces-disable no-any-unknown -- an unvalidated config section: opaque JSON in, type-checked fields out
    private keyedEntries(
        // webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
        section: Record<string, Record<string, unknown>> | undefined,
    ): ConfigEntry[] {
        if (!section) return [];
        return Object.keys(section).map(
            (name: string): ConfigEntry => new ConfigEntry(name, section[name]),
        );
    }

    /** The `match-rules` array, whose elements carry their own `name`. Typed `unknown` in RawConfigFile. */
    // webpieces-disable no-any-unknown -- RawConfigFile types this section unknown on purpose; it is validated structurally elsewhere
    private matchRuleEntries(section: unknown): ConfigEntry[] {
        if (!Array.isArray(section)) return [];
        // webpieces-disable no-any-unknown -- one opaque config block per element
        return (section as Record<string, unknown>[]).map(
            // webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
            (entry: Record<string, unknown>): ConfigEntry => {
                const name = entry['name'];
                return new ConfigEntry(
                    typeof name === 'string' ? name : '(unnamed match-rule)',
                    entry,
                );
            },
        );
    }

    private hatchesOf(entry: ConfigEntry): ActiveHatch[] {
        const hatches: ActiveHatch[] = [];
        const branch = entry.fields['turnOffRuleWhileOnBranch'];
        if (typeof branch === 'string' && branch !== '') {
            hatches.push(
                new ActiveHatch(entry.ruleName, 'turnOffRuleWhileOnBranch', `"${branch}"`),
            );
        }
        const epoch = entry.fields['turnOffRuleUntilEpoch'];
        if (typeof epoch === 'number' && epoch > Date.now() / 1000) {
            hatches.push(
                new ActiveHatch(entry.ruleName, 'turnOffRuleUntilEpoch', this.isoDate(epoch)),
            );
        }
        return hatches;
    }

    private isoDate(epochSeconds: number): string {
        return new Date(epochSeconds * 1000).toISOString().split('T')[0];
    }
}
