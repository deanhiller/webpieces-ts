# BUG: a worktree-isolated agent is auto-reaped when its turn ends, then resumed in the PRIMARY clone with isolation silently gone

**Layer:** Claude Code harness (NOT webpieces) — but it invalidates an assumption webpieces relies on.
**Severity:** **CRITICAL** for anything that writes. An agent under instructions scoped to a worktree
resumes with `cwd` = the **primary clone**, no error, no warning. Every write it then makes lands in the
main tree while the agent believes it is sandboxed.
**Observed:** 2026-08-10, Claude Code `2.1.224`, **reproduced twice, independently.**

---

## In one paragraph

> `isolation: "worktree"` is documented as "auto-cleaned **if unchanged**". A READ-ONLY agent is by
> definition unchanged, so its worktree is reaped the moment its turn ends. But the agent remains
> **resumable** — and on resume its working directory silently falls back to the primary clone. Isolation
> is not revoked, not errored, not announced. It simply stops being true, and the agent has no way to
> know unless it re-checks `pwd` every single cycle.

## Reproduction A — read-only probe, interrupted then resumed

Timeline from the agent's own transcript (local time; the JSONL stores UTC):

| time | event |
|---|---|
| 17:39:51 | starts; `pwd` → `<primary>/.claude/worktrees/agent-a658…` ✅ |
| 17:40:03 | `ls -d node_modules` → not found (correct for a worktree) |
| 17:40:07–10 | human input + an **esc interrupt**; turn ends |
| 17:40:13 | agent **resumes** |
| 17:40:23 | `ls -la <its worktree>/node_modules/…` → **No such file or directory** |
| 17:40:35 | `cd ../../../ && ls` → prints **`/Users/<user>`**, i.e. up-3 from the PRIMARY. From the worktree, up-3 would have listed the repo. **cwd is the primary.** |
| 17:41:31 | completes normally, never having been told anything changed |

Confirmed independently from the coordinator: `git worktree list` no longer contained
`agent-a658…`, and the branch `worktree-agent-a658…` did not exist either.

## Reproduction B — read-only mailbox agent, no interrupt at all

Launched with an explicit standing rule to re-verify `pwd` at the top of every cycle. It set up
correctly in `<primary>/.claude/worktrees/agent-ac82…`, armed a background waiter, and **ended its turn**.
On the next resume its own check fired:

```
ISOLATION LOST: expected <primary>/.claude/worktrees/agent-ac82d4bf12c3dd12f,
                now in    <primary>
```

It refused to run the queued mailbox command and stopped. **Nothing was executed against the wrong
tree — solely because the agent was told to distrust its launch directory.** A normal agent would have
run it in the primary clone.

**Reproduction B rules out the interrupt as the cause.** No esc was involved; an ordinary turn boundary
was enough.

## Mechanism

The Agent tool documents it plainly: *"`isolation: \"worktree\"` gives the agent its own git worktree
(auto-cleaned if unchanged)."*

Put together with resumability:

1. a **read-only** agent never changes its worktree, so it is *always* "unchanged";
2. the tree is auto-cleaned when the turn ends;
3. the agent is still resumable — by human input, or by a background-task notification;
4. on resume there is no worktree, and cwd falls back to the primary with no diagnostic.

So the hazard is **specific to read-only or not-yet-writing agents** — exactly the probe/reviewer/audit
shapes, which are the ones most likely to be pointed at a repo they must not modify.

## Mitigations (in order of reliability)

1. **Have the agent write something into its worktree immediately**, before anything else — a scratch
   file is enough. "Changed" defeats the auto-clean, so the tree survives turn boundaries.
2. **Re-check `pwd` at the top of every cycle** and hard-stop on mismatch. This is what saved
   reproduction B, and it is cheap. Never trust the launch directory to still be true.
3. **Prefer absolute paths** for anything outside the agent's own tree, so a silent cwd change cannot
   redirect a relative path into the primary.

## What this means for webpieces

`CoordinatorWorktreeGuard` exempts **every** subagent — `coordinator-worktree.ts`, `if (!agent.coordinator) return null` — on the reasoning that a subagent in a worktree is the correct pattern.
That exemption assumes "isolated agent ⇒ it is in its own tree". **That assumption was true at launch and
false three tool calls later**, twice, today.

It is not currently exploitable through this guard, for a narrow reason worth writing down: an agent that
has fallen back to the primary is *in* the primary, so `tree.kind` resolves to `primary` and the guard
correctly does not fire. The danger is not this guard mis-firing — it is any FUTURE rule that infers
"this agent is safely sandboxed" from its agent identity. **Do not add one.** Tree identity must always be
derived from the actual path being acted on, never from what kind of agent is asking. That is the same
conclusion reached independently in
[`bug-a-write-with-an-absolute-path-into-another-worktree-is-allowed-and-judged-against-the-wrong-tree`](./bug-a-write-with-an-absolute-path-into-another-worktree-is-allowed-and-judged-against-the-wrong-tree.md).

## Related

- [`bug-l1-prescribes-a-subagent-remedy-that-cannot-be-launched-and-would-not-fix-the-governance-split-anyway`](./bug-l1-prescribes-a-subagent-remedy-that-cannot-be-launched-and-would-not-fix-the-governance-split-anyway.md)
- [`bug-a-reaped-worktree-reads-as-a-subdirectory-and-l1-prescribes-a-cd-into-the-deleted-path.md`](./bug-a-reaped-worktree-reads-as-a-subdirectory-and-l1-prescribes-a-cd-into-the-deleted-path.md)
  — the webpieces-side symptom of a tree disappearing under a live shell; this file is the cause.
