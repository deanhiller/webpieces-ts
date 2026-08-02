// The "commands" section of webpieces.config.json. It configures the gated command endpoints that
// the bash guards point agents toward (instead of running raw `gh pr create` / finishing a merge by
// hand), plus the pr-gate build dashboard. pr-gate lives here (not at the top level) because it
// configures the wp-start-upsert-pr / wp-finish-upsert-pr commands — the guards only POINT at them.
//
// Data-only (per CLAUDE.md, classes for data). Built + validated by loadAndValidate (load-config.ts).

import { PrGateConfig, buildPrGateConfig } from './pr-gate-config';

// Canonical gated commands. Guards default their command hints to these so a project that renames a
// command edits it in ONE place (the commands section) and every guard message follows.
export const DEFAULT_UPSERT_PR_COMMAND = 'pnpm wp-start-upsert-pr';
export const DEFAULT_MERGE_COMPLETE_COMMAND = 'pnpm wp-finish-upsert-pr';

export class CommandsConfig {
    prGate: PrGateConfig;
    // Command the pr-creation-or-push-guard tells agents to run instead of `gh pr create` or a manual push.
    // Sourced from commands.guardHints.prCreationOrPush.
    upsertPr: string;
    // Command the merge-in-progress-guard tells agents to run to finish a 3-point merge.
    // Sourced from commands.guardHints.mergeInProgress.
    mergeComplete: string;

    constructor(prGate: PrGateConfig, upsertPr: string, mergeComplete: string) {
        this.prGate = prGate;
        this.upsertPr = upsertPr;
        this.mergeComplete = mergeComplete;
    }
}

// The `commands.guardHints` sub-object: the ONLY command strings the guards read (each maps to exactly
// one guard). Grouped under `guardHints` so the file makes plain these are guard hints — not pr-gate
// config, and not command behaviour. `prCreationOrPush` → pr-creation-or-push-guard;
// `mergeInProgress` → merge-in-progress-guard.
interface RawGuardHints {
    prCreationOrPush?: string;
    mergeInProgress?: string;
}

interface RawCommandsSection {
    // webpieces-disable no-any-unknown -- opaque pr-gate JSON, validated by validatePrGateSection
    'pr-gate'?: unknown;
    guardHints?: RawGuardHints;
}

/**
 * Build a CommandsConfig from the already-parsed `commands` section, falling back to the built-in default
 * for any field the consumer omits. Pure transform — the structural validation happens in loadAndValidate.
 *
 * ONE accepted source per field: commands.guardHints.<name>, else the built-in default. The retired flat
 * `commands.upsertPr` / `commands.mergeComplete` strings are NOT read — validateCommandsSection fails the
 * load with the move instruction instead. A resolution chain that quietly accepts the old key is exactly
 * what kept this repo's own config on the dead shape for releases; see retired-config-keys.ts.
 */
// webpieces-disable no-any-unknown -- `section` is opaque consumer JSON until narrowed here
// webpieces-disable no-function-outside-class -- module-level config transform, matches buildPrGateConfig in pr-gate-config.ts
export function buildCommandsConfig(section: unknown): CommandsConfig {
    const raw: RawCommandsSection = (typeof section === 'object' && section !== null)
        ? (section as RawCommandsSection)
        : {};
    const hints: RawGuardHints = (typeof raw.guardHints === 'object' && raw.guardHints !== null)
        ? raw.guardHints
        : {};
    const upsertPr = typeof hints.prCreationOrPush === 'string' && hints.prCreationOrPush.trim() !== ''
        ? hints.prCreationOrPush
        : DEFAULT_UPSERT_PR_COMMAND;
    const mergeComplete = typeof hints.mergeInProgress === 'string' && hints.mergeInProgress.trim() !== ''
        ? hints.mergeInProgress
        : DEFAULT_MERGE_COMPLETE_COMMAND;
    return new CommandsConfig(buildPrGateConfig(raw['pr-gate']), upsertPr, mergeComplete);
}
