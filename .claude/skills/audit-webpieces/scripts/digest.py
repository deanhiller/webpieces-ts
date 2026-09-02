#!/usr/bin/env python3
"""
digest.py — turn wp_audit.py's raw JSON into a compact MAJOR-only digest.

  python3 digest.py <all.json>            # markdown skeleton to stdout
  python3 digest.py <all.json> --json     # same content as json

Thresholds below define what "MAJOR" means. Anything under them is counted but
not listed — the point of the audit is the few things worth acting on.
"""

import json
import sys
from pathlib import Path

# --- what counts as MAJOR ---------------------------------------------------
MIN_DEADLOCK_STREAK = 3        # consecutive blocks on one rule, one session
MIN_CURE_REPEATS = 4           # same cure prescribed N times => cure is not working
MIN_REDUNDANT_BUILDS = 3       # builds with no intervening edit, one session
MIN_BLOCKED_MINUTES = 10       # blocked-call wall time per repo
MIN_BLOCK_RATE = 0.03          # blocked calls / total guard decisions


def mins(sec):
    return round((sec or 0) / 60, 1)


def versions(raw):
    """Which @webpieces RELEASE governed each repo during the window.

    Findings from the guard logs and transcripts carry no version of their own, so this table is
    how they get attributed: a repo pinned two releases back produced its blocks under code that
    may already be fixed. Weight findings from repos on `npm_latest`; treat the rest as history.
    """
    sk = raw.get("skew") or {}
    rows = []
    for r in sk.get("rows", []):
        pins = {v for v in (r.get("pins") or {}).values() if v and v[0].isdigit() or (v and v[0] in "^~")}
        rows.append({
            "repo": Path(r["repo"]).name,
            "installed": r.get("installed_primary"),
            "pinned": sorted(pins) or None,
            "worktrees": sorted({v for v in (r.get("worktree_installs") or {}).values() if v}),
            "behind_main": r.get("commits_behind_origin_main"),
        })
    return {"npm_latest": sk.get("npm_latest"), "repos": rows}


