#!/usr/bin/env python3
"""
wp_audit.py — READ-ONLY collector for /audit-webpieces.

Computes aggregates from Claude Code transcripts and .webpieces guard logs so the
model never has to read a 239MB transcript directory into context.

Every subcommand prints ONE json object to stdout. Nothing is ever written.

  guards       L0/L1/L2/rejection logs: blocks, deadlock streaks, uncurable faults
  isolation    worktree / .webpieces / shim-vs-root mismatches
  transcripts  wall-clock, tool histogram, redundant builds, blocked-call cost
  parity       per-rule Claude-vs-Codex traffic, and the coverage holes it exposes
  skew         @webpieces pin vs installed, across every repo and worktree
  docdrift     paths quoted in docs/skills that do not exist on disk
  all          all of the above

Two harnesses are governed by the same guards now, so every guard metric carries a
per-harness breakdown and `parity` exists to answer the one question a total cannot:
is Codex actually being guarded, or does it merely look quiet?
"""

import argparse
import json
import os
import re
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

PROJECTS = Path.home() / ".claude" / "projects"
# Codex transcripts are flat BY DATE with no per-project directory — the repo is named by
# `session_meta.payload.cwd` inside each file, which is why the reader below has to open every
# rollout in the window instead of globbing a sanitized path the way the Claude reader can.
CODEX_SESSIONS = Path.home() / ".codex" / "sessions"

# ---------------------------------------------------------------- harness


# The values are the AiType union's OWN strings, taken from
# packages/tooling/ai-hook-rules/src/core/agent-event.ts. Note `claude-code`, NOT `claude` — a
# reader that guesses the short spelling silently reports every Claude row as `unknown` and then
# reports a 100% Codex coverage hole, which is the exact wrong answer this section exists to give
# correctly.
AI_CLAUDE = "claude-code"
AI_CODEX = "codex"

# What a row written before the `ai=` field existed reads as. It is a REAL VALUE, not a
# compatibility shim: `unknown` is countable and greppable, and it says something true — nothing
# established the harness for that row. Silently folding those into `claude-code` would invent
# evidence, and dropping them would understate the volume.
AI_UNKNOWN = "unknown"

AI_HARNESSES = (AI_CLAUDE, AI_CODEX, AI_UNKNOWN)


def harness_of(meta):
    """The harness a guard row was written for, from its trailing `ai=` field.

    Every one of the five TSV streams carries `ai=` as a trailing k=v field, so `kv()` already
    parses it for free — this only maps it onto the closed vocabulary. Anything absent or
    unrecognised is `unknown` rather than a guess.
    """
    v = (meta or {}).get("ai") or ""
    return v if v in (AI_CLAUDE, AI_CODEX) else AI_UNKNOWN


def by_ai_dict(counters):
    """{harness: {key: n}} with the empty harnesses kept, so a ZERO is visible rather than absent.

    A missing key and a zero read identically to a model skimming JSON, and the whole point of the
    parity section is that zero Codex traffic is a FINDING. So the harnesses are always all there.
    """
    return {h: dict(counters.get(h, Counter())) for h in AI_HARNESSES}


# ---------------------------------------------------------------- helpers


def parse_ts(s):
    if not s:
        return None
    s = s.strip()
    try:
        if s.endswith("Z"):
            return datetime.fromisoformat(s[:-1]).replace(tzinfo=timezone.utc)
        return datetime.fromisoformat(s).astimezone(timezone.utc)
    except Exception:
        return None


# An absolute window beats `--hours` for anything that goes in a committed report: an hours count
# is relative to whenever the command ran, so the report can never be reproduced from it. WINDOW_END
# also lets a CLOSED period ("Monday through Wednesday") actually close, instead of silently running
# on to now. Both are set once from argv in main(); None means "unbounded on that side".
WINDOW_START = None
WINDOW_END = None


def cutoff(hours):
    if WINDOW_START is not None:
        return WINDOW_START
    return datetime.now(timezone.utc) - timedelta(hours=hours)


def in_window(ts):
    return ts is not None and (WINDOW_END is None or ts <= WINDOW_END)


def sanitized(repo: Path) -> str:
    return str(repo).replace("/", "-")


def transcript_dirs_for(repo: Path):
    """The repo's own project dir plus any linked-worktree project dirs."""
    base = sanitized(repo)
    out = []
    if not PROJECTS.is_dir():
        return out
    for d in PROJECTS.iterdir():
        if not d.is_dir():
            continue
        if d.name == base or d.name.startswith(base + "--"):
            out.append(d)
    return out


def tsv(line):
    return line.rstrip("\n").split("\t")


def kv(fields):
    """Trailing k=v fields of a guard log row."""
    out = {}
    for f in fields:
        if "=" in f:
            k, _, v = f.partition("=")
            if k and " " not in k:
                out.setdefault(k, v)
    return out


def row_ts(first):
    m = re.match(r"\[([^\]]+)\]", first)
    return parse_ts(m.group(1)) if m else parse_ts(first)


def guard_log_dirs(repo: Path, subdir: str):
    """Every directory this repo writes `subdir` rows into — the primary tree AND each worktree.

    An agent working in a linked worktree that has its own `.webpieces` writes its guard rows to
    `.webpieces/worktrees/<agent>/logs/<subdir>`, not to the primary tree's. Reading only the
    primary makes every worktree session invisible, and worktrees are where agent work happens —
    so the harness breakdown would have reported `unknown` forever while the `ai=` rows sat
    unread one directory over. (`audit_isolation` already knows both locations exist; it reports
    `worktrees_with_own_logs`.)
    """
    out = [repo / ".webpieces" / "logs" / subdir]
    wt = repo / ".webpieces" / "worktrees"
    if wt.is_dir():
        try:
            out.extend(sorted(d / "logs" / subdir for d in wt.iterdir() if d.is_dir()))
        except OSError:
            pass
    return [d for d in out if d.is_dir()]


def iter_guard_rows(repo: Path, subdir: str, since):
    """Yield (path, ts, fields) for every row newer than `since`."""
    for d in guard_log_dirs(repo, subdir):
        yield from _iter_dir_rows(d, since)


def _iter_dir_rows(d: Path, since):
    for f in sorted(d.glob("*.log")):
        try:
            if datetime.fromtimestamp(f.stat().st_mtime, timezone.utc) < since:
                continue
            for line in f.read_text(errors="replace").splitlines():
                if not line.strip():
                    continue
                fields = tsv(line)
                ts = row_ts(fields[0])
                if ts is None or ts < since or not in_window(ts):
                    continue
                yield f, ts, fields
        except OSError:
            continue


def session_of(path: Path):
    """<sessionId>-<callId>-<kind>.log"""
    m = re.match(r"([0-9a-f-]{36})-(.+?)-(guards|rules|wp-ai-[a-z-]+)\.log$", path.name)
    if m:
        return m.group(1), m.group(2)
    return path.stem, "?"


def top(counter, n=12):
    return [{"key": k, "n": v} for k, v in counter.most_common(n)]


# ---------------------------------------------------------------- guards

# `stale-main-bash-guard` is reliably the loudest rule in the logs, and its block COUNT says nothing
# about its health. A block that stops an agent reading fifteen-commit-stale source is a SPEED WIN:
# it costs one round trip and saves a wrong answer plus everything built on top of it. CORRECTNESS IS
# SPEED here. The health question is never "how often did it fire" but "did firing get the tree
# FRESH".
#
# `localMain=`/`originMain=` on each block row make that computable. If a later block's `localMain`
# equals an earlier block's `originMain`, the agent pulled and the tree genuinely moved forward - the
# guard worked and origin simply moved again. If the SAME pair repeats, the cure did not take, and
# only THAT is a deadlock.
STALE_STATE_RE = re.compile(r"localMain=([0-9a-f]+)\s+originMain=([0-9a-f]+)")
CURE_VERB_RE = re.compile(r"wp-checkout-clean-main|git\s+pull|git\s+fetch")
# `<cure> && <work>` vs `<cure>; <work>` is the whole safety question - see _classify_stale_block.
CURE_PREFIX_AND_RE = re.compile(r"^\s*(?:pnpm\s+)?(?:wp-checkout-clean-main|git\s+(?:pull|fetch))"
                                r"[^;&|]*(?:\|[^;&]*)?&&")
# A path that cannot be stale in any sense the guard cares about: it is not tracked content.
OFF_REPO_RE = re.compile(r"/private/tmp/|/tmp/|~/\.claude|/Users/[^/]+/\.claude|localhost:|127\.0\.0\.1")
REPO_READ_RE = re.compile(
    r"\b(cat|sed\s+-n|head|tail|grep\s+-[a-zA-Z]*r|ls|find|wc)\b[^|;]*"
    r"\b(services/|libraries/|packages/|apps/|scripts/|docs/|src/|eslint\.config|package\.json)")


def _classify_stale_block(cmd):
    """What KIND of stale-main block is this? The four answers have opposite meanings.

    prevented_stale_read   the agent was about to read tracked source off a stale tree. The guard
                           bought a correct answer for one round trip. This is the rule EARNING its
                           keep; it belongs in "checked and clean", never in a cost finding.
    cure_bundled_semicolon the agent joined the cure to the work with `;`, so the work runs even if
                           the pull failed - and 7 of 9 observed cases also `>/dev/null 2>&1` the
                           cure, making the failure invisible. Refusing is right, because the
                           two-step genuinely IS safer: the next call is a fresh evaluation that
                           recomputes localMain vs originMain, so a failed pull re-blocks. An allowed
                           compound never gets that second look. A high count here is a finding about
                           the AGENT, not the guard.
    cure_bundled_and       the agent joined them with `&&`. The shell already guarantees the work is
                           skipped if the cure fails, which is exactly the property the guard needs.
                           Blocking this is a TOOLING finding - it costs a round trip and buys
                           nothing.
    blocked_badly          the target is outside the repo (scratchpad, skill file, localhost health
                           check, `ps`). Nothing there can be stale. Also a tooling finding.
    """
    if CURE_PREFIX_AND_RE.search(cmd):
        return "cure_bundled_and"
    if CURE_VERB_RE.search(cmd):
        return "cure_bundled_semicolon"
    if REPO_READ_RE.search(cmd) and not OFF_REPO_RE.search(cmd):
        return "prevented_stale_read"
    if OFF_REPO_RE.search(cmd):
        return "blocked_badly"
    return "unclassified"


