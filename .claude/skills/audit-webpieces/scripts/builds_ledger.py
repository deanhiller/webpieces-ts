#!/usr/bin/env python3
"""Mine ~/.webpieces/builds.log — the MACHINE-WIDE build ledger — for MAJOR issues only.

The ledger ships with @webpieces 0.4.687 (rules-config `BuildsLog`). It is the ONE piece of
webpieces state that lives outside a repo, because the fact it records is machine-scoped: how
much of this box's CPU is being burned by builds, by whom, at the same time. Every linked
worktree has its own `.webpieces/`, so a per-repo ledger is blind to the sibling worktree it is
actually contending with.

Rows are TSV, `<KIND>\t<k>=<v>\t...`:

  START         id t ms by repo tree cwd branch pid wp
  DONE-SUCCESS  id t ms by repo took pid
  DONE-FAIL     id t ms by repo took exit pid

`by` is the build's CALLER — `build` (ad-hoc `pnpm wp-build`), `review` (stage 2) or `finish`
(stage 3). `t`/`ms` are UTC. The file rotates at 1 MB into `builds.log.1` ... `.5`, oldest
dropped; an audit over a long window MUST read the rotated generations too, oldest first, which
`--home` handling below does.

Emits JSON on stdout. Read-only.
"""
import argparse
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

START = "START"
DONE_SUCCESS = "DONE-SUCCESS"
DONE_FAIL = "DONE-FAIL"
GENERATIONS = 5

# Exit codes that mean "something killed it", not "the build found a problem". 128+N is the
# shell's encoding of "died on signal N": 130 = SIGINT (Ctrl-C, an agent's watchdog, a closed
# terminal), 137 = SIGKILL, 143 = SIGTERM.
SIGNAL_EXITS = {130: "SIGINT", 137: "SIGKILL", 143: "SIGTERM"}


def kv(line):
    parts = line.rstrip("\n").split("\t")
    out = {"kind": parts[0]}
    for p in parts[1:]:
        if "=" in p:
            k, v = p.split("=", 1)
            out[k] = v
    return out


def read_ledger(home: Path):
    """Every row across every generation, OLDEST first. `.5` is the oldest, `builds.log` newest."""
    rows = []
    files = [home / ".webpieces" / f"builds.log.{n}" for n in range(GENERATIONS, 0, -1)]
    files.append(home / ".webpieces" / "builds.log")
    seen_files = []
    for f in files:
        if not f.exists():
            continue
        seen_files.append(str(f))
        for line in f.read_text(errors="replace").splitlines():
            if not line.strip():
                continue
            r = kv(line)
            if r["kind"] not in (START, DONE_SUCCESS, DONE_FAIL):
                continue
            try:
                r["_ms"] = int(r.get("ms", "0"))
            except ValueError:
                r["_ms"] = 0
            rows.append(r)
    rows.sort(key=lambda r: r["_ms"])
    return rows, seen_files


def alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except ProcessLookupError:
        return False
    except (PermissionError, ValueError, TypeError):
        return True


def build_records(rows, since_ms):
    """Pair STARTs with their DONE row. A build is IN WINDOW if its START is."""
    done = {}
    for r in rows:
        if r["kind"] in (DONE_SUCCESS, DONE_FAIL):
            done[r.get("id")] = r
    builds = []
    for r in rows:
        if r["kind"] != START or r["_ms"] < since_ms:
            continue
        d = done.get(r.get("id"))
        took = int(d.get("took", "0")) if d else None
        builds.append({
            "id": r.get("id"),
            "by": r.get("by"),
            "repo": r.get("repo"),
            "tree": r.get("tree"),
            "cwd": r.get("cwd"),
            "branch": r.get("branch"),
            "pid": r.get("pid"),
            "wp": r.get("wp"),
            "start_ms": r["_ms"],
            "start_t": r.get("t"),
            "end_ms": r["_ms"] + took if took is not None else None,
            "took_ms": took,
            "outcome": None if d is None else ("success" if d["kind"] == DONE_SUCCESS else "fail"),
            "exit": None if d is None else d.get("exit"),
        })
    return builds


