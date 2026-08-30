import * as path from 'path';

import { Option, RuleFailError, renderRuleFailForAi } from '@webpieces/rules-config';

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
 * Reviewers are unaffected: they only read, and a read arrives as `Bash`.
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

    private isInside(filePath: string, root: string): boolean {
        const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
        return path.resolve(filePath).startsWith(rootWithSep);
    }
}