def _stale_main_health(repo, sess, rows):
    """Did blocking actually get this session's tree FRESH? Returns None when the rule never fired."""
    blocks = [r for r in rows
              if (r[1].startswith("BLOCK") or r[1].startswith("DENY"))
              and "stale-main" in (r[4] or "")]
    if not blocks:
        return None
    kinds = Counter(_classify_stale_block(r[3] or "") for r in blocks)
    pairs, seen_origins, advanced, repeated = [], set(), 0, 0
    prev_pair = None
    for r in blocks:
        m = STALE_STATE_RE.search(r[5].get("_raw", ""))
        if not m:
            continue
        pair = (m.group(1), m.group(2))
        if pair[0] in seen_origins:
            advanced += 1          # local main caught up to what origin was at an earlier block
        if pair == prev_pair:
            repeated += 1          # same state twice running: the cure did NOT take
        seen_origins.add(pair[1])
        pairs.append(pair)
        prev_pair = pair
    costly = kinds.get("cure_bundled_and", 0) + kinds.get("blocked_badly", 0)
    return {
        "repo": repo.name, "session": sess, "blocks": len(blocks),
        "ai": dict(Counter(harness_of(r[5]) for r in blocks)),
        "kinds": dict(kinds),
        "distinct_states": len(set(pairs)),
        "advanced": advanced,
        "repeated_identical_state": repeated,
        "blocks_that_bought_nothing": costly,
        # The verdict. "healthy" means the blocks moved the tree forward and origin kept moving -
        # the rule working, and cheap. "cure-not-taking" is the real deadlock, and it is rare.
        "verdict": ("cure-not-taking" if repeated and not advanced
                    else "healthy: blocks got the tree fresh, origin moved again" if advanced
                    else "single-state: fired but never re-blocked on a new state"),
    }


def audit_guards(repos, hours):
    since = cutoff(hours)
    blocks = Counter()
    decisions = Counter()
    faults = Counter()
    per_repo = defaultdict(Counter)
    streaks = []          # deadlock candidates
    cure_churn = []       # same cure emitted over and over
    uncurable = []
    stale_health = []     # per-session verdict for stale-main-bash-guard (see _stale_main_health)
    # Per-HARNESS twins of the three aggregates above. Kept separately rather than replacing the
    # totals: the totals are what the existing thresholds are calibrated against, and a Codex
    # sample is currently tiny next to Claude's, so a merged number would be dominated by Claude
    # and a split-only number would break every comparison to earlier reports.
    decisions_by_ai = defaultdict(Counter)
    blocks_by_ai = defaultdict(Counter)
    faults_by_ai = defaultdict(Counter)

    for repo in repos:
        # per (session) ordered stream of L2 decisions.
        # ONE call is logged TWICE — once in <session>-coordinator-guards.log and once in
        # <session>-<callId>-guards.log — so the same (decision, rule, cmd) recurs within
        # ~100ms. Counting both doubles every number; collapse them.
        stream = defaultdict(list)
        seen_dedupe = {}
        for f, ts, fields in iter_guard_rows(repo, "L2-decisions", since):
            if len(fields) < 3:
                continue
            dedupe_key = (fields[1], fields[5] if len(fields) > 5 else "-",
                          fields[3] if len(fields) > 3 else "")
            prev_ts = seen_dedupe.get(dedupe_key)
            if prev_ts is not None and abs((ts - prev_ts).total_seconds()) <= 3:
                seen_dedupe[dedupe_key] = ts
                continue
            seen_dedupe[dedupe_key] = ts
            decision = fields[1]
            tool = fields[2]
            cmd = fields[3] if len(fields) > 3 else ""
            rule = fields[5] if len(fields) > 5 else "-"
            meta = kv(fields)
            meta["_raw"] = "\t".join(fields)
            ai = harness_of(meta)
            decisions[decision] += 1
            decisions_by_ai[ai][decision] += 1
            per_repo[repo.name][decision] += 1
            if decision.startswith("BLOCK") or decision.startswith("DENY"):
                blocks[rule] += 1
                blocks_by_ai[ai][rule] += 1
            if meta.get("fault", "-") not in ("-", ""):
                faults[meta["fault"]] += 1
                faults_by_ai[ai][meta["fault"]] += 1
            sess, _call = session_of(f)
            stream[sess].append((ts, decision, tool, cmd, rule, meta))

        for sess, rows in stream.items():
            rows.sort(key=lambda r: r[0])
            run_rule, run = None, []
            for r in rows:
                blocked = r[1].startswith("BLOCK") or r[1].startswith("DENY")
                if blocked and r[4] == run_rule:
                    run.append(r)
                elif blocked:
                    if len(run) >= 3:
                        streaks.append(_streak(repo, sess, run_rule, run))
                    run_rule, run = r[4], [r]
                else:
                    if len(run) >= 3:
                        streaks.append(_streak(repo, sess, run_rule, run))
                    run_rule, run = None, []
            if len(run) >= 3:
                streaks.append(_streak(repo, sess, run_rule, run))

            health = _stale_main_health(repo, sess, rows)
            if health:
                stale_health.append(health)

            # Keyed by (cure, harness) so a cure that loops on ONE harness is not diluted by the
            # other having followed it successfully — that difference IS the finding.
            cures = Counter(
                (r[5].get("cure", "-"), harness_of(r[5])) for r in rows
                if (r[1].startswith("BLOCK") or r[1].startswith("DENY"))
                and r[5].get("cure", "-") not in ("-", "")
            )
            for (cure, ai), n in cures.items():
                if n >= 4:
                    cure_churn.append(
                        {"repo": repo.name, "session": sess, "ai": ai,
                         "cure": cure[:160], "times_prescribed": n}
                    )
            for r in rows:
                fault = r[5].get("fault", "-")
                if fault not in ("-", ""):
                    uncurable.append(
                        {"repo": repo.name, "session": sess, "ts": r[0].isoformat(),
                         "ai": harness_of(r[5]),
                         "fault": fault, "rule": r[4], "tool": r[2],
                         "cure": r[5].get("cure", "-")[:160], "cmd": r[3][:140]}
                    )

        # tool-rule rejections (Write/Edit blocked by a code-rule)
        for f, ts, fields in iter_guard_rows(repo, "rejections", since):
            # ts \t tool \t path \t [rule] \t artifact \t fault=..
            rule = next((re.sub(r"[\[\]]", "", f_) for f_ in fields[1:6]
                         if f_.startswith("[") and f_.endswith("]")), None)
            if rule:
                blocks["rejection:" + rule] += 1
                blocks_by_ai[harness_of(kv(fields))]["rejection:" + rule] += 1
                per_repo[repo.name]["REJECT_WRITE"] += 1

    streaks.sort(key=lambda s: -s["consecutive_blocks"])
    return {
        "window_hours": hours,
        "decisions": dict(decisions),
        "blocks_by_rule": top(blocks, 20),
        "faults": dict(faults),
        "deadlock_streaks": streaks[:20],
        "cure_churn": sorted(cure_churn, key=lambda c: -c["times_prescribed"])[:15],
        # Read this BEFORE reading blocks_by_rule. A stale-main block count is not a cost until
        # `kinds` says which of the blocks bought nothing.
        "stale_main_health": sorted(stale_health, key=lambda h: -h["blocks"])[:15],
        "uncurable_faults": uncurable[:20],
        "per_repo_decisions": {k: dict(v) for k, v in per_repo.items()},
        # The same three aggregates, split by harness. Read alongside `codex_parity`: a harness
        # with no blocks might be perfectly behaved, or might never have reached the guards at all,
        # and only the parity section can tell those apart.
        "by_ai": {
            "decisions": by_ai_dict(decisions_by_ai),
            "blocks_by_rule": {h: top(blocks_by_ai.get(h, Counter()), 12) for h in AI_HARNESSES},
            "faults": by_ai_dict(faults_by_ai),
        },
    }


def _streak(repo, sess, rule, run):
    span = (run[-1][0] - run[0][0]).total_seconds()
    return {
        "repo": repo.name,
        "session": sess,
        "rule": rule,
        "ai": harness_of(run[0][5]),
        "consecutive_blocks": len(run),
        "span_seconds": round(span),
        "first_ts": run[0][0].isoformat(),
        "cure_prescribed": run[0][5].get("cure", "-")[:160],
        "fault": run[0][5].get("fault", "-"),
        "sample_cmds": [r[3][:120] for r in run[:4]],
    }


# ---------------------------------------------------------------- codex parity


# How much Claude traffic a surface needs before its Codex silence means anything. Below this the
# surface is simply rare, and calling it a hole would bury the real ones in noise.
PARITY_MIN_CLAUDE_HITS = 5

# The L0 verdict vocabulary, as SHIM_LOG_VERDICTS spells it: PASS-BIN-ALLOW, ALLOW-CODEX-READ,
# DENY-STALE, and so on — screaming-kebab, at least two segments, no `=`.
SHIM_VERDICT_RE = re.compile(r"[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+")


