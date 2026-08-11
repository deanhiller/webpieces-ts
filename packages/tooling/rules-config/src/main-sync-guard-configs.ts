import { FieldDef, SchemaShape } from './field-def';
import { BaseRuleConfig, BASE_RULE_SCHEMA, OnOffMode, ON_OFF_MODES } from './rule-configs';

/**
 * `branch-state-guard` — ONE key, ONE policy: *may I work here, and is what I read current?*
 *
 * Four CLASSES implement it, because the tool wiring genuinely differs (a Read names one file, a Bash
 * command is opaque, and the two Bash halves are not De Morgan duals of each other — see
 * guards/L2-branch-state.md, "Deliberate divergence"):
 *
 *                     | on stale `main` (state A)  | on an already-merged branch (state B)
 *   Write/Edit        | feature-branch-guard       | feature-branch-guard
 *   Read              | read-stale-guard           | read-stale-guard
 *   Bash              | stale-main-bash-guard      | merged-branch-bash-guard
 *
 * Those four class NAMES are unchanged and still appear in every decision-log line as `rule=`, so
 * `grep rule=stale-main-bash-guard` over `.webpieces/logs/L2-decisions` keeps working. What merged is
 * the SWITCH: all four read this one config entry (`AbstractRule.configKey`).
 *
 * ## Why one key and not four
 *
 * Four keys made **half a policy representable**: `read-stale-guard: OFF` beside
 * `merged-branch-bash-guard: ON` is "read the file, yes; `cat` the same file, no" — the same
 * information, opposite verdicts. Nobody chose that; it was reachable because the config had a knob
 * per class instead of a knob per decision. One key makes it unconstructible.
 *
 * And `hangTimeoutMinutes` was declared four times, read four times, and fed ONE shared refresher for
 * ONE shared cache — with a per-process latch (main-sync-refresh.ts) plus config-blind callers ahead of
 * the guards, so at most one of the four values could ever reach a spawn. Four knobs, one honoured; now
 * one knob, honoured everywhere (runner + hook-core route through this entry too).
 */
export class BranchStateGuardConfig extends BaseRuleConfig {
    declare mode?: OnOffMode;
    // Surfaced verbatim in the on-main block's message, so a project's own convention is what the agent
    // is told to follow. Consumed by FeatureBranchGuardRule.onMainMessage.
    branchNamingConvention?: string;
    // Tunes the DETACHED refresher's stale-lock reclaim window (main-sync.lock.json). One value for one
    // refresher writing one cache — which is what it always physically was.
    hangTimeoutMinutes?: number;

    static readonly SCHEMA: SchemaShape<BranchStateGuardConfig> = {
        mode: new FieldDef('string', ON_OFF_MODES),
        branchNamingConvention: FieldDef.optional('string'),
        hangTimeoutMinutes: FieldDef.optional('number'),
        ...BASE_RULE_SCHEMA,
    };
}
