#!/usr/bin/env bash
# wp-await — wait for a condition in ONE tool call instead of one call per check.
#
# ─── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────────
# An agent waiting for CI used to run `gh pr checks <n>` — or `echo .` — over and over. Each of those
# is a separate API call that resends the agent's ENTIRE conversation. Measured at ~557,000 tokens
# per turn: one run spent 666 turns and 465M tokens printing a full stop, and across the fleet in the
# 24h to 2026-09-07, 18.3% of ALL tokens went to turns that did nothing.
#
# Polling is not the problem. ONE API CALL PER POLL is the problem. The loop moves in here, where a
# poll costs nothing.
#
# ─── HOW TO RUN IT: DEPENDS ON WHICH HARNESS YOU ARE ──────────────────────────────────────────────
#
#   CLAUDE CODE  ->  FOREGROUND, `--timeout 545`, and re-run on exit 2.
#       Pass the Bash tool `timeout: 600000` and do NOT set run_in_background. On exit 2, run the
#       IDENTICAL command again. A ~13-minute CI run costs about 2 calls this way.
#
#       ‼️ DO NOT BACKGROUND-AND-STOP. That was this script's advice until 2026-09-11 and it is
#       WRONG: the harness does not reliably re-invoke a stopped subagent when its background job
#       exits. Measured in deanhiller/webpieces-ts#900 — three stalls across two subagents in one
#       session, each of which HAD launched this script with run_in_background: true exactly as
#       instructed. Every task-notification read "stopped with no live background children of its
#       own". Nothing ever woke them; the runs made zero further progress until a human poked them.
#       A stop costs only ~650 tokens, so backgrounding is cheap — the damage is that the run does
#       not finish. Foregrounding costs ~2 context resends per 19-minute wait and does finish.
#       (The earlier "449 subagents were woken exactly this way" measurement is not in dispute; it
#       is simply not reliable enough to build the contract on. Revert to background-and-stop if
#       the harness behaviour is fixed.)
#
#   CODEX        ->  FOREGROUND, `--timeout 245`, and re-run on exit 2.
#       Codex's execution tool exposes NO completion notification, so there is nothing to wake you —
#       background is not an option. `write_stdin` waits at most 300s per call (`exec_command` only
#       STARTS a command and yields within 30s), so 245 leaves margin under that ceiling.
#       A ~13-minute CI run costs about 4 calls this way.
#
#   (Claude's foreground cap is 600s: measured, passing 700000 is accepted and then the call is
#    DEMOTED to background at exactly 600s — the command survives and finishes, you just lose the
#    result. That is why Claude's --timeout is 545. Both caps are configurable —
#    BASH_MAX_TIMEOUT_MS on Claude, per-call yield_time_ms on Codex — but do not rely on that.)
#
# Real CI is longer than either ceiling, which is why exit 2 exists:
#
#     deanhiller/webpieces-ts   CI  p50 783s   p90 869s   max  869s
#     ctoteachings/monorepo     CI  p50 723s   p90 958s   max 1050s
#
# Against ~260 calls for checking by hand every 3 seconds, this is ~2 calls on Claude and ~4 on Codex.
#
# ─── THE TIMEOUT IS A CALL CEILING, NOT A WAIT ────────────────────────────────────────────────────
# This exits the MOMENT the condition is met, so --timeout never makes you wait longer. It only says
# how long ONE call may block before handing you an exit 2 that means "run me again". Set it just
# under your harness's cap (Claude 545, Codex 245); there is nothing to gain from tuning it per
# project, and setting it ABOVE the cap is worse than useless — the harness cuts the call off and
# you lose the result.
#
# ─── THREE OUTCOMES, NOT TWO ──────────────────────────────────────────────────────────────────────
# A wait with only a success test blocks for the whole timeout when the thing has already FAILED —
# half an hour spent waiting for a CI run that went red in 90 seconds. So failure is a first-class
# exit:
#
#     exit 0   SUCCESS       --until matched, or --while stopped matching
#     exit 1   FAILED        --fail matched. Stop waiting, read the output, go fix it.
#     exit 2   STILL WAITING timed out. Run the identical command again.
#     exit 3   usage error
#
# Predicates are extended regexes (grep -E) matched against combined stdout+stderr.
#
# ─── USAGE ────────────────────────────────────────────────────────────────────────────────────────
#   wp-await.sh --run '<command>' [--until <re>] [--while <re>] [--fail <re>]
#               [--timeout <secs>] [--interval <secs>] [--label <text>]
#
#     --until   succeed when output MATCHES this
#     --while   succeed when output STOPS matching this   (the right one for "wait while pending")
#     --fail    abort with exit 1 when output matches this
#
# ─── RECIPES ──────────────────────────────────────────────────────────────────────────────────────
#   CI on a PR — FOREGROUND, succeed when nothing is pending, bail the moment anything fails:
#     wp-await.sh --run 'gh pr checks 879' --while 'pending' \
#                 --fail 'fail|cancel|timed_out' --timeout 545 --label 'CI #879'    # Codex: --timeout 245
#
#   The PR actually landing (CD gate):
#     wp-await.sh --run 'gh pr view 879 --json state -q .state' --until 'MERGED' \
#                 --fail 'CLOSED' --timeout 545 --label 'merge #879'
#
#   A GitHub Actions run by id:
#     wp-await.sh --run 'gh run view 1234 --json status -q .status' --until 'completed' \
#                 --timeout 545 --label 'run 1234'
#
#   A deploy coming up:
#     wp-await.sh --run 'curl -s -o /dev/null -w %{http_code} https://example.com/health' \
#                 --until '^200$' --timeout 900 --label 'health'
#
#   Reviewer verdicts landing (short):
#     wp-await.sh --run 'ls .webpieces/pr-review/<branch>/' --until 'review-.*\.json' --timeout 500
set -uo pipefail

