import * as fs from 'fs';
import * as path from 'path';
import { injectable, bindingScopeValues } from 'inversify';
import { ChecklistDefinition, ChecklistSource, RawChecklistItem, toChecklist } from './checklist-config';
import { toError } from './to-error';

// The delimited JSON manifest embedded in the review doc — the LEGACY shape, kept working because it is
// shipped. An HTML comment so it does NOT render in the markdown a human reads, but is trivially +
// robustly parseable (JSON.parse — no YAML dependency, no hand-rolled frontmatter parser). Example, at the
// top of `.claude/review/index.md`:
//
//   <!-- webpieces:checklists
//   [ { "subagent": "morpheus-envvars-reviewer", "doc": "morpheus-envvars.md",
//       "patterns": ["**/.env*", "**/Dockerfile*"] } ]
//   -->
//
// New repos should put the SAME array directly in `pr-gate.checklists` in webpieces.config.json instead —
// see ChecklistSource. A JSON array inside an HTML comment is reachable only by this regex: no JSON Schema
// covers it, no editor completes it, no `jq` reads it.
const MANIFEST_RE = /<!--\s*webpieces:checklists\s*([\s\S]*?)-->/;

// Where a reviewer subagent's definition must live for Claude Code to be able to spawn it.
const AGENTS_DIR = path.join('.claude', 'agents');

/**
 * Loads + validates a repo's review checklists from EITHER shape (see {@link ChecklistSource}): the
 * `pr-gate.checklists` array in webpieces.config.json (primary) or the `<!-- webpieces:checklists -->`
 * manifest embedded in the doc that `pr-gate.checklists.doc` points at (legacy).
 *
 * `@injectable(bindingScopeValues.Singleton)` so it is injected by type + drawn in the DI design.
 */
@injectable(bindingScopeValues.Singleton)
export class ChecklistManifestService {
    // Absolute path of the manifest doc under repoRoot.
    manifestDocPath(repoRoot: string, docRel: string): string {
        return path.join(repoRoot, docRel);
    }

    /**
     * The repo's checklists, or [] when there are none / the manifest doc is missing / malformed. Callers
     * that need to REPORT those problems use validate(); this one is the tolerant runtime read.
     */
    load(repoRoot: string, source: ChecklistSource): ChecklistDefinition[] {
        if (source.inline.length > 0) return this.usable(source.inline);
        if (source.doc.trim() === '') return [];
        const items = this.readItems(this.manifestDocPath(repoRoot, source.doc));
        if (items === null) return [];
        return this.usable(items.map((raw: RawChecklistItem): ChecklistDefinition => toChecklist(raw, path.posix.dirname(source.doc))));
    }

    // Human-readable errors for the repo's checklist config, or [] when valid. Never throws.
    validate(repoRoot: string, source: ChecklistSource): string[] {
        if (source.inline.length > 0) return this.validateResolved(source.inline, repoRoot, source.describe());
        if (source.doc.trim() === '') return [];
        const docRel = source.doc;
        const docPath = this.manifestDocPath(repoRoot, docRel);
        if (!fs.existsSync(docPath)) {
            return [`[pr-gate] checklists.doc "${docRel}" does not exist — it must be a markdown doc carrying a <!-- webpieces:checklists [...] --> manifest.`];
        }
        const raw = this.extractManifest(fs.readFileSync(docPath, 'utf8'));
        if (raw === '') {
            return [`[pr-gate] "${docRel}" has no <!-- webpieces:checklists [...] --> block. Add a JSON array of { subagent, doc?, patterns? } inside that HTML comment.`];
        }
        const parsed = this.parse(raw);
        if (parsed === null) {
            return [`[pr-gate] the <!-- webpieces:checklists --> block in "${docRel}" is not a valid JSON array.`];
        }
        return this.validateItems(parsed, repoRoot, docRel);
    }

    // Validate raw manifest entries (legacy shape): narrow each to a ChecklistDefinition with its doc
    // resolved against the manifest doc's directory, then run the SAME checks the array form gets.
    private validateItems(items: readonly RawChecklistItem[], repoRoot: string, docRel: string): string[] {
        const errors: string[] = [];
        const docBase = path.posix.dirname(docRel);
        items.forEach((item: RawChecklistItem, i: number): void => {
            const label = typeof item.subagent === 'string' && item.subagent !== '' ? `"${item.subagent}"` : `checklists[${i}]`;
            if (item.patterns !== undefined && !this.isStringArray(item.patterns)) {
                errors.push(`[pr-gate] ${docRel} ${label}.patterns must be a string[] of path globs (omit or [] to run on every PR).`);
            }
        });
        const defs = items.map((item: RawChecklistItem): ChecklistDefinition => toChecklist(item, docBase));
        return [...errors, ...this.validateResolved(defs, repoRoot, docRel)];
    }