def wasted(builds):
    """A build KILLED (signal exit) whose work was then re-run: the whole first run is burned.

    Pairing rule: the next START, in the same repo+tree, within 30 minutes. That is the
    "agent's build got interrupted and it just ran it again" shape.
    """
    out = []
    for i, b in enumerate(builds):
        if b["outcome"] != "fail":
            continue
        try:
            code = int(b["exit"] or "0")
        except ValueError:
            continue
        if code not in SIGNAL_EXITS:
            continue
        rerun = None
        for c in builds[i + 1:]:
            if c["start_ms"] - b["start_ms"] > 30 * 60 * 1000:
                break
            if c["repo"] == b["repo"] and c["tree"] == b["tree"]:
                rerun = c
                break
        out.append({
            "killed_id": b["id"], "repo": b["repo"], "tree": b["tree"], "branch": b["branch"],
            "by": b["by"], "wp": b["wp"], "signal": SIGNAL_EXITS[code], "exit": code,
            "burned_min": round((b["took_ms"] or 0) / 60000, 1),
            "rerun_id": rerun["id"] if rerun else None,
            "rerun_outcome": rerun["outcome"] if rerun else None,
            "rerun_min": round((rerun["took_ms"] or 0) / 60000, 1) if rerun else None,
            "total_min_for_one_result":
                round(((b["took_ms"] or 0) + ((rerun["took_ms"] or 0) if rerun else 0)) / 60000, 1),
        })
    return out


def concurrency(builds):
    """Max simultaneous builds, and how many minutes were spent with >1 running.

    This is the thing the ledger was built for. CLAUDE.md records ~3.2x slower total test time
    under agent contention, with individual suites 3x slower than the same suite minutes later on
    an idle box. Overlap minutes is the direct measurement of that cost.
    """
    events = []
    for b in builds:
        if b["end_ms"] is None:
            continue
        events.append((b["start_ms"], 1, b))
        events.append((b["end_ms"], -1, b))
    events.sort(key=lambda e: (e[0], e[1]))
    cur = 0
    peak = 0
    overlapped_ms = 0
    last = None
    peak_at = None
    live = []
    pairs = {}
    for ts, delta, b in events:
        if last is not None and cur > 1:
            overlapped_ms += ts - last
            for x in live:
                for y in live:
                    if x["id"] < y["id"]:
                        pairs[(x["id"], y["id"])] = pairs.get((x["id"], y["id"]), 0) + (ts - last)
        cur += delta
        if delta == 1:
            live.append(b)
        else:
            live = [x for x in live if x["id"] != b["id"]]
        if cur > peak:
            peak = cur
            peak_at = datetime.fromtimestamp(ts / 1000, timezone.utc).isoformat()
        last = ts
    byid = {b["id"]: b for b in builds}
    top_pairs = sorted(pairs.items(), key=lambda kv2: -kv2[1])[:6]
    return {
        "max_concurrent": peak,
        "max_concurrent_at": peak_at,
        "overlapped_minutes": round(overlapped_ms / 60000, 1),
        "worst_overlaps": [{
            "a": f'{byid[a]["repo"]}::{byid[a]["tree"]}',
            "b": f'{byid[b2]["repo"]}::{byid[b2]["tree"]}',
            "wp": sorted({byid[a]["wp"] or "?", byid[b2]["wp"] or "?"}),
            "minutes": round(ms / 60000, 1),
        } for (a, b2), ms in top_pairs],
    }


def orphans(builds):
    """A START with no DONE whose pid is DEAD — a build that died recording no outcome.

    A START with no DONE whose pid is ALIVE is simply a build running right now; that is not a
    finding, and it is reported separately so nobody mistakes one for the other.
    """
    dead, running = [], []
    for b in builds:
        if b["outcome"] is not None:
            continue
        rec = {"id": b["id"], "repo": b["repo"], "tree": b["tree"], "branch": b["branch"],
               "by": b["by"], "pid": b["pid"], "start_t": b["start_t"]}
        (running if alive(b["pid"]) else dead).append(rec)
    return {"orphaned": dead, "still_running": running}


