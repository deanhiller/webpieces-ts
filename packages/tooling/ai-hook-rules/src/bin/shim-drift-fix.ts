import { L0_SHIM_STREAM } from '../core/log-streams';

import { CHECKOUT_MAIN_PULL_CMD } from './l0-allowlist';

// ---------------------------------------------------------------------------
// Shell fragment: the Fix Options for the INVERSE half of L0 fault D — node_modules is NEWER than the
// pin (or the two could not be ordered), so a bare `pnpm install` is a DOWNGRADE.
//
// Its own module for the same reason shim-audit-log.ts is: shim.ts renders the whole shim body and is
// at its file-size cap. It imports FROM ./l0-allowlist and is never imported BY it, so the graph stays
// acyclic, and it stays as dependency-free as the rest of the shim — this text has to render on a tree
// too broken to load the rule engine.
//
// WHY THE FIX OPTIONS ARE COMPUTED RATHER THAN LISTED (2026-08-10, audit finding C6).
//
// This message used to offer a bare `git pull origin main` on every branch, and the L0 allowlist
// terminally ALLOWED it — so on a FEATURE branch the guard told the agent to merge main into the branch
// and then waved the command past redirect-how-to-merge-main, the guard whose whole job is stopping
// exactly that. The fork point it destroys is what the 3-point merge, `nx affected --base=` and the PR
// review diff are computed from, so nothing fails at the time; it surfaces later as a build that covered
// the wrong scope and a PR diff describing work nobody did. A menu whose first option is blocked on the
// branch you are standing on is worse than no menu, so the branch is asked instead.
//
// ON MAIN the forward move is `git checkout main && git pull origin main` — it ends ON main, merges
// nothing into anything, is a no-op checkout when you are already there, and it is the ONE pull spelling
// still on the L0 allowlist (see CHECKOUT_MAIN_PULL_BODY_ERE, which also records why it is a narrow
// literal).
//
// RAW GIT ON PURPOSE, and this is now the DIFFERENCE from the workflow guards rather than a match with
// them. stale-main-bash-guard, merged-branch-message, TreeRecovery and the L2 rows all prescribe
// `pnpm wp-checkout-clean-main` — the same pairing with `wp-cleanup` and the orphan-directory sweep
// welded on, so the sweep actually runs. THIS message must NOT follow them: the fault it is reporting IS
// that `node_modules` disagrees with the pin, which makes `node_modules` the untrustworthy thing, and
// every `pnpm wp-*` bin resolves through it. An L0 cure may never be a command that has to load the
// package it is repairing. Two layers, two spellings, and that is not the two-spellings shim — they are
// cures for two different states, one of which has a working package manager and one of which does not.
//
// The rationale is recorded HERE, in the source, and deliberately NOT as a comment inside the rendered
// shell: the committed `.claude/webpieces/ai-hook.sh` is byte-compared against renderShim() by the
// committed-shim self-guard, so a comment-only change would fire that guard on every consumer's tree for
// no behavioural reason — the exact churn the version stamp was removed to stop.
//
// ON A FEATURE BRANCH there is no honest forward move to name, and this deliberately does not invent
// one. `pnpm install` aligns node_modules to YOUR branch pin and is the usual right answer, but it is a
// DOWNGRADE — and every drift event logged in this repo to date has been the OTHER direction, so a
// feature branch that genuinely needs the NEWER pin is a shape the guard logic has never seen. Option 2
// therefore says that plainly and prints the L0 audit-log paths, because those logs are the evidence a
// real cure would have to be designed from, and an escalation nobody can act on is not an option at all.
//
// `git branch --show-current`, NOT `git rev-parse --abbrev-ref HEAD`: it answers on an UNBORN branch
// (`rev-parse` fatals there), and it prints an EMPTY string on a detached HEAD — which falls to the
// conservative, non-main half, exactly as an unknown branch should.
//
// CONSTRAINT, same as every other deny fragment: no `"` and no backslash may reach the rendered text —
// it is interpolated into a `REASON="…"` shell assignment and then printf'd into a JSON string.
// ---------------------------------------------------------------------------
export const DRIFT_INVERSE_FIX_SH = `WP_BRANCH="$(git -C "$ROOT" branch --show-current 2>/dev/null)"
    [ -n "$WP_LOG_DIR" ] || wp_resolve_log_dir
    if [ "$WP_BRANCH" = main ]; then
      WP_FIX="  Fix Option 1: (preferred) you are on main and want what origin pins - move forward\${NL}    run EXACTLY: '${CHECKOUT_MAIN_PULL_CMD}', then 'pnpm install'\${NL}  Fix Option 2: you mean to stay on this code - the downgrade is the point\${NL}    run EXACTLY: 'pnpm install'"
    else
      WP_LOG_PATHS="$WP_LOG_DIR/${L0_SHIM_STREAM}/"
      [ "$WP_PRIMARY_LOG_DIR" = "$WP_LOG_DIR" ] || WP_LOG_PATHS="\${WP_LOG_PATHS}\${NL}      and, for the primary clone: $WP_PRIMARY_LOG_DIR/${L0_SHIM_STREAM}/"
      WP_FIX="  Fix Option 1: (preferred) off main, align node_modules to YOUR branch pin - usually right\${NL}    run EXACTLY: 'pnpm install'\${NL}  Fix Option 2: you actually need the NEWER pin ON THIS BRANCH - there is no cure to run, and this guard will not invent one\${NL}    Do NOT reach for 'git pull origin main': pulling main into a feature branch destroys the fork point the build gate --base and the PR review diff are computed from, and the guards block it.\${NL}    You hit a weird case of needing a downgrade. Contact Dean - he needs the audit logs to understand why you are downgrading, so the guard logic can account for it.\${NL}    L0 audit logs: $WP_LOG_PATHS"
    fi`;