def _parity_surfaces(repo, since, hits):
    """Count every guard surface each harness actually REACHED, across all five streams.

    "Surface" is deliberately wider than "rule". A wrong tool-name matcher does not show up as a
    rule that never fired — it shows up as a harness whose calls never arrive at the LAYER at all,
    because the hook never matched and the shim never ran. So the L0 verdict vocabulary and the L1
    matrix rows are counted as surfaces beside the L2 rule names and the write rejections. That is
    what would have caught the inert `.codex/hooks.json`: Codex at zero on `L0:*` while Claude sat
    in the hundreds, with no rule anywhere looking wrong.
    """
    # L0-shim: `<ts> <hook> <tool> ai=.. tree=.. layer=L0 row=.. shim=.. fault=.. <VERDICT> <cmd>`
    # The verdict is matched by SHAPE, not by "is it uppercase" — an ISO timestamp answers True to
    # str.isupper() (its only cased character is the `T`), so the loose test made every row its own
    # surface and produced thousands of one-hit entries instead of the dozen real verdicts.
    for _f, _ts, fields in iter_guard_rows(repo, "L0-shim", since):
        meta = kv(fields)
        verdict = next((x for x in fields[1:] if SHIM_VERDICT_RE.fullmatch(x)), "?")
        hits["L0:" + verdict][harness_of(meta)] += 1

    # calls/: every call the bin judged at all, with its guards= verdict.
    for _f, _ts, fields in iter_guard_rows(repo, "calls", since):
        meta = kv(fields)
        hits["calls:" + meta.get("guards", "?")][harness_of(meta)] += 1

    # L1-location/: the matrix ROW is the surface — a row nothing ever reaches on one harness is
    # the location stack failing to see that harness.
    for _f, _ts, fields in iter_guard_rows(repo, "L1-location", since):
        meta = kv(fields)
        hits["L1:row=" + meta.get("row", "?")][harness_of(meta)] += 1

    # L2-decisions/: the named rules. Field 5 is the rule; '-' means no rule spoke.
    for _f, _ts, fields in iter_guard_rows(repo, "L2-decisions", since):
        meta = kv(fields)
        rule = fields[5] if len(fields) > 5 else "-"
        if rule and rule != "-":
            hits["rule:" + rule][harness_of(meta)] += 1

    # rejections/: a Write/Edit refused by a code-rule.
    for _f, _ts, fields in iter_guard_rows(repo, "rejections", since):
        meta = kv(fields)
        rule = next((re.sub(r"[\[\]]", "", x) for x in fields[1:6]
                     if x.startswith("[") and x.endswith("]")), None)
        if rule:
            hits["rejection:" + rule][harness_of(meta)] += 1


def audit_parity(repos, hours):
    """Is Codex actually being GUARDED, or does it just look quiet?

    A total block count cannot answer that. Zero Codex blocks is the reading you get both when
    Codex is perfectly behaved and when no guard ever ran for it — and the second is the failure
    that shipped: `.codex/hooks.json` matched tool names Codex does not emit and referenced
    `$CLAUDE_PROJECT_DIR`, which is unset there, so every hook died and nothing anywhere looked
    wrong. Comparing per-surface traffic BETWEEN harnesses is what makes that visible.
    """
    since = cutoff(hours)
    hits = defaultdict(Counter)          # surface -> harness -> n
    per_repo = {}

    for repo in repos:
        before = {s: dict(c) for s, c in hits.items()}
        _parity_surfaces(repo, since, hits)
        delta = Counter()
        for s, c in hits.items():
            for h, n in c.items():
                delta[h] += n - before.get(s, {}).get(h, 0)
        per_repo[repo.name] = dict(delta)

    totals = Counter()
    for c in hits.values():
        for h, n in c.items():
            totals[h] += n

    rules, holes = [], []
    for surface in sorted(hits):
        c = hits[surface]
        row = {
            "surface": surface,
            "claude_hits": c.get(AI_CLAUDE, 0),
            "codex_hits": c.get(AI_CODEX, 0),
            "unknown_hits": c.get(AI_UNKNOWN, 0),
        }
        rules.append(row)
        if row["claude_hits"] >= PARITY_MIN_CLAUDE_HITS and row["codex_hits"] == 0:
            holes.append(row)

    # The whole-harness verdict, which subsumes every per-surface hole when it fires. If Codex
    # produced no rows AT ALL in a window where it was used, no surface comparison is meaningful —
    # the finding is "the hooks never ran", not "these N rules have holes".
    if totals[AI_CODEX] == 0:
        # Every per-surface hole here is the SAME fact restated once per surface, so listing them
        # would bury the one finding under eleven copies of it.
        holes = []
        verdict = ("NO CODEX ROWS IN WINDOW — either Codex was not used, or its hooks never ran. "
                   "Cross-check against ~/.codex/sessions for this repo before concluding either: "
                   "sessions present with zero rows is the unguarded-session failure. Per-surface "
                   "holes are not listed: with no Codex traffic at all they would each restate this.")
    elif not holes:
        verdict = "no coverage holes: every surface Claude reached, Codex reached too"
    else:
        verdict = f"{len(holes)} surfaces with Claude traffic and ZERO Codex traffic"

    rules.sort(key=lambda r: -(r["claude_hits"] + r["codex_hits"]))
    return {
        "window_hours": hours,
        "min_claude_hits_for_a_hole": PARITY_MIN_CLAUDE_HITS,
        "rows_by_ai": dict(totals),
        "per_repo_rows_by_ai": per_repo,
        "verdict": verdict,
        "coverage_holes": sorted(holes, key=lambda r: -r["claude_hits"])[:20],
        "surfaces": rules[:60],
    }


# ---------------------------------------------------------------- isolation


WT_RE = re.compile(r"(/[\w./-]*?(?:\.claude/worktrees/[\w-]+|worktrees/[\w-]+))")


def audit_isolation(repos, hours):
    since = cutoff(hours)
    findings = []
    per_repo = {}

    for repo in repos:
        try:
            wt = subprocess.run(
                ["git", "-C", str(repo), "worktree", "list", "--porcelain"],
                capture_output=True, text=True, timeout=30,
            ).stdout
        except Exception:
            wt = ""
        worktrees = [l.split(" ", 1)[1] for l in wt.splitlines() if l.startswith("worktree ")]
        linked = [Path(w) for w in worktrees if Path(w) != repo]

        no_logs, own_logs, own_nm, own_build = [], [], [], []
        for w in linked:
            wp = w / ".webpieces"
            (own_logs if (wp / "logs").is_dir() else no_logs).append(str(w))
            if (w / "node_modules").is_dir():
                own_nm.append(str(w))
            if (wp / "build.log").is_file():
                own_build.append(str(w))

        # Does the PRIMARY log contain calls whose command runs inside a worktree,
        # while the guard resolved root= to the primary tree?
        judged_as_primary = Counter()
        foreign_roots = Counter()
        shim_by_call = {}
        for f, ts, fields in iter_guard_rows(repo, "L0-shim", since):
            meta = kv(fields)
            _s, call = session_of(f)
            if meta.get("shim"):
                shim_by_call[call] = meta["shim"]

        shim_vs_root = Counter()
        for f, ts, fields in iter_guard_rows(repo, "L1-location", since):
            meta = kv(fields)
            root = meta.get("root", "")
            proj = meta.get("projectDir", "")
            cmd = fields[3] if len(fields) > 3 else ""
            _s, call = session_of(f)
            if root and root != str(repo):
                foreign_roots[root] += 1
            if root and proj and root != proj:
                shim_vs_root[f"root={root} projectDir={proj}"] += 1
            shim = shim_by_call.get(call)
            if shim and root and shim != root:
                shim_vs_root[f"L0 shim={shim} != L1 root={root}"] += 1
            m = WT_RE.search(cmd)
            if m and root and not root.startswith(m.group(1)):
                judged_as_primary[f"cmd in {m.group(1)} judged with root={root}"] += 1

        per_repo[repo.name] = {
            "repo": str(repo),
            "worktrees": len(worktrees),
            "linked_worktrees": [str(w) for w in linked],
            "worktrees_without_own_logs": no_logs,
            "worktrees_with_own_logs": own_logs,
            "worktrees_with_own_node_modules": own_nm,
            "worktrees_with_own_build_log": own_build,
            "primary_has_build_log": (repo / ".webpieces" / "build.log").is_file(),
            "foreign_roots_in_primary_log": top(foreign_roots, 6),
            "shim_vs_root_mismatch": top(shim_vs_root, 6),
            "worktree_cmds_judged_as_primary": top(judged_as_primary, 6),
        }

        if no_logs:
            findings.append({
                "severity": "MAJOR", "repo": repo.name,
                "what": "linked worktree has .webpieces/ but NO logs/ of its own",
                "detail": "Guard decisions for work done in these worktrees are written to the "
                          "PRIMARY tree's .webpieces/logs, so per-worktree attribution is lost and "
                          "concurrent agents interleave in one log.",
                "worktrees": no_logs[:8],
            })
        if judged_as_primary:
            findings.append({
                "severity": "MAJOR", "repo": repo.name,
                "what": "commands running INSIDE a worktree were judged against the primary tree",
                "detail": "L1 resolved root= to the primary clone for a command whose cwd is a "
                          "worktree — branch/stale-main verdicts describe the wrong tree.",
                "samples": top(judged_as_primary, 4),
            })
        if shim_vs_root:
            findings.append({
                "severity": "MAJOR", "repo": repo.name,
                "what": "L0 shim measured a different tree than L1 resolved",
                "detail": "The sh shim keys off $CLAUDE_PROJECT_DIR (primary tree) while L1 resolves "
                          "per call; the two layers disagree about which tree is being governed.",
                "samples": top(shim_vs_root, 4),
            })
        if own_build and (repo / ".webpieces" / "build.log").is_file():
            findings.append({
                "severity": "INFO", "repo": repo.name,
                "what": "build.log exists in BOTH the primary tree and worktrees",
                "detail": "Any doc naming a single build.log path is ambiguous; an agent in a "
                          "worktree that reads the primary path reads someone else's build.",
                "paths": own_build[:8],
            })

    return {"window_hours": hours, "per_repo": per_repo, "findings": findings}