def repeats(builds, window_min=60, threshold=3):
    """Same repo+branch built >= `threshold` times inside `window_min`.

    That is the "re-ran the build to see a different slice of the output" antipattern CLAUDE.md
    names explicitly (one measured session: 23.9 minutes across nine builds, five with no code
    change between). The ledger cannot see whether a file changed in between, so this is a
    CANDIDATE list — cross-check against the transcript's file-edit history before calling it.
    """
    by_key = {}
    for b in builds:
        by_key.setdefault((b["repo"], b["branch"]), []).append(b)
    out = []
    for (repo, branch), bs in by_key.items():
        bs.sort(key=lambda x: x["start_ms"])
        for i, b in enumerate(bs):
            grp = [c for c in bs[i:] if c["start_ms"] - b["start_ms"] <= window_min * 60000]
            if len(grp) >= threshold:
                out.append({
                    "repo": repo, "branch": branch, "builds": len(grp),
                    "window_min": window_min,
                    "first": grp[0]["start_t"],
                    "total_build_min": round(sum((g["took_ms"] or 0) for g in grp) / 60000, 1),
                    "by": sorted({g["by"] for g in grp}),
                    "wp": sorted({g["wp"] or "?" for g in grp}),
                })
                break
    return sorted(out, key=lambda r: -r["builds"])


