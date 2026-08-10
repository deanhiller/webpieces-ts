import { EffectiveTree, EffectiveTreeResolver } from './effective-tree';
import { BlockedResult } from './types';

/**
 * L1: the directory this command would run in DOES NOT EXIST.
 *
 * THE INCIDENT (reproduced from a transcript, 0.4.603). A subagent was launched with its cwd inside
 * `<root>/.claude/worktrees/agent-a5931637c5bff6d6d`. Mid-session another agent's cleanup REAPED that
 * worktree. The shell's cwd still named a path that was now gone.
 *
 * `classify()` asked git for the toplevel, got `null` — and `null` meant two completely different
 * things: "this is not a git directory" and "this directory does not exist". Conflating them classified
 * the dead path as the PRIMARY clone, so force-to-root fired and printed:
 *
 *     ❌ Run git/gh commands from the repo root, not a subdirectory.
 *        Command runs in: <root>/.claude/worktrees/agent-a5931637c5bff6d6d
 *        Judged against:  <root>
 *          cd '<root>' && cd <root>/.claude/worktrees/agent-… && git fetch …
 *
 * Three things wrong at once: the diagnosis (it is not a subdirectory, it is GONE), the tone (it reads
 * as a scolding for a mistake nobody made), and the remedy (it ends inside the deleted directory, so it
 * cannot satisfy the check — the retry re-fires with the prefix doubled, then tripled). Three rounds
 * were burned before `git worktree list` made the real state visible.
 *
 * So the fix is a DISTINCT tree kind with its own message. Naming the state is most of the cure: an
 * agent that is told the directory is gone stops trying to `cd` into it. The remedy deliberately routes
 * through the governed root and drops the command's own leading `cd`, so it can never point back at the
 * dead path — the same convergence property `remedyAtRoot` gives force-to-root.
 *
 * The lost-work line is not padding. A reaped worktree takes uncommitted changes with it, and an agent
 * that silently retries at the root will otherwise report success on work that no longer exists.
 */
export class MissingDirectoryGuard {
    private readonly resolver = new EffectiveTreeResolver();

    /** The deny report, or null to allow. */
    block(command: string, tree: EffectiveTree): string | null {
        if (tree.kind !== 'missing') return null;
        return this.report(command, tree);
    }

    // Short, on the L0 message diet: name the state, say what it costs, give ONE runnable line.
    private report(command: string, tree: EffectiveTree): string {
        return [
            `❌ The directory this command would run in no longer exists:`,
            `     ${tree.effectiveCwd}`,
            '   Most often it was a linked worktree that has since been reaped (`git worktree list` no',
            '   longer shows it). Nothing can run there, and any UNCOMMITTED work that was in it is gone.',
            '',
            `   Continue from ${tree.governedRoot} — this line does NOT route back through the dead path:`,
            `     ${this.resolver.remedyAtRoot(tree.governedRoot, command)}`,
        ].join('\n');
    }
}

// L1 row 7's dispatch entry. It lives HERE rather than beside its two siblings in runner.ts because
// the guard owns its own report and runner.ts is at its file-size cap — the runner needs only the row
// lookup and this one call.
// webpieces-disable no-function-outside-class -- the one-line runner entry point for the class above, beside it
export function missingDirectoryBlock(command: string, tree: EffectiveTree): BlockedResult | null {
    const report = new MissingDirectoryGuard().block(command, tree);
    return report === null ? null : new BlockedResult(report);
}