# ---------------------------------------------------------------- transcripts

BUILD_RE = re.compile(
    r"(pnpm\s+wp-build|pnpm\s+run\s+build-all|nx\s+(?:run-many|affected|run)\b[^|;]*"
    r"(?::|-t\s+|--target[= ])(?:build|ci|test)|pnpm\s+exec\s+vitest\s+run|tsc\s+-b|npm\s+run\s+build)"
)
LOGREAD_RE = re.compile(r"(tail|head|sed\s+-n|grep|rg|cat|less|awk)\b[^|;&]*?([\w./-]*\.log)\b")
MUTATE_TOOLS = {"Edit", "Write", "NotebookEdit", "MultiEdit"}
MUTATE_BASH_RE = re.compile(r"^\s*(cat\s*>|tee\b|sed\s+-i|>\s*\S|git\s+(apply|checkout|revert|reset)|mv\b|cp\b|rm\b|patch\b|python3?\s)")
BLOCK_MARK_RE = re.compile(
    r"(\u274c|Fix Option \d|[a-z0-9]+(?:-[a-z0-9]+)*-guard\b|wp-ai-(?:guards|rules)-hook|whole-repo-build-guard"
    r"|trinary-version-skew|version-drift|InformAiError|RuleFailError|webpieces-disable"
    r"|requested permissions to use|Claude requested permissions)"
)


def _text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for c in content:
            if isinstance(c, dict):
                if c.get("type") == "text":
                    parts.append(c.get("text", ""))
                elif c.get("type") == "tool_result":
                    parts.append(_text_of(c.get("content")))
        return "\n".join(parts)
    return ""


def _codex_rollouts(since):
    """Every Codex rollout touched in the window, paired with the repo cwd it names.

    Codex stores sessions as `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` — flat by DATE, with
    no per-project directory, so unlike the Claude reader there is no path to glob for a repo. The
    repo is a FIELD (`session_meta.payload.cwd`) inside the file, which means selection costs one
    open per rollout. Cheap in practice: only the first `session_meta` record is needed, so the
    scan stops at it.
    """
    out = []
    if not CODEX_SESSIONS.is_dir():
        return out
    for f in CODEX_SESSIONS.glob("*/*/*/rollout-*.jsonl"):
        try:
            if datetime.fromtimestamp(f.stat().st_mtime, timezone.utc) < since:
                continue
            cwd = None
            with f.open(errors="replace") as fh:
                for line in fh:
                    if '"session_meta"' not in line:
                        continue
                    try:
                        row = json.loads(line)
                    except Exception:
                        continue
                    if row.get("type") == "session_meta":
                        cwd = ((row.get("payload") or {}).get("cwd")) or None
                        break
            if cwd:
                out.append((f, Path(cwd)))
        except OSError:
            continue
    return out


def _codex_repo_of(cwd: Path, repos):
    """Which audited repo this rollout ran in — the repo itself, or any worktree beneath it."""
    s = str(cwd)
    best = None
    for repo in repos:
        r = str(repo)
        if s == r or s.startswith(r + "/"):
            if best is None or len(r) > len(str(best)):
                best = repo
    return best


def audit_transcripts(repos, hours, max_sessions=400):
    since = cutoff(hours)
    sessions = []
    tool_hist = Counter()
    blocked_rules = Counter()

    files = []
    for repo in repos:
        for d in transcript_dirs_for(repo):
            for f in d.glob("*.jsonl"):
                try:
                    mt = datetime.fromtimestamp(f.stat().st_mtime, timezone.utc)
                except OSError:
                    continue
                if mt >= since:
                    files.append((repo, d, f, mt))
    files.sort(key=lambda x: -x[3].timestamp())
    files = files[:max_sessions]

    for repo, d, f, _mt in files:
        s = _scan_session(repo, d, f, since, tool_hist, blocked_rules)
        if s:
            sessions.append(s)

    # The Codex half. Same session shape, same counters, so every downstream aggregate works
    # unchanged and the harness is just another column.
    codex_seen = 0
    for f, cwd in _codex_rollouts(since):
        repo = _codex_repo_of(cwd, repos)
        if repo is None:
            continue
        codex_seen += 1
        if codex_seen > max_sessions:
            break
        s = _scan_codex_session(repo, f, since, tool_hist, blocked_rules)
        if s:
            sessions.append(s)

    def total(k):
        return round(sum(s[k] for s in sessions), 1)

    def by_harness():
        """Per-harness totals, so a Codex regression is judged against Codex's own volume.

        Kept as counts AND sessions: a rate computed over four Codex sessions is not comparable
        to one computed over four hundred Claude sessions, and the denominator is the only thing
        that says so.
        """
        out = {}
        for h in AI_HARNESSES:
            rows = [s for s in sessions if s.get("harness") == h]
            if not rows:
                continue
            out[h] = {
                "sessions": len(rows),
                "active_hours": round(sum(s["active_seconds"] for s in rows) / 3600, 1),
                "tool_seconds": round(sum(s["tool_seconds"] for s in rows), 1),
                "builds": sum(s["builds"] for s in rows),
                "redundant_builds": sum(s["redundant_builds"] for s in rows),
                "blocked_calls": sum(s["blocked_calls"] for s in rows),
                "blocked_seconds": round(sum(s["blocked_seconds"] for s in rows), 1),
                "error_calls": sum(s["error_calls"] for s in rows),
                "error_seconds": round(sum(s["error_seconds"] for s in rows), 1),
                "repeated_cmd_calls": sum(s["repeated_cmd_calls"] for s in rows),
            }
        return out

    worst_builds = sorted(sessions, key=lambda s: -s["redundant_builds"])[:12]
    worst_blocked = sorted(sessions, key=lambda s: -s["blocked_seconds"])[:12]
    worst_repeat = sorted(sessions, key=lambda s: -s["repeated_cmd_calls"])[:12]

    return {
        "window_hours": hours,
        "sessions_scanned": len(sessions),
        "sessions_by_harness": {h: sum(1 for s in sessions if s.get("harness") == h)
                                for h in AI_HARNESSES},
        "totals_by_harness": by_harness(),
        "totals": {
            "wall_hours_span": round(total("wall_seconds") / 3600, 1),
            "active_hours": round(total("active_seconds") / 3600, 1),
            "tool_seconds": total("tool_seconds"),
            "build_seconds": total("build_seconds"),
            "redundant_build_seconds": total("redundant_build_seconds"),
            "blocked_seconds": total("blocked_seconds"),
            "log_read_calls": sum(s["log_read_calls"] for s in sessions),
            "builds": sum(s["builds"] for s in sessions),
            "redundant_builds": sum(s["redundant_builds"] for s in sessions),
            "blocked_calls": sum(s["blocked_calls"] for s in sessions),
            "error_calls": sum(s["error_calls"] for s in sessions),
            "error_seconds": total("error_seconds"),
            "repeated_cmd_calls": sum(s["repeated_cmd_calls"] for s in sessions),
            "output_tokens": sum(s["output_tokens"] for s in sessions),
        },
        "tool_histogram": top(tool_hist, 18),
        "blocked_markers": top(blocked_rules, 15),
        "worst_redundant_builds": worst_builds,
        "worst_blocked_time": worst_blocked,
        "worst_repeated_commands": worst_repeat,
    }


