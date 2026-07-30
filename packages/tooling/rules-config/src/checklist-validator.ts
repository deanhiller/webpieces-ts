import * as fs from 'fs';
import * as path from 'path';
import { ChecklistDefinition } from './checklist-config';

// Where a reviewer subagent's definition must live for Claude Code to be able to spawn it.
const AGENTS_DIR = path.join('.claude', 'agents');

// Every checklist error names this, so a reader always knows which file and key to open. There is exactly
// ONE place checklists can be configured, so there is exactly one label.
const SOURCE = 'pr-gate.checklists in webpieces.config.json';

/**
 * Validates the review checklists declared in `pr-gate.checklists`. The array in webpieces.config.json is
 * the ONLY accepted shape: there is deliberately no fallback, no second location, and no back-compat path
 * for the `{ doc }` + `<!-- webpieces:checklists -->` HTML-comment manifest this replaced. A consumer on the
 * old shape gets a hard config error naming the exact edit — which an AI applies in one pass — and that is
 * strictly better than carrying two code paths forever so that nobody has to read an error message.
 *
 * Deliberately NOT `@injectable`: config validation runs from module-level functions in validate-config.ts,
 * before any container exists, so this is constructed directly. It previously carried an @injectable
 * decorator plus a comment claiming it was "injected by type and drawn in the DI design" — while nothing
 * injected it and it appeared nowhere in design.json. A false claim the next reader would have trusted.
 */
export class ChecklistValidator {
    /**
     * Human-readable errors for the configured checklists, or [] when they are valid. Never throws.
     * `defs` are already narrowed by buildPrGateConfig; this checks what only the filesystem can answer.
     */
    validate(repoRoot: string, defs: readonly ChecklistDefinition[]): string[] {
        const errors: string[] = [];
        const seen = new Set<string>();
        // Only enforce the reviewer-agent file when this repo HAS an agents dir — a non-Claude-Code consumer
        // that drives the gate some other way must not be broken by a check for a directory it never has.
        const agentsDir = path.join(repoRoot, AGENTS_DIR);
        const checkAgents = fs.existsSync(agentsDir);
        defs.forEach((def: ChecklistDefinition, i: number): void => {
            const label = def.subagent !== '' ? `"${def.subagent}"` : `checklists[${i}]`;
            errors.push(...this.validateSubagent(def, i, seen, checkAgents, agentsDir));
            if (def.doc !== '' && !fs.existsSync(path.join(repoRoot, def.doc))) {
                errors.push(`[pr-gate] ${SOURCE} ${label}.doc "${def.doc}" does not exist (paths are REPO-relative).`);
            }
        });
        return errors;
    }

    // `subagent` is the ONE required field and the whole distinct-reviewer guarantee rests on it.
    // eslint-disable-next-line @typescript-eslint/max-params
    private validateSubagent(def: ChecklistDefinition, i: number, seen: Set<string>, checkAgents: boolean, agentsDir: string): string[] {
        const label = def.subagent !== '' ? `"${def.subagent}"` : `checklists[${i}]`;
        if (def.subagent.trim() === '') {
            return [`[pr-gate] ${SOURCE} checklists[${i}].subagent must be a non-empty string (the reviewer agent name, matching ${AGENTS_DIR}/<subagent>.md).`];
        }
        if (seen.has(def.subagent)) {
            return [`[pr-gate] ${SOURCE} duplicate subagent "${def.subagent}" — each checklist must use a DISTINCT reviewer subagent (that is how independent review is enforced).`];
        }
        seen.add(def.subagent);
        return this.validateSubagentExists(def.subagent, label, checkAgents, agentsDir);
    }

    /**
     * The check this validator once lacked: nothing confirmed `subagent` named a real agent. A typo used to
     * validate clean, then get printed to the coding agent as "spawn this" — and since wp-finish blocks on
     * `review-<that-typo>.json`, the path of least resistance became writing the reviewer's verdict itself,
     * which is the exact self-certification the distinct-subagent rule exists to prevent. Reject at load.
     */
    private validateSubagentExists(subagent: string, label: string, checkAgents: boolean, agentsDir: string): string[] {
        if (!checkAgents) return [];
        if (fs.existsSync(path.join(agentsDir, `${subagent}.md`))) return [];
        return [
            `[pr-gate] ${SOURCE} ${label}.subagent names no reviewer — ${AGENTS_DIR}/${subagent}.md does not exist, ` +
            `so nothing can spawn it and wp-finish-upsert-pr would block forever on a review-${subagent}.json that no reviewer can write. ` +
            `Create that agent file or fix the name.`,
        ];
    }
}