    /**
     * The checks that are the SAME for both config shapes, run against already-narrowed definitions:
     * subagent present + distinct + actually resolves to a spawnable agent, and the guidance doc exists.
     */
    private validateResolved(defs: readonly ChecklistDefinition[], repoRoot: string, sourceLabel: string): string[] {
        const errors: string[] = [];
        const seen = new Set<string>();
        // Only enforce the reviewer-agent file when this repo HAS an agents dir — a non-Claude-Code consumer
        // that drives the gate some other way must not be broken by a check for a directory it never has.
        const agentsDir = path.join(repoRoot, AGENTS_DIR);
        const checkAgents = fs.existsSync(agentsDir);
        defs.forEach((def: ChecklistDefinition, i: number): void => {
            const label = def.subagent !== '' ? `"${def.subagent}"` : `checklists[${i}]`;
            if (def.subagent.trim() === '') {
                errors.push(`[pr-gate] ${sourceLabel} checklists[${i}].subagent must be a non-empty string (the reviewer agent name, matching .claude/agents/<subagent>.md).`);
            } else if (seen.has(def.subagent)) {
                errors.push(`[pr-gate] ${sourceLabel} duplicate subagent "${def.subagent}" — each checklist must use a DISTINCT reviewer subagent (that is how independent review is enforced).`);
            } else {
                seen.add(def.subagent);
                errors.push(...this.validateSubagentExists(def.subagent, label, checkAgents, agentsDir, sourceLabel));
            }
            if (def.doc !== '' && !fs.existsSync(path.join(repoRoot, def.doc))) {
                errors.push(`[pr-gate] ${sourceLabel} ${label}.doc "${def.doc}" does not exist (resolved repo-relative).`);
            }
        });
        return errors;
    }

    /**
     * The check this validator was missing: `subagent` is the ONE required field and the whole
     * distinct-reviewer guarantee rests on it, yet nothing confirmed it names a real agent. A typo used to
     * validate clean, then get printed to the coding agent as "spawn this" — and since wp-finish blocks on
     * `review-<that-typo>.json`, the path of least resistance became writing the reviewer's verdict itself,
     * which is the exact self-certification the distinct-subagent rule exists to prevent. Reject at load.
     */
    // eslint-disable-next-line @typescript-eslint/max-params
    private validateSubagentExists(subagent: string, label: string, checkAgents: boolean, agentsDir: string, sourceLabel: string): string[] {
        if (!checkAgents) return [];
        if (fs.existsSync(path.join(agentsDir, `${subagent}.md`))) return [];
        return [
            `[pr-gate] ${sourceLabel} ${label}.subagent names no reviewer — ${AGENTS_DIR}/${subagent}.md does not exist, ` +
            `so nothing can spawn it and wp-finish-upsert-pr would block forever on a review-${subagent}.json that no reviewer can write. ` +
            `Create that agent file or fix the name.`,
        ];
    }

    // Drop entries with no subagent — they have no id, so they can key neither review-<id>.json nor a
    // dashboard row. validate() reports them; the tolerant load() just skips them.
    private usable(defs: readonly ChecklistDefinition[]): ChecklistDefinition[] {
        return defs.filter((d: ChecklistDefinition): boolean => d.subagent !== '');
    }

    // Read the manifest doc and return its parsed items, or null on any problem (missing/no block/bad JSON).
    private readItems(docPath: string): RawChecklistItem[] | null {
        if (!fs.existsSync(docPath)) return null;
        const raw = this.extractManifest(fs.readFileSync(docPath, 'utf8'));
        if (raw === '') return null;
        return this.parse(raw);
    }

    private extractManifest(content: string): string {
        const m = MANIFEST_RE.exec(content);
        return m ? m[1].trim() : '';
    }

    // webpieces-disable no-any-unknown -- opaque parsed JSON, narrowed to an item array by the caller
    private parse(json: string): RawChecklistItem[] | null {
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: a malformed manifest is reported as one error / ignored
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            // webpieces-disable no-any-unknown -- parsed JSON is opaque until narrowed below
            const value = JSON.parse(json) as unknown;
            if (!Array.isArray(value)) return null;
            // webpieces-disable no-any-unknown -- each opaque entry is narrowed field-by-field downstream
            return value as RawChecklistItem[];
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return null;
        }
    }

    // webpieces-disable no-any-unknown -- opaque parsed JSON value, narrowed to string[] here
    private isStringArray(value: unknown): boolean {
        return Array.isArray(value) && value.every((v: unknown): boolean => typeof v === 'string');
    }
}