def _scan_session(repo, d, path, since, tool_hist, blocked_rules):
    first = last = prev = None
    active_seconds = 0.0
    pending = {}            # tool_use_id -> (ts, tool, cmd)
    tool_seconds = build_seconds = redundant_build_seconds = blocked_seconds = 0.0
    builds = redundant_builds = blocked_calls = log_read_calls = error_calls = 0
    error_seconds = 0.0
    out_tokens = 0
    dirty = True            # has a file changed since the last build?
    cmd_counts = Counter()
    build_cmds = Counter()
    log_files = Counter()
    block_samples = []

    try:
        fh = path.open(errors="replace")
    except OSError:
        return None

    with fh:
        for line in fh:
            line = line.strip()
            if not line or not line.startswith("{"):
                continue
            try:
                row = json.loads(line)
            except Exception:
                continue
            ts = parse_ts(row.get("timestamp"))
            if ts and not in_window(ts):
                continue
            if ts:
                first = ts if first is None else min(first, ts)
                last = ts if last is None else max(last, ts)
                if prev is not None:
                    gap = (ts - prev).total_seconds()
                    if 0 < gap <= 300:
                        active_seconds += gap
                prev = ts
            typ = row.get("type")
            msg = row.get("message") or {}

            if typ == "assistant":
                u = msg.get("usage") or {}
                out_tokens += u.get("output_tokens", 0) or 0
                for c in msg.get("content") or []:
                    if not isinstance(c, dict) or c.get("type") != "tool_use":
                        continue
                    name = c.get("name", "?")
                    tool_hist[name] += 1
                    inp = c.get("input") or {}
                    cmd = inp.get("command") or inp.get("file_path") or inp.get("pattern") or ""
                    if isinstance(cmd, str):
                        cmd_counts[cmd.strip()[:200]] += 1
                    pending[c.get("id")] = (ts, name, cmd if isinstance(cmd, str) else "")

                    if name in MUTATE_TOOLS:
                        dirty = True
                    elif name == "Bash" and isinstance(cmd, str):
                        if BUILD_RE.search(cmd):
                            builds += 1
                            build_cmds[cmd.strip()[:120]] += 1
                            if not dirty:
                                redundant_builds += 1
                            dirty = False
                        elif MUTATE_BASH_RE.search(cmd):
                            dirty = True
                        m = LOGREAD_RE.search(cmd)
                        if m:
                            log_read_calls += 1
                            log_files[m.group(2)] += 1

            elif typ == "user":
                content = msg.get("content")
                items = content if isinstance(content, list) else []
                for c in items:
                    if not isinstance(c, dict) or c.get("type") != "tool_result":
                        continue
                    started, name, cmd = pending.pop(c.get("tool_use_id"), (None, "?", ""))
                    dur = (ts - started).total_seconds() if (ts and started) else 0.0
                    dur = max(0.0, min(dur, 3600.0))
                    tool_seconds += dur
                    txt = _text_of(c.get("content"))
                    errored = bool(c.get("is_error"))
                    # MCP payloads quote arbitrary prose; only a real error counts there.
                    guard_hit = (not name.startswith("mcp__")) and (
                        txt[:10].lstrip().startswith("\u274c")
                        or bool(BLOCK_MARK_RE.search(txt[:600]))
                    )
                    is_block = guard_hit
                    # A prompt the human declined or left sitting is HUMAN latency, not AI waste,
                    # and its `dur` is however long Dean took to answer. One 109-minute
                    # AskUserQuestion once accounted for 43% of the fleet's whole "failed call"
                    # time and made the top finding a measurement artifact. It is not an error.
                    human_wait = name == "AskUserQuestion" or txt.startswith(
                        "The user doesn't want to proceed")
                    if errored and not guard_hit and not human_wait:
                        error_calls += 1
                        error_seconds += dur
                    if is_block:
                        blocked_calls += 1
                        blocked_seconds += dur
                        marks = {m for m in BLOCK_MARK_RE.findall(txt[:600])
                                 if not m.startswith(("\u274c", "Fix Option"))}
                        for m in (marks or {"unclassified"}):
                            blocked_rules[m] += 1
                        if len(block_samples) < 3:
                            block_samples.append({"tool": name, "cmd": cmd[:120],
                                                  "excerpt": " ".join(txt.split())[:220]})
                    if name == "Bash" and BUILD_RE.search(cmd or ""):
                        build_seconds += dur
                        if redundant_builds and not is_block:
                            pass

    if first is None or last is None:
        return None
    # attribute redundant-build time by average build duration
    avg_build = (build_seconds / builds) if builds else 0.0
    redundant_build_seconds = avg_build * redundant_builds

    repeated = sum(n - 1 for n in cmd_counts.values() if n > 1)
    return {
        "repo": repo.name,
        "harness": AI_CLAUDE,
        "session": path.stem,
        "transcript": str(path),
        "started": first.isoformat(),
        "wall_seconds": (last - first).total_seconds(),
        "active_seconds": round(active_seconds, 1),
        "tool_seconds": round(tool_seconds, 1),
        "build_seconds": round(build_seconds, 1),
        "redundant_build_seconds": round(redundant_build_seconds, 1),
        "blocked_seconds": round(blocked_seconds, 1),
        "builds": builds,
        "redundant_builds": redundant_builds,
        "blocked_calls": blocked_calls,
        "error_calls": error_calls,
        "error_seconds": round(error_seconds, 1),
        "log_read_calls": log_read_calls,
        "top_log_files": top(log_files, 4),
        "top_build_cmds": top(build_cmds, 4),
        "repeated_cmd_calls": repeated,
        "top_repeated_cmds": [{"cmd": k, "n": v} for k, v in cmd_counts.most_common(4) if v > 1],
        "output_tokens": out_tokens,
        "block_samples": block_samples,
    }


# A Codex shell call arrives in the rollout as a `custom_tool_call` named `exec`, whose `input` is a
# JS snippet calling `tools.exec_command({"cmd": "...", ...})`. The command is the only field this
# reader needs, and pulling it with a regex avoids depending on the snippet staying one statement.
CODEX_EXEC_CMD_RE = re.compile(r'"cmd"\s*:\s*"((?:[^"\\]|\\.)*)"')


def _codex_text(output):
    """A tool output, which is a plain string on function calls and a content list on exec calls."""
    if isinstance(output, str):
        return output
    if isinstance(output, list):
        return "\n".join(c.get("text", "") for c in output
                         if isinstance(c, dict) and isinstance(c.get("text"), str))
    return ""


def _scan_codex_session(repo, path, since, tool_hist, blocked_rules):
    """The Codex twin of _scan_session, producing the identical session dict.

    Deliberately the same counters, so `totals_by_harness` is a like-for-like comparison rather
    than two metrics that merely share names. The differences are all in the wire format:

      * tool calls are `response_item` payloads — `custom_tool_call` (the `exec` shell tool) and
        `function_call` (namespaced tools like `collaboration.spawn_agent`), correlated to their
        outputs by `call_id` rather than by Claude's `tool_use_id`;
      * there is no `Read`/`Write`/`Edit` tool. A read is a shell `sed -n`/`cat`, and an edit is
        `apply_patch` — which is why the mutation test below looks at the COMMAND, not the tool
        name, or every Codex session would look like it never edited anything and every build
        would be scored redundant;
      * tool names are prefixed `codex:` in the histogram so the two harnesses' tools cannot be
        silently summed into one bar.
    """
    first = last = prev = None
    active_seconds = 0.0
    pending = {}
    tool_seconds = build_seconds = blocked_seconds = 0.0
    builds = redundant_builds = blocked_calls = log_read_calls = error_calls = 0
    error_seconds = 0.0
    dirty = True
    cmd_counts = Counter()
    build_cmds = Counter()
    log_files = Counter()
    block_samples = []
    session_id = path.stem

    try:
        fh = path.open(errors="replace")
    except OSError:
        return None

    with fh:
        for line in fh:
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                row = json.loads(line)
            except Exception:
                continue
            ts = parse_ts(row.get("timestamp"))
            if ts and not in_window(ts):
                continue
            if ts and ts < since:
                continue
            if ts:
                first = ts if first is None else min(first, ts)
                last = ts if last is None else max(last, ts)
                if prev is not None:
                    gap = (ts - prev).total_seconds()
                    if 0 < gap <= 300:
                        active_seconds += gap
                prev = ts

            payload = row.get("payload") or {}
            if row.get("type") != "response_item" or not isinstance(payload, dict):
                continue
            kind = payload.get("type")

            if kind in ("custom_tool_call", "function_call"):
                ns = payload.get("namespace") or ""
                name = (ns + payload.get("name", "?")) if ns else payload.get("name", "?")
                tool_hist["codex:" + name] += 1
                if kind == "custom_tool_call":
                    m = CODEX_EXEC_CMD_RE.search(payload.get("input") or "")
                    cmd = m.group(1).encode().decode("unicode_escape") if m else ""
                else:
                    cmd = payload.get("arguments") or ""
                cmd_counts[cmd.strip()[:200]] += 1
                pending[payload.get("call_id")] = (ts, name, cmd)

                if BUILD_RE.search(cmd):
                    builds += 1
                    build_cmds[cmd.strip()[:120]] += 1
                    if not dirty:
                        redundant_builds += 1
                    dirty = False
                elif "apply_patch" in cmd or MUTATE_BASH_RE.search(cmd):
                    dirty = True
                m = LOGREAD_RE.search(cmd)
                if m:
                    log_read_calls += 1
                    log_files[m.group(2)] += 1

            elif kind in ("custom_tool_call_output", "function_call_output"):
                started, name, cmd = pending.pop(payload.get("call_id"), (None, "?", ""))
                dur = (ts - started).total_seconds() if (ts and started) else 0.0
                dur = max(0.0, min(dur, 3600.0))
                tool_seconds += dur
                txt = _codex_text(payload.get("output"))
                # Codex has no `is_error` flag on the record, so a failed call is recognised the
                # same way a human would: the guard markers, or a non-zero exit the exec harness
                # prints. Anything less specific would count ordinary greps that found nothing.
                guard_hit = bool(BLOCK_MARK_RE.search(txt[:600]))
                errored = (not guard_hit) and bool(
                    re.search(r"exited with (?:code )?[1-9]|Exit code: [1-9]", txt[:600]))
                if guard_hit:
                    blocked_calls += 1
                    blocked_seconds += dur
                    marks = {m for m in BLOCK_MARK_RE.findall(txt[:600])
                             if not m.startswith(("❌", "Fix Option"))}
                    for m in (marks or {"unclassified"}):
                        blocked_rules[m] += 1
                    if len(block_samples) < 3:
                        block_samples.append({"tool": name, "cmd": cmd[:120],
                                              "excerpt": " ".join(txt.split())[:220]})
                elif errored:
                    error_calls += 1
                    error_seconds += dur
                if BUILD_RE.search(cmd or ""):
                    build_seconds += dur

    if first is None or last is None:
        return None
    avg_build = (build_seconds / builds) if builds else 0.0
    repeated = sum(n - 1 for n in cmd_counts.values() if n > 1)
    return {
        "repo": repo.name,
        "harness": AI_CODEX,
        "session": session_id,
        "transcript": str(path),
        "started": first.isoformat(),
        "wall_seconds": (last - first).total_seconds(),
        "active_seconds": round(active_seconds, 1),
        "tool_seconds": round(tool_seconds, 1),
        "build_seconds": round(build_seconds, 1),
        "redundant_build_seconds": round(avg_build * redundant_builds, 1),
        "blocked_seconds": round(blocked_seconds, 1),
        "builds": builds,
        "redundant_builds": redundant_builds,
        "blocked_calls": blocked_calls,
        "error_calls": error_calls,
        "error_seconds": round(error_seconds, 1),
        "log_read_calls": log_read_calls,
        "top_log_files": top(log_files, 4),
        "top_build_cmds": top(build_cmds, 4),
        "repeated_cmd_calls": repeated,
        "top_repeated_cmds": [{"cmd": k, "n": v} for k, v in cmd_counts.most_common(4) if v > 1],
        # Codex rollouts carry token counts on `event_msg`/`token_count` records rather than on
        # each assistant turn. Reported as 0 rather than guessed at — see SKILL.md.
        "output_tokens": 0,
        "block_samples": block_samples,
    }


