import * as fs from 'fs';
import * as path from 'path';
import { ChecklistDefinition, DEFAULT_REVIEWER_AGENT_NAME, ReviewerAgentPolicy } from './checklist-config';
import { UPGRADE_SHIM_COMMAND } from './constants';

// Where a reviewer subagent's definition must live for Claude Code to be able to spawn it.
const AGENTS_DIR = path.join('.claude', 'agents');

// Every checklist error names this, so a reader always knows which file and key to open. There is exactly
// ONE place checklists can be configured, so there is exactly one label.
const SOURCE = 'pr-gate.checklists in webpieces.config.json';

// A checklist id becomes a FILE NAME (review-<id>.json, <id>.instructions.md), so it is held to a
// file-name-safe alphabet rather than trusted to not contain a slash.
const CHECKLIST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Validates the review checklists declared in `pr-gate.checklists`. The array in webpieces.config.json is
 * the ONLY accepted shape: there is deliberately no fallback, no second location, and no back-compat path
 * for the `{ doc }` + `<!-- webpieces:checklists -->` HTML-comment manifest this replaced. A consumer on the
 * old shape gets a hard config error naming the exact edit — which an AI applies in one pass — and that is
 * strictly better than carrying two code paths forever so that nobody has to read an error message.
 *
 * Deliberately NOT `@injectable`: config validation runs from module-level functions in validate-config.ts,
 * before any container exists, so this is constructed directly.
 */
export class ChecklistValidator {
    /**
     * Human-readable errors for the configured checklists, or [] when they are valid. Never throws.
     * `defs` are already narrowed by buildPrGateConfig; this checks ids plus what only the filesystem can
     * answer (each doc exists — skipped when `repoRoot` is undefined, i.e. a structure-only validation).
     */
    validate(repoRoot: string | undefined, defs: readonly ChecklistDefinition[]): string[] {
        const errors: string[] = [];
        const seen = new Set<string>();
        defs.forEach((def: ChecklistDefinition, i: number): void => {
            errors.push(...this.validateId(def, i, seen));
            const label = def.id !== '' ? `"${def.id}"` : `checklists[${i}]`;
            if (def.doc === '') {
                errors.push(
                    `[pr-gate] ${SOURCE} ${label}.doc is required — the REPO-relative guidance doc the reviewer ` +
                    `reviews against (e.g. ".claude/review/${def.id !== '' ? def.id : 'my-checklist'}.md"). The reviewer ` +
                    `agent is generic, so the doc IS the checklist.`);
            } else if (repoRoot !== undefined && !fs.existsSync(path.join(repoRoot, def.doc))) {
                errors.push(`[pr-gate] ${SOURCE} ${label}.doc "${def.doc}" does not exist (paths are REPO-relative).`);
            }
        });
        return errors;
    }

    /**
     * The reviewer agent file — `webpieces-reviewer`, or `commands.pr-gate.reviewerAgentName` under
     * `"overrideReviewerAgent": true` — checked ONCE for the repo.
     *
     * Only enforced when this repo HAS a `.claude/agents` dir — a non-Claude-Code consumer that drives the
     * gate some other way must not be broken by a check for a directory it never has. Without it a typo
     * validates clean, gets printed to the coding agent as "spawn this", and the path of least resistance
     * becomes writing the verdicts itself — the self-certification the gate exists to prevent.
     */
    validateReviewerAgent(repoRoot: string, reviewer: ReviewerAgentPolicy): string[] {
        const agentsDir = path.join(repoRoot, AGENTS_DIR);
        if (reviewer.agentName === '' || !fs.existsSync(agentsDir)) return [];
        if (fs.existsSync(path.join(agentsDir, `${reviewer.agentName}.md`))) return [];
        const isDefault = reviewer.agentName === DEFAULT_REVIEWER_AGENT_NAME;
        const cure = isDefault
            ? `Run \`${UPGRADE_SHIM_COMMAND}\` — it writes that webpieces-owned file.`
            : 'Create that agent file, or set "reviewerAgentName" to an agent that exists, or delete both ' +
              '"overrideReviewerAgent" and "reviewerAgentName" to use the webpieces reviewer.';
        const source = isDefault
            ? 'the webpieces reviewer agent'
            : 'commands.pr-gate.reviewerAgentName';
        return [
            `[pr-gate] ${source} "${reviewer.agentName}" names no reviewer — ` +
            `${AGENTS_DIR}/${reviewer.agentName}.md does not exist, so nothing can spawn it and wp-finish-upsert-pr ` +
            `would block forever on verdicts no reviewer can write. ${cure}`,
        ];
    }

    // `id` keys every per-checklist file and the dashboard row, so it must be present, unique and file-safe.
    private validateId(def: ChecklistDefinition, i: number, seen: Set<string>): string[] {
        if (def.id === '') {
            return [`[pr-gate] ${SOURCE} checklists[${i}].id must be a non-empty string — the checklist's name; it keys review-<id>.json.`];
        }
        if (!CHECKLIST_ID.test(def.id)) {
            return [`[pr-gate] ${SOURCE} checklists[${i}].id "${def.id}" must use only letters, digits, ".", "_" and "-" (it becomes a file name).`];
        }
        if (seen.has(def.id)) {
            return [`[pr-gate] ${SOURCE} duplicate id "${def.id}" — every checklist needs its own id, because each writes its own review-<id>.json.`];
        }
        seen.add(def.id);
        return [];
    }
}