def outliers(builds):
    done = [b for b in builds if b["took_ms"]]
    if not done:
        return {"slowest": [], "median_min": 0}
    mins = sorted((b["took_ms"] or 0) / 60000 for b in done)
    median = mins[len(mins) // 2]
    slow = sorted(done, key=lambda b: -(b["took_ms"] or 0))[:5]
    return {
        "median_min": round(median, 1),
        "slowest": [{"repo": b["repo"], "tree": b["tree"], "branch": b["branch"], "by": b["by"],
                     "wp": b["wp"],
                     "minutes": round((b["took_ms"] or 0) / 60000, 1),
                     "outcome": b["outcome"], "start_t": b["start_t"],
                     "x_median": round(((b["took_ms"] or 0) / 60000) / median, 1) if median else 0}
                    for b in slow],
    }


def semver_key(v):
    """Sort key for a `wp=` version string. Unparseable versions sort first, never crash."""
    return tuple(int(x) for x in re.findall(r"\d+", v or "")[:4])


def by_version(builds):
    """Per-@webpieces-version breakdown of the builds in the window.

    Every START row carries `wp=<version>` — the release that GOVERNED that build. Without this,
    an audit blends findings produced by a release that has since been fixed with findings from
    the release actually running now, and every conclusion is a release or more out of date.
    `latest_in_window` is the one to weight; anything attributed only to an older version is
    history, not a live defect.
    """
    agg = {}
    for b in builds:
        v = b.get("wp") or "?"
        a = agg.setdefault(v, {"count": 0, "minutes": 0.0, "fail": 0, "killed": 0,
                               "repos": set(), "first": None, "last": None})
        a["count"] += 1
        a["minutes"] += (b["took_ms"] or 0) / 60000
        if b["outcome"] == "fail":
            a["fail"] += 1
        try:
            if int(b["exit"] or 0) in SIGNAL_EXITS:
                a["killed"] += 1
        except (TypeError, ValueError):
            pass
        a["repos"].add(Path(b["repo"] or "?").name)
        if a["first"] is None or b["start_ms"] < a["first"][0]:
            a["first"] = (b["start_ms"], b["start_t"])
        if a["last"] is None or b["start_ms"] > a["last"][0]:
            a["last"] = (b["start_ms"], b["start_t"])

    total = sum(a["count"] for a in agg.values()) or 1
    known = [v for v in agg if v != "?"]
    latest = max(known, key=semver_key) if known else None
    out = {}
    for v, a in agg.items():
        out[v] = {
            "builds": a["count"],
            "minutes": round(a["minutes"], 1),
            "fail": a["fail"],
            "killed": a["killed"],
            "pct": round(100 * a["count"] / total),
            "repos": sorted(a["repos"]),
            "first_seen": a["first"][1],
            "last_seen": a["last"][1],
            "is_latest_in_window": v == latest,
        }
    return {
        "latest_in_window": latest,
        "builds_on_latest": out.get(latest, {}).get("builds", 0) if latest else 0,
        "pct_on_latest": out.get(latest, {}).get("pct", 0) if latest else 0,
        "versions": dict(sorted(out.items(), key=lambda kv2: semver_key(kv2[0]))),
    }


def by_caller(builds):
    """`build` = ad-hoc `pnpm wp-build`; `review`/`finish` = the gate's own stages.

    A high ad-hoc ratio means agents are building outside the gate and then making the gate
    build it again — the gate already records the sha it verified and stage 3 skips its own
    build when HEAD has not moved, so three stages are meant to cost ONE build.
    """
    agg = {}
    for b in builds:
        a = agg.setdefault(b["by"] or "?", {"count": 0, "minutes": 0.0, "fail": 0})
        a["count"] += 1
        a["minutes"] = round(a["minutes"] + (b["took_ms"] or 0) / 60000, 1)
        if b["outcome"] == "fail":
            a["fail"] += 1
    total = sum(a["count"] for a in agg.values()) or 1
    for a in agg.values():
        a["pct"] = round(100 * a["count"] / total)
    return agg


def main():
    ap = argparse.ArgumentParser()
    # `--since` is PREFERRED over `--hours` for anything that goes into a committed report: an
    # hours count is relative to whenever the command happened to run, so the report can never be
    # reproduced. An absolute UTC instant can.
    ap.add_argument("--since", default=None,
                    help="window start, ISO-8601 UTC (e.g. 2026-08-20T11:00:00Z). Overrides --hours.")
    ap.add_argument("--until", default=None,
                    help="window END, ISO-8601 UTC. Defaults to now. Use it to audit a CLOSED "
                         "period (e.g. Mon-Wed) so the report is reproducible from its own scope line.")
    ap.add_argument("--hours", type=float, default=24.0)
    ap.add_argument("--home", default=str(Path.home()))
    ap.add_argument("--repos", nargs="*", default=None,
                    help="restrict to builds whose repo= starts with one of these paths")
    args = ap.parse_args()

    home = Path(os.path.expanduser(args.home))
    rows, files = read_ledger(home)
    if args.since:
        since = datetime.fromisoformat(args.since.replace("Z", "+00:00"))
        if since.tzinfo is None:
            since = since.replace(tzinfo=timezone.utc)
    else:
        since = datetime.now(timezone.utc) - timedelta(hours=args.hours)
    since_ms = int(since.timestamp() * 1000)
    if args.until:
        until = datetime.fromisoformat(args.until.replace("Z", "+00:00"))
        if until.tzinfo is None:
            until = until.replace(tzinfo=timezone.utc)
    else:
        until = datetime.now(timezone.utc)
    until_ms = int(until.timestamp() * 1000)

    builds = [b for b in build_records(rows, since_ms) if b["start_ms"] <= until_ms]
    if args.repos:
        pref = [os.path.expanduser(p).rstrip("/") for p in args.repos]
        builds = [b for b in builds if any((b["repo"] or "").startswith(p) for p in pref)]

    earliest = min((r["_ms"] for r in rows), default=None)
    result = {
        "ledger_files": files,
        "ledger_exists": bool(files),
        "ledger_earliest_row": datetime.fromtimestamp(earliest / 1000, timezone.utc).isoformat()
        if earliest else None,
        # Coverage honesty: the ledger did not exist before 0.4.687 landed on this box. A window
        # that starts before `ledger_earliest_row` has NO data for its early part, and the report
        # must say so rather than presenting silence as quiet.
        "window_starts_before_ledger": bool(earliest and since_ms < earliest),
        "window_start_utc": since.isoformat(),
        "window_end_utc": until.isoformat(),
        "rows": len(rows),
        "builds_in_window": len(builds),
        "total_build_minutes": round(sum((b["took_ms"] or 0) for b in builds) / 60000, 1),
        "by_caller": by_caller(builds),
        # Which RELEASE governed each build. Weight `latest_in_window`; a finding attributable
        # only to an older `wp=` may already be fixed.
        "by_version": by_version(builds),
        "wasted": wasted(builds),
        "concurrency": concurrency(builds),
        "orphans": orphans(builds),
        "repeat_builds": repeats(builds),
        "duration": outliers(builds),
        "builds": builds,
    }
    json.dump(result, sys.stdout, indent=1, default=str)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