# ---------------------------------------------------------------- skew

PIN_RE = re.compile(r"@webpieces/nx-webpieces-rules['\"]?\s*:\s*['\"]?\^?([0-9][\w.-]*)")


def _pin_of(repo: Path):
    pins = {}
    ws = repo / "pnpm-workspace.yaml"
    if ws.is_file():
        m = PIN_RE.search(ws.read_text(errors="replace"))
        if m:
            pins["pnpm-workspace.yaml"] = m.group(1)
    pkg = repo / "package.json"
    if pkg.is_file():
        try:
            j = json.loads(pkg.read_text(errors="replace"))
            for block in ("dependencies", "devDependencies"):
                v = (j.get(block) or {}).get("@webpieces/nx-webpieces-rules")
                if v:
                    pins[f"package.json:{block}"] = v
        except Exception:
            pass
    return pins


def _installed_of(root: Path):
    p = root / "node_modules" / "@webpieces" / "nx-webpieces-rules" / "package.json"
    if p.is_file():
        try:
            return json.loads(p.read_text(errors="replace")).get("version")
        except Exception:
            return "unreadable"
    return None


def audit_skew(repos, check_npm=True):
    latest = None
    if check_npm:
        try:
            latest = subprocess.run(
                ["npm", "view", "@webpieces/nx-webpieces-rules", "version"],
                capture_output=True, text=True, timeout=60,
            ).stdout.strip() or None
        except Exception:
            latest = None

    rows, findings = [], []
    for repo in repos:
        pins = _pin_of(repo)
        installed = _installed_of(repo)
        try:
            wt = subprocess.run(["git", "-C", str(repo), "worktree", "list", "--porcelain"],
                                capture_output=True, text=True, timeout=30).stdout
            trees = [l.split(" ", 1)[1] for l in wt.splitlines() if l.startswith("worktree ")]
        except Exception:
            trees = [str(repo)]
        try:
            behind = subprocess.run(
                ["git", "-C", str(repo), "rev-list", "--count", "HEAD..origin/main"],
                capture_output=True, text=True, timeout=30).stdout.strip()
        except Exception:
            behind = "?"
        row = {
            "repo": str(repo),
            "pins": pins,
            "installed_primary": installed,
            "commits_behind_origin_main": behind,
            "worktree_installs": {t: _installed_of(Path(t)) for t in trees if Path(t) != repo},
        }
        rows.append(row)

        # "catalog:" / "workspace:*" are indirections, not versions — the real pin
        # is the catalog entry in pnpm-workspace.yaml, already captured above.
        pinvals = {v.lstrip("^~") for v in pins.values()
                   if re.match(r"^[\^~]?\d", v)}
        if installed and pinvals and installed not in pinvals:
            findings.append({"severity": "MAJOR", "repo": repo.name,
                             "what": "installed @webpieces != pinned",
                             "detail": f"installed {installed}, pinned {sorted(pinvals)} — "
                                       f"pnpm install has not been run for the current pin"})
        for t, v in row["worktree_installs"].items():
            if v and installed and v != installed:
                findings.append({"severity": "MAJOR", "repo": repo.name,
                                 "what": "worktree governed by a different release than the primary tree",
                                 "detail": f"{t} has {v}, primary has {installed} — guards BLOCK on trinary-version-skew"})
        if latest and installed and installed != latest:
            findings.append({"severity": "MINOR", "repo": repo.name,
                             "what": "behind latest published @webpieces",
                             "detail": f"installed {installed}, npm latest {latest}"})
    return {"npm_latest": latest, "rows": rows, "findings": findings}


# ---------------------------------------------------------------- doc drift

PATHISH = re.compile(r"`([^`\n]{3,120})`")
SKIP_CHARS = set("<>*{}$|?()[]")


NEGATED = re.compile(r"(does not exist|doesn't exist|never|not a lookup|no longer|does not resolve"
                     r"|silently greps nothing|is wrong|instead of)", re.I)


def _candidate_paths(text):
    lines = text.splitlines()
    for m in PATHISH.finditer(text):
        tok = m.group(1).strip()
        # A doc may name a path precisely to say it is NOT there ("a relative
        # `.webpieces/build.log` in the worktree does not exist at all"). Flagging that
        # as drift punishes the doc for being correct — check the surrounding sentence.
        line_no = text.count("\n", 0, m.start())
        window = " ".join(lines[max(0, line_no - 1):line_no + 2])
        if NEGATED.search(window):
            continue
        if any(c in tok for c in SKIP_CHARS) or " " in tok:
            continue
        if not ("/" in tok or tok.startswith(".")):
            continue
        if tok.startswith(("http", "@", "-")) or tok.endswith("/"):
            continue
        # a bare extension (".ts", ".spec.ts") is prose, not a path
        if "/" not in tok and not tok.startswith(".webpieces"):
            continue
        yield tok


EXCLUDE_DIR = re.compile(r"/(node_modules|dist|\.git|worktrees)/")
LOGCLAIM_RE = re.compile(r"`?([\w./$~{}-]*build\.log[\w.]*)`?")


def _docs_of(repo: Path):
    docs = [repo / "CLAUDE.md"]
    docs += sorted((repo / ".webpieces" / "instruct-ai").glob("*.md"))
    docs += [d for d in sorted((repo / ".claude").rglob("*.md"))
             if not EXCLUDE_DIR.search(str(d))]
    return [d for d in docs if d.is_file()]


def _origin_main_tree(repo: Path):
    """Files tracked on origin/main, and a reader for their content.

    Auditing the WORKING TREE reports problems that main already fixed — the exact
    "reading a stale main" failure the guards exist to prevent. Tracked docs are read
    from origin/main; untracked ones (.webpieces/instruct-ai is generated per release)
    fall back to disk.
    """
    try:
        out = subprocess.run(["git", "-C", str(repo), "ls-tree", "-r", "--name-only", "origin/main"],
                             capture_output=True, text=True, timeout=60)
        files = set(out.stdout.splitlines()) if out.returncode == 0 else set()
    except Exception:
        files = set()
    try:
        behind = subprocess.run(["git", "-C", str(repo), "rev-list", "--count", "HEAD..origin/main"],
                                capture_output=True, text=True, timeout=30).stdout.strip()
    except Exception:
        behind = "?"
    return files, behind


def _read_doc(repo: Path, doc: Path, tracked: set):
    rel = str(doc.relative_to(repo)) if str(doc).startswith(str(repo)) else None
    if rel and rel in tracked:
        try:
            out = subprocess.run(["git", "-C", str(repo), "show", f"origin/main:{rel}"],
                                 capture_output=True, text=True, timeout=30)
            if out.returncode == 0:
                return out.stdout, "origin/main"
        except Exception:
            pass
    try:
        return doc.read_text(errors="replace"), "worktree"
    except OSError:
        return "", "unreadable"