def build(raw):
    out = []
    g = raw.get("guards") or {}
    t = raw.get("transcripts") or {}
    iso = raw.get("isolation") or {}
    sk = raw.get("skew") or {}
    dd = raw.get("docdrift") or {}
    mx = raw.get("matrix") or {}
    mg = raw.get("merges") or {}

    # 1 — guard deadlock cycles
    streaks = [s for s in g.get("deadlock_streaks", []) if s["consecutive_blocks"] >= MIN_DEADLOCK_STREAK]
    churn = [c for c in g.get("cure_churn", []) if c["times_prescribed"] >= MIN_CURE_REPEATS]
    health = g.get("stale_main_health", [])
    wasted_blocks = sum(h.get("blocks_that_bought_nothing", 0) for h in health)
    not_taking = [h for h in health if h.get("verdict") == "cure-not-taking"]
    dec = g.get("decisions", {})
    total_dec = sum(dec.values()) or 1
    blocked = sum(v for k, v in dec.items() if k.startswith(("BLOCK", "DENY")))
    rate = blocked / total_dec
    if streaks or churn or rate >= MIN_BLOCK_RATE:
        out.append({
            "area": "Guard cycles / deadlock",
            "headline": f"{blocked} blocked decisions ({rate:.1%} of {total_dec}); "
                        f"{len(streaks)} deadlock streaks; {len(churn)} cures prescribed on repeat; "
                        f"stale-main: {wasted_blocks} blocks bought nothing, "
                        f"{len(not_taking)} sessions where the cure did not take",
            "evidence": {
                # Read this FIRST. A stale-main block count is not a cost until `kinds` says which
                # of the blocks bought nothing — see the Step 4 rule in SKILL.md.
                "stale_main_health": health[:6],
                "stale_main_blocks_that_bought_nothing": wasted_blocks,
                "stale_main_cure_not_taking": not_taking[:4],
                "top_blocking_rules": g.get("blocks_by_rule", [])[:6],
                "deadlock_streaks": streaks[:6],
                "cure_churn": churn[:6],
                "uncurable_faults": g.get("uncurable_faults", [])[:5],
            },
            "why_it_costs": "Every block is a wasted round-trip. A repeated cure means the cure text "
                            "does not resolve the state it names — the agent loops until it gives up "
                            "or works around the guard.",
        })

    # 2 — wasted time in transcripts
    tot = t.get("totals", {})
    worst_b = [s for s in t.get("worst_redundant_builds", []) if s["redundant_builds"] >= MIN_REDUNDANT_BUILDS]
    if worst_b or mins(tot.get("blocked_seconds")) >= MIN_BLOCKED_MINUTES \
            or mins(tot.get("error_seconds")) >= MIN_BLOCKED_MINUTES:
        out.append({
            "area": "Wasted time",
            "headline": f"{tot.get('active_hours')}h active across {t.get('sessions_scanned')} sessions — "
                        f"{tot.get('blocked_calls')} guard blocks ({mins(tot.get('blocked_seconds'))} min), "
                        f"{tot.get('error_calls')} failed calls ({mins(tot.get('error_seconds'))} min), "
                        f"{mins(tot.get('redundant_build_seconds'))} min in builds with no "
                        f"intervening edit ({tot.get('redundant_builds')} of {tot.get('builds')} builds)",
            "evidence": {
                "totals": tot,
                "sessions_rebuilding_without_editing": [
                    {k: s[k] for k in ("repo", "session", "builds", "redundant_builds",
                                       "build_seconds", "top_build_cmds")} for s in worst_b[:6]
                ],
                "most_blocked_sessions": [
                    {k: s[k] for k in ("repo", "session", "blocked_calls", "blocked_seconds",
                                       "error_calls", "error_seconds", "block_samples")}
                    for s in t.get("worst_blocked_time", [])[:4]
                ],
                "most_repeated_commands": [
                    {k: s[k] for k in ("repo", "session", "repeated_cmd_calls", "top_repeated_cmds")}
                    for s in t.get("worst_repeated_commands", [])[:4]
                ],
                "blocked_markers": t.get("blocked_markers", [])[:8],
            },
            "why_it_costs": "A build re-run with no edit in between cannot produce a different result. "
                            "It is the agent re-running to see a different slice of output it should "
                            "have read from the log file.",
        })

    # 3 — worktree / file isolation
    iso_major = [f for f in iso.get("findings", []) if f.get("severity") == "MAJOR"]
    if iso_major:
        out.append({
            "area": "Worktree / .webpieces isolation",
            "headline": "; ".join(sorted({f["what"] for f in iso_major}))[:220],
            "evidence": {"findings": iso_major[:8],
                         "per_repo": {k: v for k, v in list((iso.get("per_repo") or {}).items())[:8]}},
            "why_it_costs": "A guard verdict computed against the wrong tree describes a branch the "
                            "agent is not on. The cure it prints is then unfollowable — the classic "
                            "uncurable block.",
        })

    # 4 — version / pin skew
    sk_major = [f for f in sk.get("findings", []) if f.get("severity") == "MAJOR"]
    if sk_major:
        out.append({
            "area": "Version / pin skew",
            "headline": f"{len(sk_major)} trees governed by a release they did not pin "
                        f"(npm latest {sk.get('npm_latest')})",
            "evidence": {"findings": sk_major[:10]},
            "why_it_costs": "trinary-version-skew BLOCKS every tool call in that tree until the "
                            "versions agree — a hard stop, not a slowdown.",
        })

    # 5 — doc <-> reality drift
    dd_major = [f for f in dd.get("findings", []) if f.get("severity") == "MAJOR"]
    if dd_major:
        out.append({
            "area": "Doc ↔ reality drift",
            "headline": f"{len(dd_major)} docs send the agent to paths that do not exist",
            "evidence": {"findings": dd_major[:10],
                         "build_log_claims": dd.get("build_log_claims", [])[:6]},
            "why_it_costs": "The agent reads nothing, concludes the step failed, and redoes the work "
                            "that produced the artifact — this is the read-the-wrong-build.log loop.",
        })

    # 6 — guard logs vs the L0/L1/L2 matrices
    mx_major = [f for f in mx.get("findings", []) if f.get("severity") == "MAJOR"]
    if mx_major:
        out.append({
            "area": "Guard logs vs L0/L1/L2 matrix",
            "headline": "; ".join(sorted({f["what"] for f in mx_major}))[:220],
            "evidence": {"findings": mx_major[:8],
                         "per_repo": {k: v for k, v in list((mx.get("per_repo") or {}).items())[:6]}},
            "why_it_costs": "The matrices are what an agent is told to reason from. Where the logs "
                            "and the matrix disagree, the documented behaviour is wrong and every "
                            "conclusion drawn from it is wrong too.",
        })

    # 7 — 3-point merges
    mg_major = [f for f in mg.get("findings", []) if f.get("severity") == "MAJOR"]
    if mg_major:
        out.append({
            "area": "3-point merges",
            "headline": "; ".join(sorted({f["what"] for f in mg_major}))[:220],
            "evidence": {"findings": mg_major[:8],
                         "per_repo": {k: v for k, v in list((mg.get("per_repo") or {}).items())[:8]}},
            "why_it_costs": "A merge that stalls or repeats costs a full re-verify and re-review "
                            "cycle each round, and leaves the branch drifting from main meanwhile.",
        })

    return out


def main():
    raw = json.loads(Path(sys.argv[1]).read_text())
    items = build(raw)
    if "--json" in sys.argv:
        json.dump({"repos": raw.get("repos"), "generated": raw.get("generated"),
                   "versions": versions(raw), "major": items},
                  sys.stdout, indent=1, default=str)
        print()
        return
    v = versions(raw)
    print(f"# repos: {len(raw.get('repos', []))}   generated: {raw.get('generated')}")
    print(f"# @webpieces npm latest: {v['npm_latest']}")
    print("# repo versions (installed / pinned / worktrees / behind-main):")
    for r in v["repos"]:
        print(f"#   {r['repo']:<24} {str(r['installed']):<12} pin={r['pinned']} "
              f"wt={r['worktrees']} behind={r['behind_main']}")
    if not items:
        print("\nNo MAJOR findings above threshold.")
        return
    for i, it in enumerate(items, 1):
        print(f"\n## {i}. {it['area']}\n\n{it['headline']}\n")
        print(f"WHY IT COSTS: {it['why_it_costs']}\n")
        print("EVIDENCE:")
        print(json.dumps(it["evidence"], indent=1, default=str)[:6000])


if __name__ == "__main__":
    main()
