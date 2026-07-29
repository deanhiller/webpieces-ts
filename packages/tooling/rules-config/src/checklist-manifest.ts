import * as fs from 'fs';
import * as path from 'path';
import { injectable, bindingScopeValues } from 'inversify';
import { ChecklistDefinition, RawChecklistItem, toChecklist } from './checklist-config';
import { toError } from './to-error';

// The delimited JSON manifest embedded in the review doc. An HTML comment so it does NOT render in the
// markdown a human reads, but is trivially + robustly parseable (JSON.parse — no YAML dependency, no
// hand-rolled frontmatter parser). Example, at the top of `.claude/review/index.md`:
//
//   <!-- webpieces:checklists
//   [ { "subagent": "morpheus-envvars-reviewer", "doc": "morpheus-envvars.md",
//       "patterns": ["**/.env*", "**/Dockerfile*"] } ]
//   -->
const MANIFEST_RE = /<!--\s*webpieces:checklists\s*([\s\S]*?)-->/;

/**
 * Loads + validates the checklist manifest embedded in the single doc `pr-gate.checklists.doc` points at.
 * The set of checklists lives in the DOC (content), not webpieces.config.json (config) — the config only
 * carries the doc path. `@injectable(bindingScopeValues.Singleton)` so it is injected by type + drawn in
 * the DI design.
 */
@injectable(bindingScopeValues.Singleton)
export class ChecklistManifestService {
    // Absolute path of the manifest doc under repoRoot.
    manifestDocPath(repoRoot: string, docRel: string): string {
        return path.join(repoRoot, docRel);
    }

    // The parsed checklists, or [] when the doc is missing / has no manifest block / is malformed. Callers
    // that need to REPORT those problems use validate(); this one is the tolerant runtime read.
    load(repoRoot: string, docRel: string): ChecklistDefinition[] {
        if (docRel.trim() === '') return [];
        const items = this.readItems(this.manifestDocPath(repoRoot, docRel));
        return items === null ? [] : items.map(toChecklist).filter((d: ChecklistDefinition): boolean => d.subagent !== '');
    }

    // Human-readable errors for the manifest doc, or [] when it is valid. Never throws.
    validate(repoRoot: string, docRel: string): string[] {
        if (docRel.trim() === '') return [];
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

    private validateItems(items: readonly RawChecklistItem[], repoRoot: string, docRel: string): string[] {
        const errors: string[] = [];
        const seen = new Set<string>();
        const docDir = path.dirname(this.manifestDocPath(repoRoot, docRel));
        items.forEach((item: RawChecklistItem, i: number): void => {
            const label = typeof item.subagent === 'string' && item.subagent !== '' ? `"${item.subagent}"` : `checklists[${i}]`;
            if (typeof item.subagent !== 'string' || item.subagent.trim() === '') {
                errors.push(`[pr-gate] ${docRel} checklists[${i}].subagent must be a non-empty string (the reviewer agent name, matching .claude/agents/<subagent>.md).`);
            } else if (seen.has(item.subagent)) {
                errors.push(`[pr-gate] ${docRel} duplicate subagent "${item.subagent}" — each checklist must use a DISTINCT reviewer subagent (that is how independent review is enforced).`);
            } else {
                seen.add(item.subagent);
            }
            if (item.doc !== undefined && item.doc !== '' && !fs.existsSync(path.join(docDir, item.doc))) {
                errors.push(`[pr-gate] ${docRel} ${label}.doc "${item.doc}" does not exist (resolved relative to the manifest doc).`);
            }
            if (item.patterns !== undefined && !this.isStringArray(item.patterns)) {
                errors.push(`[pr-gate] ${docRel} ${label}.patterns must be a string[] of path globs (omit or [] to run on every PR).`);
            }
        });
        return errors;
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