RUN=""; UNTIL=""; WHILE=""; FAIL=""; TIMEOUT=545; INTERVAL=15; LABEL=""

die() { printf '%s\n' "$1" >&2; exit 3; }

while [ $# -gt 0 ]; do
  case "$1" in
    --run)      RUN="${2:-}"; shift 2 ;;
    --until)    UNTIL="${2:-}"; shift 2 ;;
    --while)    WHILE="${2:-}"; shift 2 ;;
    --fail)     FAIL="${2:-}"; shift 2 ;;
    --timeout)  TIMEOUT="${2:-}"; shift 2 ;;
    --interval) INTERVAL="${2:-}"; shift 2 ;;
    --label)    LABEL="${2:-}"; shift 2 ;;
    -h|--help)  sed -n '1,70p' "$0"; exit 0 ;;
    *) die "wp-await: unknown argument '$1'. Run with --help." ;;
  esac
done

[ -n "$RUN" ] || die "wp-await: --run '<command>' is required."
if [ -z "$UNTIL" ] && [ -z "$WHILE" ]; then
  die "wp-await: give --until <regex> (succeed when it matches) or --while <regex> (succeed when it stops matching)."
fi
case "$TIMEOUT"  in (*[!0-9]*|'') die "wp-await: --timeout must be whole seconds." ;; esac
case "$INTERVAL" in (*[!0-9]*|'') die "wp-await: --interval must be whole seconds." ;; esac
[ "$INTERVAL" -ge 1 ] || INTERVAL=1
[ -n "$LABEL" ] || LABEL="$RUN"

# ─── STALE `gh pr checks` CROSS-CHECK (deanhiller/webpieces-ts#900, second bug) ────────────────────
# `gh pr checks` serves cached rows: it reported `Validate (lint + test + build)  pending  0` for
# several minutes after run 34577018237 had already finished SUCCESS. A `--while pending` wait then
# sits through a job that is already done. So when the output has not changed for STALE_POLLS polls
# AND still shows a pending row with an elapsed of 0, ask the RUN itself, which is not cached.
#
# It only fires for `gh pr checks` (nothing else emits those URLs), only after the output has gone
# stale, and it decides from `conclusion` — so it reports a failure as readily as a success. If it
# cannot reach a verdict it says nothing and the normal loop continues.
STALE_POLLS=4

stale_pending() {
  case "$RUN" in (*"gh pr checks"*) ;; (*) return 1 ;; esac
  printf '%s' "$1" | grep -Eq '(^|[[:space:]])pending[[:space:]]+0s?([[:space:]]|$)'
}

crosscheck_runs() {
  # stdout: "completed <conclusions>" | "running" | "" (no verdict)
  RUN_URLS="$(printf '%s' "$1" | grep -oE 'https://github[.]com/[^[:space:]]+/actions/runs/[0-9]+' | sort -u)"
  [ -n "$RUN_URLS" ] || return 0
  CONCS=""
  for u in $RUN_URLS; do
    rid="${u##*/}"
    slug="${u#https://github.com/}"; slug="${slug%%/actions/*}"
    j="$(gh run view "$rid" --repo "$slug" --json status,conclusion 2>/dev/null)" || return 0
    printf '%s' "$j" | grep -q '"status":"completed"' || { printf 'running'; return 0; }
    c="$(printf '%s' "$j" | sed -n 's/.*"conclusion":"\([a-z_]*\)".*/\1/p')"
    CONCS="$CONCS $c"
  done
  printf 'completed%s' "$CONCS"
}