def audit_docdrift(repos):
    findings, log_claims = [], []
    scanned = 0
    user_docs = [Path.home() / ".claude" / "CLAUDE.md"]
    user_docs += sorted((Path.home() / ".claude" / "skills").rglob("SKILL.md"))

    # A user-level doc (~/.claude/**) is repo-agnostic: scanning it once per repo would
    # report the same relative path N times. Judge those separately, at the end.
    user_missing = defaultdict(set)
    doc_sources = {}
    for repo in repos:
        tracked, behind = _origin_main_tree(repo)
        doc_sources[repo.name] = {"behind_origin_main": behind, "tracked_docs_read_from": "origin/main"}
        docs = _docs_of(repo)
        # where build logs ACTUALLY are, in this tree and every worktree
        actual = []
        try:
            wtout = subprocess.run(["git", "-C", str(repo), "worktree", "list", "--porcelain"],
                                   capture_output=True, text=True, timeout=30).stdout
            trees = [Path(l.split(" ", 1)[1]) for l in wtout.splitlines() if l.startswith("worktree ")]
        except Exception:
            trees = [repo]
        for t in trees:
            for cand in (t / ".webpieces").glob("build.log*"):
                actual.append(str(cand))
        # webpieces also writes PER-WORKTREE build logs under .webpieces/worktrees/<agent>/,
        # which is NOT a git worktree path — so the git worktree list above never sees them.
        # A doc naming only the top-level path is wrong for every build done in a worktree.
        for cand in (repo / ".webpieces" / "worktrees").glob("*/build.log*"):
            actual.append(str(cand))

        claimed = Counter()
        for doc in docs:
            scanned += 1
            text, src = _read_doc(repo, doc, tracked)
            if not text:
                continue
            for m in LOGCLAIM_RE.finditer(text):
                tok = m.group(1)
                if tok and not tok.startswith(("<", "$")):
                    claimed[tok] += 1

            missing = []
            for tok in set(_candidate_paths(text)):
                cand = tok[2:] if tok.startswith("./") else tok
                # `~/...` is a real, resolvable path — the machine-global build ledger
                # (`~/.webpieces/builds.log`) is named by every repo's buildlog doc, and
                # without this expansion every one of them reads as doc drift.
                if (repo / cand).exists() or Path(cand).exists() or cand in tracked \
                        or Path(os.path.expanduser(cand)).exists():
                    continue
                if re.search(r"\.(log|json|md|ts|js|yaml|yml|html|sh|txt)$", cand) or cand.startswith(".webpieces/"):
                    missing.append(cand)
            if missing and str(doc).startswith(str(Path.home() / ".claude")):
                for m in missing:
                    user_missing[str(doc)].add(m)
                continue
            if missing:
                agent_nav = [m for m in missing
                             if m.startswith((".webpieces/", ".claude/")) or m.endswith(".log")]
                findings.append({
                    "severity": "MAJOR" if agent_nav else "MINOR",
                    "repo": repo.name,
                    "doc": str(doc),
                    "paths_named_but_absent": sorted(agent_nav or missing)[:20],
                    "why": "An agent following this doc will read a path that does not exist."
                           if agent_nav else "Doc names a file that is missing or is relative to another root.",
                })

        unresolvable = sorted(
            t for t in claimed
            if not any(a.endswith(t.lstrip("./")) for a in actual)
            and not (repo / t.lstrip("./")).exists()
        )
        log_claims.append({
            "repo": repo.name,
            "build_logs_on_disk": actual,
            "paths_named_in_docs": sorted(claimed),
            "named_but_resolvable_to_nothing": unresolvable,
        })
        if unresolvable and actual:
            findings.append({
                "severity": "MAJOR",
                "repo": repo.name,
                "doc": "(build.log path claims across CLAUDE.md / instruct-ai / skills)",
                "paths_named_but_absent": unresolvable[:10],
                "why": f"Docs send the agent to a build log that is not there; the real ones are {actual[:4]}. "
                       f"This is the read-the-wrong-log failure mode: the agent re-runs the build instead.",
            })

    for doc in user_docs:
        if not doc.is_file():
            continue
        scanned += 1
        try:
            text = doc.read_text(errors="replace")
        except OSError:
            continue
        absent_everywhere = []
        for tok in set(_candidate_paths(text)):
            cand = tok[2:] if tok.startswith("./") else tok
            if not (re.search(r"\.(log|json|md|ts|js|yaml|yml|html|sh|txt)$", cand)
                    or cand.startswith(".webpieces/")):
                continue
            if Path(cand).exists() or any((r / cand).exists() for r in repos):
                continue
            absent_everywhere.append(cand)
        if absent_everywhere:
            findings.append({
                "severity": "MINOR",
                "repo": "(user-level)",
                "doc": str(doc),
                "paths_named_but_absent": sorted(absent_everywhere)[:20],
                "why": "Named in a user-level doc and present in none of the audited repos. "
                       "Repo-agnostic docs legitimately name paths that only some trees have — "
                       "confirm before treating as drift.",
            })

    findings.sort(key=lambda f: 0 if f["severity"] == "MAJOR" else 1)
    return {"docs_scanned": scanned, "doc_sources": doc_sources,
            "build_log_claims": log_claims, "findings": findings}


# ---------------------------------------------------------------- matrix conformance

MATRIX_FILES = {
    "L2": "webpieces.branch-state-matrix.md",
    "L0": "webpieces.guard-matrix.md",
    # L1 has its own matrix and always did. Omitting it here did not report "L1 is undocumented" —
    # it reported the OPPOSITE of the truth, "a layer emitting row numbers no matrix defines", on
    # every repo at once. A layer missing from this dict is indistinguishable from a layer with no
    # matrix, so ADD the layer here before believing that finding about it.
    "L1": "webpieces.location-matrix.md",
}
ACT_RE = re.compile(r"\b(allow|block|exempt|pass|deny)\b", re.I)
# decision token in the logs -> family
DECISION_FAMILY = {
    "ALLOW": "allow", "ALLOW_EXEMPT": "exempt", "ALLOW_FAIL_OPEN": "failopen",
    "BLOCK_AI_CURE": "block", "BLOCK": "block", "DENY": "block",
    "PASS-BIN-ALLOW": "allow", "PASS": "allow",
}


def _parse_md_tables(path: Path):
    """The CANONICAL numbered table of a matrix doc.

    These docs hold SEVERAL numbered tables — the normative one (`# | tools | state | act |
    cure`) and later illustrative ones (`# | what you SEE | ... | verdict | Fix`) that reuse the
    same row numbers for different content. Merging them silently invents thousands of
    mismatches, so parse each table separately and return only the normative one.
    """
    tables = []
    if not path.is_file():
        return {}
    header, cur = None, {}
    for line in path.read_text(errors="replace").splitlines():
        line = line.strip()
        if not line.startswith("|"):
            if cur:
                tables.append((header, cur))
                header, cur = None, {}
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if not cells:
            continue
        if set(cells[0]) <= {"-", ":"} and cells[0]:
            continue
        if cells[0] in ("#", "code"):
            if cur:
                tables.append((header, cur))
            header, cur = [c.lower() for c in cells], {}
            continue
        if header is None or not re.match(r"^\d+$", cells[0]):
            continue
        rec = dict(zip(header, cells))
        act = ""
        for key in ("act", "outcome", "verdict"):
            if rec.get(key):
                m = ACT_RE.search(rec[key])
                if m:
                    act = m.group(1).lower()
                    break
        cur[int(cells[0])] = {
            "act": act,
            "cure": (rec.get("cure") or rec.get("fix") or "").strip("` "),
            "state": (rec.get("state") or rec.get("what you see (exact symptom)") or "")[:120],
        }
    if cur:
        tables.append((header, cur))
    if not tables:
        return {}
    # normative table = the one with an explicit "act" column; else the largest.
    for hdr, tbl in tables:
        if hdr and "act" in hdr:
            return tbl
    for hdr, tbl in tables:
        if hdr and "outcome" in hdr:
            return tbl
    return max((t for _h, t in tables), key=len)


def _parse_fault_codes(path: Path):
    codes = set()
    if not path.is_file():
        return codes
    for line in path.read_text(errors="replace").splitlines():
        if not line.strip().startswith("|"):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if cells and re.match(r"^`[A-Z]`$", cells[0]):
            codes.add(cells[0].strip("`"))
    return codes


def audit_matrix(repos, hours):
    since = cutoff(hours)
    out = {"window_hours": hours, "per_repo": {}, "findings": []}

    for repo in repos:
        instruct = repo / ".webpieces" / "instruct-ai"
        matrices = {layer: _parse_md_tables(instruct / fn) for layer, fn in MATRIX_FILES.items()}
        fault_codes = _parse_fault_codes(instruct / MATRIX_FILES["L0"])
        if not any(matrices.values()):
            continue

        rows_seen = defaultdict(Counter)      # layer -> row -> n
        mismatches = Counter()
        cure_mismatch = Counter()
        unknown_rows = Counter()
        unknown_faults = Counter()
        layers_without_matrix = Counter()
        samples = []

        for subdir in ("L1-location", "L2-decisions"):
            seen_dedupe = {}
            for f, ts, fields in iter_guard_rows(repo, subdir, since):
                if len(fields) < 3:
                    continue
                meta = kv(fields)
                layer = meta.get("layer", "")
                row = meta.get("row", "")
                decision = fields[1]
                cmd = fields[3] if len(fields) > 3 else ""
                rule = fields[5] if len(fields) > 5 else "-"
                key = (decision, rule, cmd, layer, row)
                prev = seen_dedupe.get(key)
                if prev is not None and abs((ts - prev).total_seconds()) <= 3:
                    seen_dedupe[key] = ts
                    continue
                seen_dedupe[key] = ts

                if not row.isdigit():
                    continue
                rownum = int(row)
                rows_seen[layer][rownum] += 1
                fault = meta.get("fault", "-")
                if fault not in ("-", "") and fault_codes and fault not in fault_codes:
                    unknown_faults[f"{fault} (layer {layer})"] += 1

                table = matrices.get(layer) or {}
                if not table:
                    layers_without_matrix[layer] += 1
                    continue
                spec = table.get(rownum)
                if spec is None:
                    unknown_rows[f"{layer} row {rownum}"] += 1
                    continue
                fam = DECISION_FAMILY.get(decision, decision.lower())
                want = spec["act"]
                want = "allow" if want == "pass" else want
                if want and fam != want and not (want == "allow" and fam in ("exempt", "failopen")):
                    mismatches[f"{layer} row {rownum}: matrix says {want}, log says {decision}"] += 1
                    if len(samples) < 6:
                        samples.append({"layer": layer, "row": rownum, "matrix_act": want,
                                        "logged": decision, "rule": rule,
                                        "state": spec["state"], "cmd": cmd[:120],
                                        "ts": ts.isoformat()})
                logged_cure = meta.get("cure", "-")
                if (spec["cure"] and logged_cure not in ("-", "")
                        and spec["cure"].split()[0] not in logged_cure):
                    cure_mismatch[f"{layer} row {rownum}: matrix '{spec['cure'][:60]}' vs log '{logged_cure[:60]}'"] += 1

        exercised = {layer: sorted(c) for layer, c in rows_seen.items()}
        never = {layer: sorted(set(tbl) - set(rows_seen.get(layer, {})))
                 for layer, tbl in matrices.items() if tbl}
        out["per_repo"][repo.name] = {
            "matrix_rows_parsed": {k: len(v) for k, v in matrices.items()},
            "fault_codes_documented": sorted(fault_codes),
            "rows_exercised": exercised,
            "rows_never_exercised": never,
            "decision_vs_matrix_mismatch": top(mismatches, 8),
            "rows_logged_not_in_matrix": top(unknown_rows, 8),
            "fault_codes_not_in_matrix": top(unknown_faults, 8),
            "cure_text_mismatch": top(cure_mismatch, 6),
            "layers_logged_without_a_matrix_table": top(layers_without_matrix, 6),
        }
        if layers_without_matrix:
            out["findings"].append({
                "severity": "MAJOR", "repo": repo.name,
                "what": "a guard layer emits row numbers but has no matrix table to look them up in",
                "detail": "Rows are cited in the logs for this layer, but no instruct-ai matrix "
                          "defines them — the cited row is unlookupable for a human or an agent.",
                "counts": top(layers_without_matrix, 6),
            })
        if mismatches:
            out["findings"].append({
                "severity": "MAJOR", "repo": repo.name,
                "what": "guard decision disagrees with the matrix row it cites",
                "detail": "The log says the guard landed on row N, but the matrix says row N should "
                          "produce a different verdict. Either the matrix is stale or the guard is "
                          "misrouting — both make the documented behaviour unreliable.",
                "samples": samples[:6], "counts": top(mismatches, 6),
            })
        if unknown_rows:
            out["findings"].append({
                "severity": "MAJOR", "repo": repo.name,
                "what": "guard logged a row number the matrix does not define",
                "detail": "An agent that looks up the cited row finds nothing.",
                "counts": top(unknown_rows, 6),
            })
        if unknown_faults:
            out["findings"].append({
                "severity": "MAJOR", "repo": repo.name,
                "what": "fault code emitted but not documented in the guard matrix",
                "counts": top(unknown_faults, 6),
            })
        if cure_mismatch:
            out["findings"].append({
                "severity": "MINOR", "repo": repo.name,
                "what": "cure text in the log differs from the matrix cure for that row",
                "counts": top(cure_mismatch, 6),
            })
    return out


