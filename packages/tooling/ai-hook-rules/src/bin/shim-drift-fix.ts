import { CHECKOUT_MAIN_PULL_CMD, WORKSPACE_MANIFEST, PACKAGE_MANIFEST } from './l0-allowlist';

// ---------------------------------------------------------------------------
// Shell fragment: the Fix Options for the INVERSE half of L0 fault D — node_modules is NEWER than the
// pin (or the two could not be ordered), so a bare `pnpm install` is a DOWNGRADE.
//
// Its own module for the same reason shim-audit-log.ts is: shim.ts renders the whole shim body and is
// at its file-size cap. It imports FROM ./l0-allowlist and is never imported BY it, so the graph stays
// acyclic, and it stays as dependency-free as the rest of the shim — this text has to render on a tree
// too broken to load the rule engine.
//
// EVERY ARM'S FIRST OPTION NOW GOES FORWARD (2026-08-20). This message used to lead, on a feature
// branch, with `pnpm install` as "(preferred) ... usually right" — an option that is by construction a
// DOWNGRADE, since this whole branch of the message only renders when node_modules is the NEWER side.
// One measured agent took that advice, downgraded its engine two releases, and the older engine then
// rejected a config key it had never heard of and blocked every Bash call. The forward move — keep what
// is installed, raise the pin to match it — was never offered at all, on any arm.
//
// THE FORWARD MOVE IS A FILE EDIT, and that is exactly why it could not be offered before: editing
// pnpm-workspace.yaml was not on the L0 allowlist, so the guard would have prescribed a call it then
// denied. It IS on the list now (see l0-allowlist's manifest entry and isAllowed), so Option 1 is a
// cure the reader can actually perform from inside this block. The `pnpm install` that follows it
// rewrites the lock and downgrades nothing, because the pin now names what is already on disk.
//
// THIS FRAGMENT IS SINGLE-TREE ONLY. Fault D no longer fires when the guard bin was inherited from
// another tree (see VERSION_DRIFT_GUARD_SH) — that case belongs to L1 row 8, which can see all four
// versions. So every option here acts on ONE tree, and no cross-tree escalation is needed or offered.
//
// ON MAIN the alternative forward move is `git checkout main && git pull origin main` — it ends ON main,
// merges nothing into anything, is a no-op checkout when you are already there, and it is the ONE pull
// spelling still on the L0 allowlist (see CHECKOUT_MAIN_PULL_BODY_ERE, which also records why it is a
// narrow literal).
//
// RAW GIT ON PURPOSE, and this is now the DIFFERENCE from the workflow guards rather than a match with
// them. stale-main-bash-guard, merged-branch-message, TreeRecovery and the L2 rows all prescribe
// `pnpm wp-sync-main` — the same pairing with `wp-cleanup` and the orphan-directory sweep
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
// `git branch --show-current`, NOT `git rev-parse --abbrev-ref HEAD`: it answers on an UNBORN branch
// (`rev-parse` fatals there), and it prints an EMPTY string on a detached HEAD. That empty answer used
// to fall into the feature-branch half, which was wrong twice over: there is no branch for Option 1's
// pin edit to belong to, and the branch-specific warning about fork points is meaningless. It is its own
// arm now — the one arm whose preferred cure is the checkout, precisely because it has no branch to edit.
//
// CONSTRAINT, same as every other deny fragment: no `"` and no backslash may reach the rendered text —
// it is interpolated into a `REASON="…"` shell assignment and then printf'd into a JSON string.
// ---------------------------------------------------------------------------
const PIN_EDIT_SH =
    `edit $ROOT/${WORKSPACE_MANIFEST} - the catalog line for $DRIFT_PKG, or that dependency in `
    + `$ROOT/${PACKAGE_MANIFEST} if this repo pins directly - and set it to $DRIFT_INSTALLED, then run 'pnpm install'`;

const FORWARD_NOTE_SH =
    `That edit is ALLOWED while this block is up, and the install then only rewrites the lock - `
    + `nothing is downgraded, because the pin now names what is already on disk.`;

export const DRIFT_INVERSE_FIX_SH = `WP_BRANCH="$(git -C "$ROOT" branch --show-current 2>/dev/null)"
    WP_PIN_EDIT="${PIN_EDIT_SH}"
    if [ -z "$WP_BRANCH" ]; then
      WP_FIX="  Fix Option 1: (preferred) HEAD is DETACHED here, so a pin edit would belong to no branch - get onto main instead, whose pin is already at or ahead of what is installed, so the drift clears with no edit at all\${NL}    run EXACTLY: '${CHECKOUT_MAIN_PULL_CMD}', then 'pnpm install'\${NL}  Fix Option 2: you mean to stay on this exact commit - the downgrade to $DRIFT_DECLARED is the point\${NL}    run EXACTLY: 'pnpm install'"
    elif [ "$WP_BRANCH" = main ]; then
      WP_FIX="  Fix Option 1: (preferred) go FORWARD - keep what is installed and raise the pin to match it\${NL}    \${WP_PIN_EDIT}\${NL}    ${FORWARD_NOTE_SH}\${NL}  Fix Option 2: you are on main and want what origin pins instead\${NL}    run EXACTLY: '${CHECKOUT_MAIN_PULL_CMD}', then 'pnpm install'"
    else
      WP_FIX="  Fix Option 1: (preferred) go FORWARD - keep what is installed and raise THIS branch's pin to match it\${NL}    \${WP_PIN_EDIT}\${NL}    ${FORWARD_NOTE_SH}\${NL}  Fix Option 2: you mean to align node_modules to YOUR branch pin - that is a DOWNGRADE to $DRIFT_DECLARED, so pick it only if you meant to\${NL}    run EXACTLY: 'pnpm install'\${NL}    Do NOT reach for 'git pull origin main': pulling main into a feature branch destroys the fork point the build gate --base and the PR review diff are computed from, and the guards block it."
    fi`;
