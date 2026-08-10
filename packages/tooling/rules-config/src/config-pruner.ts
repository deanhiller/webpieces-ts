import * as fs from 'fs';
import { injectable, bindingScopeValues } from 'inversify';

import { AtomicFile } from './atomic-file';
import { ConfigFile } from './config-file';
import { PRUNE_UNKNOWN_COMMAND } from './constants';
import { RULE_SCHEMAS } from './rule-schemas';
import { RETIRED_CONFIG_KEYS, RETIRED_SCOPE_RULE } from './retired-config-keys';

/**
 * `wp-prune-unknown-config` — the MECHANICAL cure for "[x] Unknown rule".
 *
 * ## Why a command and not just advice
 *
 * An unknown key controls nothing, so deleting it is the fix, and the validator now says so. But the
 * moment that advice is read is the worst possible moment to act on it by hand: the hook guard denies
 * every Bash call while the config is invalid, so the reader is editing JSON blind, with no way to
 * re-run the validator between edits. Making the cleanup one command means cleanliness is the default
 * path rather than a judgement call taken under a total block — and it makes "the file validates" mean
 * "every key in it is real", which is the property that keeps dead config from reading as live config.
 *
 * ## What it removes, and what it deliberately does NOT
 *
 * Removed, from the `rules` and `hookGuards` sections only:
 *   - a name with no entry in RULE_SCHEMAS and no entry in RETIRED_CONFIG_KEYS (a typo, or a rule some
 *     release deleted). Nothing reads it, by construction.
 *   - a name in RETIRED_CONFIG_KEYS whose entry is `prunable` — the retirement's own instruction is
 *     "delete this entry", because the setting left webpieces.config.json entirely.
 *
 * NOT removed:
 *   - a RENAME or an in-file move (`prunable: false`). Deleting those discards a value the new key still
 *     needs, so they keep their migration instruction and a human/agent applies it.
 *   - anything at all when `rulesDir` is configured. A custom rule legitimately has no built-in schema,
 *     and this command must never eat one.
 *   - top-level keys, `commands`, `excludePaths`, `match-rules`. Those are validated by shape, not by a
 *     name table, so "unknown" is not defined for them and a pruner would be guessing.
 *
 * ## The one destructive case, and why the drift guard already covers it
 *
 * A key CAN be valid-but-unlearned when package.json pins an @webpieces older than the config. Pruning
 * then would delete live config. That case cannot reach here: the shim's version-drift guard compares
 * the pin against the installed version and denies every tool call — including this one — before the
 * validator or this command ever runs. It is also why `PruneResult` names every key it removed rather
 * than reporting a count: a silent sweep is the thing that would make the rare case unrecoverable.
 */

/** One key this run removed, and the reason it was safe to remove. Data-only (per CLAUDE.md). */
export class PrunedKey {
    /** `rules` or `hookGuards` — the section the key sat in. */
    section: string;
    /** The rule/guard name exactly as it appeared in the file. */
    key: string;
    /** Human-readable justification, printed per key so no removal is silent. */
    reason: string;

    constructor(section: string, key: string, reason: string) {
        this.section = section;
        this.key = key;
        this.reason = reason;
    }
}

/** The outcome of one prune. Data-only. */
export class PruneResult {
    /** The webpieces.config.json that was inspected. */
    configPath: string;
    removed: PrunedKey[];

    constructor(configPath: string, removed: PrunedKey[]) {
        this.configPath = configPath;
        this.removed = removed;
    }

    /** True when the file was rewritten. */
    changed(): boolean {
        return this.removed.length > 0;
    }

    /** The report the CLI prints. Every removed key is named; nothing is summarised away. */
    describeSelf(): string {
        if (!this.changed()) {
            return `[${PRUNE_UNKNOWN_COMMAND}] No unknown keys in ${this.configPath} — nothing to remove.`;
        }
        const lines = this.removed.map((r: PrunedKey): string => `  • ${r.section}.${r.key} — ${r.reason}`);
        return `[${PRUNE_UNKNOWN_COMMAND}] Removed ${this.removed.length} unknown key(s) from ` +
            `${this.configPath}:\n${lines.join('\n')}`;
    }
}

