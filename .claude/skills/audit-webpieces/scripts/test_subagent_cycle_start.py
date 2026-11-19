"""Guards where a cycle-time cycle OPENS for a `/full-cycle` subagent (issue #1435).

A worktree subagent never runs `git checkout -b`: the Claude Code harness creates its branch
(`worktree-agent-<id>`, isolation:"worktree"). Without a synthetic start its "1 branch->start"
phase was missing. The audit now opens the cycle at the subagent transcript's first timestamp,
joined with `agent-<id>.meta.json` (`worktreePath` / `worktreeBranch`). A main-agent session still
opens on its own `git checkout -b`.

Synthetic fixtures only, in a temp dir standing in for <config root>/projects — never real transcripts.
"""
import importlib.util
import json
import os
import sys
import tempfile
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('wp', os.path.join(HERE, 'wp_audit.py'))
wp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wp)

T0 = datetime(2026, 11, 18, 10, 0, 0, tzinfo=timezone.utc)


def iso(minutes):
    return (T0 + timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def bash(minutes, cmd, uid):
    return [
        {"type": "assistant", "timestamp": iso(minutes),
         "message": {"content": [{"type": "tool_use", "id": uid, "name": "Bash",
                                  "input": {"command": cmd}}]}},
        {"type": "user", "timestamp": iso(minutes + 0.5),
         "message": {"content": [{"type": "tool_result", "tool_use_id": uid, "content": "ok"}]}},
    ]


def transcript(first_minute, calls):
    rows = [{"type": "user", "timestamp": iso(first_minute), "message": {"content": "do the task"}}]
    for i, (m, cmd) in enumerate(calls):
        rows += bash(m, cmd, "t%d" % i)
    return "\n".join(json.dumps(r) for r in rows) + "\n"


def run(projects, repo):
    """Exactly the two loops `scan_transcripts` runs, with the cycle-time accumulator on."""
    wp.CONFIG_ROOTS = [projects.parent]
    since = T0 - timedelta(hours=1)
    ct = wp.ct_new()
    for d in wp.transcript_dirs_for(repo):
        for f in d.glob("*.jsonl"):
            wp._scan_session(repo, d, f, since, Counter(), Counter(), None, ct)
    for _sid, agent_id, meta, path in wp.subagent_files_for(repo, since):
        agent = {"agent_id": agent_id, "is_reviewer": wp.is_reviewer(meta.get("agentType")),
                 "worktree": meta.get("worktreePath"),
                 "worktree_branch": meta.get("worktreeBranch")}
        wp._scan_session(repo, path.parent, path, since, Counter(), Counter(), None, ct,
                         agent=agent)
    return ct


def main():
    failures = 0

    def check(name, got, want):
        nonlocal failures
        if got != want:
            failures += 1
            print("FAIL %s: got %r want %r" % (name, got, want))
        else:
            print("ok   %s" % name)

    with tempfile.TemporaryDirectory() as tmp:
        projects = Path(tmp) / "projects"
        repo = Path("/fake/repo-ct")
        pdir = projects / wp.sanitized(repo)
        sub_dir = pdir / "parent-session" / wp.SUBAGENT_DIR
        sub_dir.mkdir(parents=True)

        # Main agent: opens on its own checkout -b at minute 0, lands at minute 50.
        (pdir / "parent-session.jsonl").write_text(transcript(-5, [
            (0, "git checkout -b feature/1/x origin/main"),
            (10, "pnpm wp-start-upsert-pr"),
            (20, "pnpm wp-review-upsert-pr"),
            (30, "pnpm wp-finish-upsert-pr"),
            (50, "pnpm wp-land-pr"),
        ]))
        # Worktree subagent spawned at minute 100: no checkout -b at all.
        (sub_dir / "agent-aaa.jsonl").write_text(transcript(100, [
            (115, "pnpm wp-start-upsert-pr"),
            (125, "pnpm wp-review-upsert-pr"),
            (135, "pnpm wp-finish-upsert-pr"),
            (150, "pnpm wp-land-pr"),
        ]))
        (sub_dir / "agent-aaa.meta.json").write_text(json.dumps({
            "agentType": "general-purpose", "worktreePath": "/fake/repo-ct/.claude/worktrees/agent-aaa",
            "worktreeBranch": "worktree-agent-aaa"}))
        # Worktree subagent spawned at minute 200 that renames its branch at 203: still phase 1
        # from minute 200, not from the rename.
        (sub_dir / "agent-bbb.jsonl").write_text(transcript(200, [
            (203, "git checkout -b feature/2/y origin/main"),
            (210, "pnpm wp-start-upsert-pr"),
            (220, "pnpm wp-land-pr"),
        ]))
        (sub_dir / "agent-bbb.meta.json").write_text(json.dumps({
            "agentType": "general-purpose", "worktreePath": "/fake/repo-ct/.claude/worktrees/agent-bbb",
            "worktreeBranch": "worktree-agent-bbb"}))
        # Non-worktree subagent (no worktreePath): unchanged — no synthetic start.
        (sub_dir / "agent-ccc.jsonl").write_text(transcript(300, [
            (310, "pnpm wp-start-upsert-pr"),
            (320, "pnpm wp-land-pr"),
        ]))
        (sub_dir / "agent-ccc.meta.json").write_text(json.dumps({"agentType": "Explore"}))

        ct = run(projects, repo)
        cycles = sorted(wp.ct_cycles(ct), key=lambda c: c["stages"].get("land", 0))
        t = lambda m: (T0 + timedelta(minutes=m)).timestamp()  # noqa: E731

        check("4 cycles", len(cycles), 4)
        main_c, aaa, bbb, ccc = cycles
        check("main agent opens on checkout -b", main_c["stages"].get("branch"), t(0))
        check("subagent opens at its first row", aaa["stages"].get("branch"), t(100))
        check("subagent phase 1 present", aaa["stages"].get("start"), t(115))
        check("subagent landed", aaa["landed"], True)
        check("rename inside phase 1 keeps spawn start", bbb["stages"].get("branch"), t(200))
        check("non-worktree subagent unchanged", "branch" in ccc["stages"], False)

        marks = ct["markers"][str(repo)]
        spawn = [m for m in marks if m.get("source") == "subagent-spawn"]
        check("spawn marks name the harness branch",
              sorted(m["branch"] for m in spawn), ["worktree-agent-aaa", "worktree-agent-bbb"])

    # Reviewers and main sessions pass through the helper untouched.
    marks = [{"ts": 1.0, "stage": "start", "session": "s"}]
    check("reviewer untouched", wp.ct_subagent_branch_marks(
        {"is_reviewer": True, "worktree": "/w"}, T0, "s", marks), marks)
    check("main session untouched", wp.ct_subagent_branch_marks(None, T0, "s", marks), marks)

    if failures:
        print("%d failure(s)" % failures)
        sys.exit(1)
    print("all ok")


if __name__ == "__main__":
    main()
