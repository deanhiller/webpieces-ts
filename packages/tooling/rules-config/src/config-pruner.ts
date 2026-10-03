import { RetiredConfigKey } from '@webpieces/rules-sdk';
import * as fs from 'fs';
import { injectable, bindingScopeValues } from 'inversify';

import { AtomicFile } from '@webpieces/tooling-common';
import { ConfigFile } from './config-file';
import { PRUNE_UNKNOWN_COMMAND } from './constants';
import * as path from 'node:path';
import { RulePackRegistry } from './rule-pack-registry';
import { PackPolicyFiles, SelectedPolicyPack } from './pack-policy-files';
import { RETIRED_SCOPE_RULE } from './retired-config-keys';
import { validateTopLevelKeys } from './config-key-rules';
import { InformAiError } from '@webpieces/tooling-common';

/** Prune only owner-file entries that no selected schema reads, retaining renames and wrong-owner entries for explicit repair. */
/** One key this run removed, and the reason it was safe to remove. Data-only (per CLAUDE.md). */
export class PrunedKey {
    /** The declared owner config path containing the key. */
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
        const lines = this.removed.map(
            (r: PrunedKey): string => `  • ${r.section}.${r.key} — ${r.reason}`,
        );
        return (
            `[${PRUNE_UNKNOWN_COMMAND}] Removed ${this.removed.length} unknown key(s) from ` +
            `${this.configPath}:\n${lines.join('\n')}`
        );
    }
}

@injectable(bindingScopeValues.Singleton)
export class ConfigPruner {
    constructor(
        private readonly configFile: ConfigFile,
        private readonly atomicFile: AtomicFile,
        private readonly files: PackPolicyFiles,
    ) {}

    /**
     * Strip every unknown key from the webpieces.config.json above `cwd` and rewrite it. Throws when no
     * config file is found — a prune with no target is a mistake, not a no-op.
     */
    pruneFrom(cwd: string): PruneResult {
        const configPath = this.configFile.findConfigFile(cwd);
        if (configPath === null) {
            throw new Error(
                `[${PRUNE_UNKNOWN_COMMAND}] No webpieces.config.json found above ${cwd}.`,
            );
        }
        return this.prune(configPath);
    }

    /**
     * Strip every unknown key from `configPath` and rewrite it in place. Reads the file directly rather
     * than through the loader: the loader VALIDATES, and this command's whole purpose is to run on a
     * file that fails validation.
     */
    prune(configPath: string): PruneResult {
        const root = path.dirname(configPath),
            document = this.configFile.readRawConfig(configPath);
        // webpieces-disable no-any-unknown -- pruning may inspect invalid policy values, but never accepts a retired root selection surface
        const rootErrors = validateTopLevelKeys(document as Record<string, unknown>);
        if (rootErrors.length) throw new InformAiError(rootErrors.join('\n'));
        const selected = this.files.select(root, this.files.declarations(document.rulePacks, root));
        const registry = new RulePackRegistry(
            selected.map((pack: SelectedPolicyPack) => pack.manifest),
        );
        const removed: PrunedKey[] = [];
        for (const pack of selected) {
            const filename = this.files.configPath(root, pack.declaration.config);
            const text = fs.readFileSync(filename, 'utf8'),
                entries = this.files.read(filename);
            const pruned: PrunedKey[] = [];
            for (const key of Object.keys(entries)) {
                const reason = this.reasonToRemove(key, registry);
                if (reason === null) continue;
                delete entries[key];
                pruned.push(new PrunedKey(pack.declaration.config, key, reason));
            }
            if (pruned.length)
                this.atomicFile.writeAtomic(
                    filename,
                    JSON.stringify(entries, null, this.indentOf(text)) + '\n',
                );
            removed.push(...pruned);
        }
        return new PruneResult(configPath, removed);
    }

    /** Why `key` is safe to delete, or null when it must be kept. */
    private reasonToRemove(key: string, registry: RulePackRegistry): string | null {
        if (registry.hasRule(key)) return null;
        const retired = registry
            .migrations()
            .find((e: RetiredConfigKey) => e.scope === RETIRED_SCOPE_RULE && e.key === key);
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