START=$(date +%s); LAST_BEAT=0; LAST_SIG=""; ATTEMPT=0; STALE=0

printf 'wp-await: waiting on %s (timeout %ss, polling every %ss, %s poll costs no tokens)\n' \
  "$LABEL" "$TIMEOUT" "$INTERVAL" 'each'

while :; do
  ATTEMPT=$((ATTEMPT + 1))
  OUT="$(eval "$RUN" 2>&1)" || true

  if [ -n "$FAIL" ] && printf '%s' "$OUT" | grep -Eq -- "$FAIL"; then
    printf 'wp-await: FAILED — %s matched /%s/ after %ss and %s polls.\n' \
      "$LABEL" "$FAIL" "$(( $(date +%s) - START ))" "$ATTEMPT"
    printf '%s\n' "$OUT"
    printf 'Do NOT keep waiting. Read the failure above and fix it.\n'
    exit 1
  fi

  if [ -n "$UNTIL" ] && printf '%s' "$OUT" | grep -Eq -- "$UNTIL"; then
    printf 'wp-await: SUCCESS — %s matched /%s/ after %ss and %s polls.\n' \
      "$LABEL" "$UNTIL" "$(( $(date +%s) - START ))" "$ATTEMPT"
    printf '%s\n' "$OUT"
    exit 0
  fi

  if [ -n "$WHILE" ] && ! printf '%s' "$OUT" | grep -Eq -- "$WHILE"; then
    printf 'wp-await: SUCCESS — %s stopped matching /%s/ after %ss and %s polls.\n' \
      "$LABEL" "$WHILE" "$(( $(date +%s) - START ))" "$ATTEMPT"
    printf '%s\n' "$OUT"
    exit 0
  fi

  NOW=$(date +%s); ELAPSED=$(( NOW - START ))

  # Output gone stale on a pending-with-0 row? Ask the run itself, which is not cached.
  SIG_NOW="$(printf '%s' "$OUT" | tr -s '[:space:]' ' ' | cut -c1-90)"
  if [ "$SIG_NOW" = "$LAST_SIG" ] && stale_pending "$OUT"; then
    STALE=$(( STALE + 1 ))
  else
    STALE=0
  fi
  if [ "$STALE" -ge "$STALE_POLLS" ]; then
    STALE=0
    VERDICT="$(crosscheck_runs "$OUT")"
    case "$VERDICT" in
      completed*)
        printf 'wp-await: gh pr checks still says pending/0, but the RUN says completed:%s\n' \
          "${VERDICT#completed}"
        case "$VERDICT" in
          *failure*|*cancelled*|*timed_out*|*startup_failure*)
            printf 'wp-await: FAILED — %s (from gh run view; gh pr checks was serving stale rows).\n' "$LABEL"
            printf '%s\n' "$OUT"
            printf 'Do NOT keep waiting. Read the failure above and fix it.\n'
            exit 1 ;;
          *)
            printf 'wp-await: SUCCESS — %s after %ss and %s polls (verdict from gh run view).\n' \
              "$LABEL" "$ELAPSED" "$ATTEMPT"
            printf '%s\n' "$OUT"
            exit 0 ;;
        esac ;;
    esac
  fi

  # Heartbeat so a foreground run is never silent, and a background log stays readable. `still` when
  # nothing changed — a changing line is worth reading, a repeated one is worth skipping.
  if [ $(( NOW - LAST_BEAT )) -ge 20 ]; then
    SIG="$(printf '%s' "$OUT" | tr -s '[:space:]' ' ' | cut -c1-90)"
    if [ "$SIG" = "$LAST_SIG" ]; then
      printf '  %s: still (%ss)\n' "$LABEL" "$ELAPSED"
    else
      printf '  %s: %s (%ss)\n' "$LABEL" "$SIG" "$ELAPSED"
      LAST_SIG="$SIG"
    fi
    LAST_BEAT=$NOW
  fi

  if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
    printf 'wp-await: STILL WAITING after %ss and %s polls — run the IDENTICAL command again.\n' \
      "$ELAPSED" "$ATTEMPT"
    printf 'Last output:\n%s\n' "$OUT"
    printf 'Do NOT switch to checking by hand: one hand-rolled check costs your whole context (~557k tokens).\n'
    exit 2
  fi

  sleep "$INTERVAL"
done
