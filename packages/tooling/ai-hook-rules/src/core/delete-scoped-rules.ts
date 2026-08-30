import { Rule, ToolKind } from './types';

/**
 * The rules that judge a FILE DELETION. Empty, deliberately, and changing that is a human's call.
 *
 * `Delete` is a new ToolKind, reachable only from Codex's `apply_patch` `*** Delete File:` directive —
 * Claude Code has no delete tool at all. Every rule in this engine was written against the bytes an
 * edit ADDS (an EditContext's `addedContent`), and a deletion has none, so running them on one would
 * either produce nothing or produce a verdict about content that is going away. Defaulting all of them
 * OFF keeps every existing rule's behaviour exactly what it was.
 *
 * Two families would arguably be RIGHT to fire here, and are listed rather than enabled because the
 * decision is a policy call, not a refactor: rules that keep a barrel/index in step with the files it
 * exports, and rules that keep a doc in step with the file it documents. Deleting a file is precisely
 * when those two go stale.
 */
const DELETE_SCOPED_RULES: ReadonlySet<string> = new Set([]);

export class DeleteScopedRules {
    /**
     * `rules` unchanged for every other ToolKind; for a Delete, narrowed to the rules that opted into
     * judging one — today, none of them, so a delete is always allowed.
     */
    narrow(toolKind: ToolKind, rules: readonly Rule[]): readonly Rule[] {
        if (toolKind !== 'Delete') return rules;
        return rules.filter((r: Rule): boolean => DELETE_SCOPED_RULES.has(r.name));
    }
}