/** The sections a rule/guard name may legally sit in — the only two this command touches. */
const PRUNABLE_SECTIONS: readonly string[] = ['rules', 'hookGuards'];

@injectable(bindingScopeValues.Singleton)
export class ConfigPruner {
    constructor(
        private readonly configFile: ConfigFile,
        private readonly atomicFile: AtomicFile,
    ) {}

    /**
     * Strip every unknown key from the webpieces.config.json above `cwd` and rewrite it. Throws when no
     * config file is found — a prune with no target is a mistake, not a no-op.
     */
    pruneFrom(cwd: string): PruneResult {
        const configPath = this.configFile.findConfigFile(cwd);
        if (configPath === null) {
            throw new Error(`[${PRUNE_UNKNOWN_COMMAND}] No webpieces.config.json found above ${cwd}.`);
        }
        return this.prune(configPath);
    }

    /**
     * Strip every unknown key from `configPath` and rewrite it in place. Reads the file directly rather
     * than through the loader: the loader VALIDATES, and this command's whole purpose is to run on a
     * file that fails validation.
     */
    prune(configPath: string): PruneResult {
        const text = fs.readFileSync(configPath, 'utf8');
        // webpieces-disable no-any-unknown -- the raw config document is opaque JSON until narrowed below
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new Error(`[${PRUNE_UNKNOWN_COMMAND}] ${configPath} is not a JSON object.`);
        }
        // webpieces-disable no-any-unknown -- narrowed to a non-null, non-array object one line above
        const document = parsed as Record<string, unknown>;
        const removed = this.removeUnknown(document);
        if (removed.length > 0) {
            this.atomicFile.writeAtomic(configPath, JSON.stringify(document, null, this.indentOf(text)) + '\n');
        }
        return new PruneResult(configPath, removed);
    }

    /** Mutates `document`, deleting every prunable name from the two rule sections. */
    // webpieces-disable no-any-unknown -- opaque parsed config document
    private removeUnknown(document: Record<string, unknown>): PrunedKey[] {
        // A custom rules directory means a name with no built-in schema may be entirely legitimate.
        const rulesDir = document['rulesDir'];
        if (Array.isArray(rulesDir) && rulesDir.length > 0) return [];

        const removed: PrunedKey[] = [];
        for (const sectionName of PRUNABLE_SECTIONS) {
            const section = document[sectionName];
            if (typeof section !== 'object' || section === null || Array.isArray(section)) continue;
            // webpieces-disable no-any-unknown -- narrowed to a non-null, non-array object one line above
            const entries = section as Record<string, unknown>;
            for (const key of Object.keys(entries)) {
                const reason = this.reasonToRemove(key);
                if (reason === null) continue;
                delete entries[key];
                removed.push(new PrunedKey(sectionName, key, reason));
            }
        }
        return removed;
    }

    /** Why `key` is safe to delete, or null when it must be kept. */
    private reasonToRemove(key: string): string | null {
        if (RULE_SCHEMAS[key]) return null;
        const retired = RETIRED_CONFIG_KEYS.find(
            e => e.scope === RETIRED_SCOPE_RULE && e.key === key);
        if (retired) {
            if (!retired.prunable) return null;
            return retired.movedTo === ''
                ? 'RETIRED and removed with no replacement'
                : `RETIRED — the setting now lives at ${retired.movedTo}`;
        }
        return 'no running validator has a schema for it, so nothing reads it';
    }

    /**
     * The file's own indentation, so a prune does not reformat every line it did not touch. Falls back to
     * 4 (the shape every webpieces.config.json in the wild uses) when the document is single-line.
     */
    private indentOf(text: string): number {
        const match = /\n( +)"/.exec(text);
        if (match === null) return 4;
        return match[1].length;
    }
}
