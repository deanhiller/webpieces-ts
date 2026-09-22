import * as path from 'path';

import { Option, PR_REVIEW_DIR, RuleFailError, WEBPIECES_TMP_DIR, WRITE_REVIEW_BIN, renderRuleFailForAi } from '@webpieces/rules-config';

import { AgentHookEvent, FileOperation } from '../core/agent-event';
import { BlockedResult } from '../core/types';

export const CODEX_SUBAGENT_RULE = 'codex-subagent-no-write-in-shared-tree';

/**
 * A Codex SUBAGENT may not write into the tree it shares with its coordinator.
 *
 * This exists because of a MEASURED structural gap, not a style preference. Claude Code can hand a
 * subagent its own git worktree (`isolation: "worktree"`), so two agents editing at once are editing
 * two different checkouts. Codex cannot: `spawn_agent`'s schema is
 * `{fork_turns?, message, model?, reasoning_effort?, task_name}` — there is no cwd, workdir or
 * worktree parameter — and cwd resets to the repo root before every command, so a subagent cannot even
 * put itself somewhere else. Every Codex subagent therefore writes into the coordinator's checkout,
 * and concurrent subagents write into each other's.
 *
 * Reviewers WRITE too, and that is not a side detail: one verdict per checklist is a reviewer's whole
 * output. An earlier comment here said "reviewers are unaffected: they only read", and it was false —
 * this guard blocked a Codex reviewer's `review-<id>.json`, the coordinator then took this guard's own
 * "hand the edit back to the coordinator" option and wrote all five verdicts itself, and the gate
 * accepted them (issue #863). So a verdict is never a patch: every reviewer SUBMITS it through
 * `pnpm wp-write-review`, a Bash call this guard does not see, and a blocked write under
 * `.webpieces/pr-review/` names that bin — and NEVER offers the coordinator hand-back, because a
 * coordinator writing a reviewer's verdict is precisely the forgery the gate refuses.
 *
 * NOT a configurable rule yet, and that is deliberate. A rule registered with the engine must have an
 * entry in webpieces.config.json, and the validator that would accept a new key is a RELEASE behind
 * the source that defines it — adding both at once rejects the key as unknown and blocks every tool
 * call in the repo. So the guard ships here, gated on `aiType === 'codex'`, and becomes a config-keyed
 * rule in the follow-up PR that lands after the publish.
 */
export class CodexSubagentSharedTreeGuard {
    /**
     * Returns a block when a Codex SUBAGENT's patch targets a file inside `root`, else null.
     * Claude Code events return null unconditionally — the harness has real isolation.
     */
    check(event: AgentHookEvent, root: string): BlockedResult | null {
        if (event.aiType !== 'codex') return null;
        if (event.agentId === '') return null;
        const inside = event.files.filter((f: FileOperation): boolean => this.isInside(f.input.filePath, root));
        if (inside.length === 0) return null;
        const targets = inside.map((f: FileOperation): string => path.relative(root, f.input.filePath)).join(', ');
        if (inside.some((f: FileOperation): boolean => this.isReviewState(f.input.filePath, root))) {
            return new BlockedResult(renderRuleFailForAi(this.verdictWriteError(targets)));
        }
        const worktree = path.join(path.dirname(root), 'wt-<task-name>');
        const error = new RuleFailError(
            CODEX_SUBAGENT_RULE,
            `A Codex subagent is writing into the tree it shares with its coordinator: ${targets}\n\n` +
            `Codex cannot spawn a subagent into its own checkout — spawn_agent takes no cwd or worktree, ` +
            `and cwd resets to the repo root before every command — so this edit lands in the same files ` +
            `the coordinator and every sibling subagent are editing.`,
            undefined,
            undefined,
            [
                new Option(`Give this agent its own checkout and address every file by ABSOLUTE path inside it: git worktree add ${worktree} -b <branch>`, true),
                new Option('Hand the edit back to the coordinator and have this agent report what to change instead of changing it'),
            ],
        );
        return new BlockedResult(renderRuleFailForAi(error));
    }

    /**
     * A write under `.webpieces/pr-review/` — a verdict, or anything beside one. There is exactly one
     * route for it, and it is not a patch. No "hand it to the coordinator" option: the coordinator may
     * never write a reviewer's verdict, and `wp-finish-upsert-pr` rejects one that did not come through
     * the bin.
     */
    private verdictWriteError(targets: string): RuleFailError {
        return new RuleFailError(
            CODEX_SUBAGENT_RULE,
            `A Codex subagent is writing review state directly: ${targets}\n\n` +
            `A reviewer verdict is never written as a file. Submit it through ${WRITE_REVIEW_BIN}, which ` +
            `validates it and records who wrote it — a review-<id>.json written any other way is rejected ` +
            `by pnpm wp-finish-upsert-pr.`,
            undefined,
            undefined,
            [
                new Option(`Submit the verdict JSON on stdin: pnpm ${WRITE_REVIEW_BIN} --checklist <id> <<'EOF' … EOF (or --file <a path OUTSIDE this tree>)`, true),
            ],
        );
    }

    private isReviewState(filePath: string, root: string): boolean {
        const reviewDir = path.join(root, WEBPIECES_TMP_DIR, PR_REVIEW_DIR) + path.sep;
        return path.resolve(filePath).startsWith(reviewDir);
    }

    private isInside(filePath: string, root: string): boolean {
        const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
        return path.resolve(filePath).startsWith(rootWithSep);
    }
}