# ---------------------------------------------------------------- 3-point merges

MERGE_STUCK_HOURS = 24


def audit_merges(repos, hours):
    since = cutoff(hours)
    out = {"window_hours": hours, "per_repo": {}, "findings": []}

    for repo in repos:
        mi = repo / ".webpieces" / "merge-info"
        idx_path = mi / "index.json"
        idx = {}
        if idx_path.is_file():
            try:
                idx = json.loads(idx_path.read_text(errors="replace"))
            except Exception:
                idx = {}

        remerged, conflicted, threeway = [], [], []
        for bucket in ("merged", "staged"):
            for branch, rec in (idx.get(bucket) or {}).items():
                merges = rec.get("merges") or []
                n = max([m.get("n", 1) for m in merges], default=0)
                confs = sorted({c for m in merges for c in (m.get("conflicts") or [])})
                if n >= 2:
                    remerged.append({"bucket": bucket, "branch": branch, "merge_rounds": n,
                                     "pr": rec.get("pr")})
                if confs:
                    conflicted.append({"bucket": bucket, "branch": branch,
                                       "conflict_files": confs[:8], "pr": rec.get("pr")})
                if any(m.get("threeWay") for m in merges):
                    threeway.append({"bucket": bucket, "branch": branch, "pr": rec.get("pr")})

        # A staged DIR is only a stuck merge if index.json still tracks it as staged.
        # Dirs with no index entry are finished-merge litter — noisy, not broken.
        stuck, orphan_dirs = [], []
        tracked_staged = set((idx.get("staged") or {}).keys())
        staged_dir = mi / "staged"
        if staged_dir.is_dir():
            for d in staged_dir.iterdir():
                if not d.is_dir():
                    continue
                try:
                    age_h = (datetime.now(timezone.utc)
                             - datetime.fromtimestamp(d.stat().st_mtime, timezone.utc)).total_seconds() / 3600
                except OSError:
                    continue
                if d.name in tracked_staged:
                    if age_h >= MERGE_STUCK_HOURS:
                        stuck.append({"branch": d.name, "age_hours": round(age_h, 1)})
                else:
                    orphan_dirs.append({"branch": d.name, "age_hours": round(age_h, 1)})

        # branch-mutations.log: conflicts that never reached FINALIZE
        events = defaultdict(list)
        outcomes = Counter()
        log = repo / ".webpieces" / "logs" / "branch-mutations.log"
        if log.is_file():
            for line in log.read_text(errors="replace").splitlines():
                fields = tsv(line)
                if len(fields) < 3:
                    continue
                ts = row_ts(fields[0])
                if ts is None or ts < since:
                    continue
                tool, ev = fields[1], fields[2]
                outcomes[f"{tool} {ev}"] += 1
                m = re.search(r"(?:branch|from)=([^\s\t]+)", line)
                events[m.group(1) if m else "-"].append((ts, tool, ev, line))

        # CONFLICT rows have no branch= field, so per-branch grouping cannot see the
        # FINALIZE that resolves them. Judge chronologically: is the LAST conflict
        # followed by any finalize at all?
        all_evs = sorted((e for evs in events.values() for e in evs), key=lambda e: e[0])
        unresolved = []
        conflicts = [e for e in all_evs if e[2] == "CONFLICT"]
        if conflicts:
            last_conf = conflicts[-1]
            after = [e for e in all_evs if e[0] > last_conf[0] and e[2] in ("FINALIZE", "END")]
            if not any(e[2] == "FINALIZE" for e in after):
                unresolved.append({"at": last_conf[0].isoformat(),
                                   "detail": last_conf[3][:200],
                                   "events_after": [e[2] for e in after][:5]})

        out["per_repo"][repo.name] = {
            "index_present": idx_path.is_file(),
            "merged_branches": len(idx.get("merged") or {}),
            "staged_branches": len(idx.get("staged") or {}),
            "branches_merged_more_than_once": remerged[:10],
            "merges_with_conflicts": conflicted[:10],
            "three_way_merges": threeway[:10],
            "staged_but_never_finalized": stuck[:10],
            "orphan_staged_dirs_not_in_index": orphan_dirs[:10],
            "conflict_without_finalize": unresolved[:10],
            "mutation_events": dict(outcomes),
        }
        if stuck:
            out["findings"].append({
                "severity": "MAJOR", "repo": repo.name,
                "what": f"staged 3-point merge never finalized (>{MERGE_STUCK_HOURS}h)",
                "detail": "wp-start-upsert-pr staged a merge that no wp-finish/review ever completed. "
                          "The branch keeps drifting from main while guards treat it as mid-merge.",
                "items": stuck[:8],
            })
        if unresolved:
            out["findings"].append({
                "severity": "MAJOR", "repo": repo.name,
                "what": "CONFLICT logged with no FINALIZE after it",
                "detail": "The merge hit a conflict and the branch-mutation trail stops there.",
                "items": unresolved[:8],
            })
        heavy = [r for r in remerged if r["merge_rounds"] >= 3]
        if heavy:
            out["findings"].append({
                "severity": "MAJOR", "repo": repo.name,
                "what": "branches re-merged from main 3+ times",
                "detail": "Each 3-point update round is a full re-verify and re-review cycle. Two "
                          "rounds is normal for a long-lived branch; three or more is churn.",
                "items": heavy[:8],
            })
    return out


# ---------------------------------------------------------------- main


def resolve_repos(patterns):
    out = []
    for pat in patterns:
        p = Path(os.path.expanduser(pat))
        if (p / ".git").exists():
            out.append(p.resolve())
    return sorted(set(out))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["guards", "isolation", "transcripts", "parity", "skew",
                                    "docdrift", "matrix", "merges", "all"])
    ap.add_argument("--repos", nargs="+", required=True)
    ap.add_argument("--since", default=None,
                    help="window START, ISO-8601 UTC. Overrides --hours. Preferred for reports.")
    ap.add_argument("--until", default=None,
                    help="window END, ISO-8601 UTC. Defaults to now. Required to audit a CLOSED "
                         "period, otherwise the window runs on past the one you asked for.")
    ap.add_argument("--hours", type=float, default=168.0)
    ap.add_argument("--max-sessions", type=int, default=400)
    ap.add_argument("--no-npm", action="store_true")
    args = ap.parse_args()

    global WINDOW_START, WINDOW_END

    def _iso(v):
        d = datetime.fromisoformat(v.replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)

    if args.since:
        WINDOW_START = _iso(args.since)
    if args.until:
        WINDOW_END = _iso(args.until)

    repos = resolve_repos(args.repos)
    if not repos:
        print(json.dumps({"error": "no git repos matched", "given": args.repos}))
        return 1

    res = {"repos": [str(r) for r in repos], "generated": datetime.now(timezone.utc).isoformat(),
           "window_start_utc": (WINDOW_START or cutoff(args.hours)).isoformat(),
           "window_end_utc": (WINDOW_END or datetime.now(timezone.utc)).isoformat()}
    if args.cmd in ("guards", "all"):
        res["guards"] = audit_guards(repos, args.hours)
    if args.cmd in ("isolation", "all"):
        res["isolation"] = audit_isolation(repos, args.hours)
    if args.cmd in ("transcripts", "all"):
        res["transcripts"] = audit_transcripts(repos, args.hours, args.max_sessions)
    if args.cmd in ("parity", "all"):
        res["codex_parity"] = audit_parity(repos, args.hours)
    if args.cmd in ("skew", "all"):
        res["skew"] = audit_skew(repos, check_npm=not args.no_npm)
    if args.cmd in ("docdrift", "all"):
        res["docdrift"] = audit_docdrift(repos)
    if args.cmd in ("matrix", "all"):
        res["matrix"] = audit_matrix(repos, args.hours)
    if args.cmd in ("merges", "all"):
        res["merges"] = audit_merges(repos, args.hours)
    json.dump(res, sys.stdout, indent=1, default=str)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
