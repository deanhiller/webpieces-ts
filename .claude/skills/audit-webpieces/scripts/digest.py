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

# Below this many decisions a harness's rates are noise, and comparing them to the other harness's
# says more about the sample size than about the guards. Codex traffic starts at zero and grows,
# so without this floor its first handful of blocks would read as a catastrophic block rate and the
# comparison block would cry wolf on every early report.
MIN_DECISIONS_FOR_RATE = 40

HARNESSES = ("claude-code", "codex", "unknown")


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


def harness_compare(raw):
    """Claude vs Codex, side by side — block rate, cure loops, blocked minutes, parity holes.

    Two rules make this honest rather than alarming:

      * every threshold is applied PER HARNESS, against that harness's OWN denominator. A shared
        threshold would flag Codex as a regression purely for being new — its decision count is a
        rounding error next to Claude's, so any absolute count comparison is meaningless.
      * a harness under MIN_DECISIONS_FOR_RATE reports `low_sample` and gets no verdict at all,
        rather than a rate computed from six rows.

    `unknown` is carried through as a real column: those are rows written before the `ai=` field
    shipped, and hiding them would make the two named harnesses look like the whole picture.
    """
    g = raw.get("guards") or {}
    t = raw.get("transcripts") or {}
    par = raw.get("codex_parity") or {}
    by_ai = g.get("by_ai") or {}
    dec_by_ai = by_ai.get("decisions") or {}
    tot_by_h = t.get("totals_by_harness") or {}

    rows = {}
    for h in HARNESSES:
        dec = dec_by_ai.get(h) or {}
        total = sum(dec.values())
        blocked = sum(v for k, v in dec.items() if k.startswith(("BLOCK", "DENY")))
        tr = tot_by_h.get(h) or {}
        streaks = [s for s in g.get("deadlock_streaks", [])
                   if s.get("ai") == h and s["consecutive_blocks"] >= MIN_DEADLOCK_STREAK]
        churn = [c for c in g.get("cure_churn", [])
                 if c.get("ai") == h and c["times_prescribed"] >= MIN_CURE_REPEATS]
        low = total < MIN_DECISIONS_FOR_RATE
        rows[h] = {
            "guard_decisions": total,
            "blocked_decisions": blocked,
            "block_rate": (round(blocked / total, 4) if total else None),
            "low_sample": low,
            "deadlock_streaks": len(streaks),
            "cure_loop_repeats": sum(c["times_prescribed"] for c in churn),
            "sessions": tr.get("sessions", 0),
            "blocked_minutes": mins(tr.get("blocked_seconds")),
            "redundant_builds": tr.get("redundant_builds", 0),
            # Thresholds applied against this harness's own numbers, and never on a low sample.
            "over_threshold": (not low) and bool(
                streaks or churn
                or (total and blocked / total >= MIN_BLOCK_RATE)
                or mins(tr.get("blocked_seconds")) >= MIN_BLOCKED_MINUTES),
        }

    return {
        "per_harness": rows,
        "guard_rows_seen_by_ai": par.get("rows_by_ai"),
        "parity_verdict": par.get("verdict"),
        "coverage_holes": par.get("coverage_holes", [])[:10],
        "note": "Rows with no `ai=` predate the field and are counted as `unknown` — a real "
                "value, not a gap. A harness marked low_sample has no verdict, by design.",
    }


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

    # 7 — is Codex actually guarded? (coverage holes, and the two harnesses side by side)
    hc = harness_compare(raw)
    holes = hc["coverage_holes"]
    seen = hc.get("guard_rows_seen_by_ai") or {}
    codex_rows = seen.get("codex", 0)
    codex_sessions = (hc["per_harness"].get("codex") or {}).get("sessions", 0)
    # The one finding that matters most is the cheapest to miss: Codex sessions HAPPENED and
    # produced no guard rows. That is an unguarded session — the "Continue without trusting"
    # keystroke, or a tool-name matcher that matches nothing — and it looks identical to peace
    # and quiet in every total.
    unguarded = codex_sessions > 0 and codex_rows == 0
    if unguarded or holes:
        out.append({
            "area": "Codex guard coverage",
            "headline": (f"{codex_sessions} Codex sessions produced ZERO guard rows — "
                         f"that session was not guarded"
                         if unguarded else
                         f"{len(holes)} surfaces with Claude traffic and no Codex traffic"),
            "evidence": {
                "parity_verdict": hc["parity_verdict"],
                "guard_rows_seen_by_ai": seen,
                "coverage_holes": holes,
                "per_harness": hc["per_harness"],
            },
            "why_it_costs": "A guard that never runs is indistinguishable from a guard that never "
                            "had anything to say. Both read as zero blocks. Only the comparison "
                            "between harnesses separates them — which is how an inert "
                            "`.codex/hooks.json` sat in every repo unnoticed.",
        })

    # 8 — 3-point merges
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
    hc = harness_compare(raw)
    if "--json" in sys.argv:
        json.dump({"repos": raw.get("repos"), "generated": raw.get("generated"),
                   "versions": versions(raw), "harnesses": hc, "major": items},
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
    print("# harnesses (thresholds applied PER harness; low_sample => no verdict):")
    for h, r in hc["per_harness"].items():
        rate = "n/a" if r["block_rate"] is None else f"{r['block_rate']:.1%}"
        flag = " LOW-SAMPLE" if r["low_sample"] else (" OVER-THRESHOLD" if r["over_threshold"] else "")
        print(f"#   {h:<12} decisions={r['guard_decisions']:<6} blocked={r['blocked_decisions']:<5} "
              f"rate={rate:<7} streaks={r['deadlock_streaks']} cure-repeats={r['cure_loop_repeats']} "
              f"sessions={r['sessions']} blocked-min={r['blocked_minutes']}{flag}")
    if hc.get("parity_verdict"):
        print(f"# codex parity: {hc['parity_verdict']}")
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
