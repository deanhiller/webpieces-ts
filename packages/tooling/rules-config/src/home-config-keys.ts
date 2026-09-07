/**
 * The KEY NAMES, the ALLOW-LISTS and the DEFAULTS of `~/.webpieces/config.json` — split out of
 * `home-config.ts` for the same reason `home-config-doc-keys.ts` and `home-config-retired-keys.ts`
 * already were: the loader and the vocabulary it validates against are two different things, and only
 * one of them grows every time somebody adds a flag.
 *
 * `home-config.ts` RE-EXPORTS every name here, so this file is an implementation detail of that module
 * and NOT a second import path. The barrel (`src/index.ts`) still exports these from `./home-config`,
 * which is the one public spelling.
 *
 * Read `home-config.ts`'s own class docblock FIRST. It carries the two rules that govern everything
 * below and are not negotiable: no key here may ever be REQUIRED, and an unknown key is IGNORED rather
 * than rejected — because this document is MACHINE-GLOBAL and the repos reading it pin different
 * releases.
 */
export const HOME_CONFIG_DIR = '.webpieces';
export const HOME_CONFIG_FILE = 'config.json';

// The `experimental` section and its keys. Named as constants because both the validator and its error
// text must spell them identically — a validator whose message names a different key than the one it
// checks is worse than no message.
export const HOME_EXPERIMENTAL_SECTION = 'experimental';
// The on/off switch for `whole-repo-build-guard`. Spelled with the GUARD's own name, hyphens and all,
// so `grep -rn whole-repo-build-guard` finds the switch beside the guard — and so nobody has to learn a
// second name for one thing.
//
// `buildGateLogCapture` used to sit beside it and is GONE: capturing the build's output to a file is now
// what the gate always does (see BuildAffected.runBuildGate), so the flag had nothing left to switch. It
// is deliberately NOT in RETIRED_HOME_CONFIG_KEYS — a retired key here is a HARD FAILURE on exact match,
// and this file is machine-global and hand-authored, so a machine that opted INTO a behaviour it now
// gets unconditionally must not have its shell broken for saying yes early. It falls through to the
// unknown-key WARNING instead, which says the key had no effect and names what is understood.
export const HOME_KEY_WHOLE_REPO_BUILD_GUARD = 'whole-repo-build-guard';
// The on/off switch for the orphan-directory sweep `wp-sync-main` runs. Named for the thing
// it switches, exactly as the guard key above is — one name, greppable from either end.
export const HOME_KEY_ORPHAN_DIR_SWEEP = 'orphan-dir-sweep';
/**
 * ─── THE KILL SWITCH FOR EVERY PR-GATE REVIEWER. READ THIS BEFORE YOU TOUCH THE KEY. ──────────────────
 *
 * When a machine writes `{"experimental": {"turnOffAllReviewers": true}}` into
 * `~/.webpieces/config.json`, `ChecklistScanner.scan` returns NO applicable checklists, so
 * `wp-review-upsert-pr` briefs and names no reviewer subagent and `wp-finish-upsert-pr` has nothing
 * outstanding to block on. The review product becomes the dashboard, and nothing else.
 *
 * 1. IT LIVES ONLY HERE. There is deliberately NO `webpieces.config.json` entry for it, and there must
 *    never be one. Do not "make it configurable per repo"; that request is the defect, not the feature.
 *
 * 2. IT IS A KILL SWITCH, NOT A FILTER. It suppresses ALL reviewers — the REQUIRED checklists included.
 *    That is the whole point: the required set is most of the token cost, so a half-measure that spared
 *    them would save nothing and would still have to be explained. It does not narrow, re-order or
 *    re-scope anything; it is on or it is off.
 *
 * 3. WHY A TRACKED REPO KEY IS UNACCEPTABLE. `webpieces.config.json` is TRACKED, so a key there rides in
 *    a BRANCH — and a branch that can switch off its own required reviewers is a branch that reviews
 *    itself. The required checklists exist precisely to be the one thing a diff cannot talk its way past;
 *    putting their off-switch inside the diff's own repo hands every future PR the ability to disable the
 *    gate that judges it. That is not a config preference, it is a hole in the gate. This file is
 *    machine-local, untracked, hand-authored and outside every repo, so a value here is ONE person's
 *    decision about their OWN machine and it cannot travel in a pull request.
 *    The precedent is `whole-repo-build-guard`, retired as a repo key one release after it shipped (see
 *    `RETIRED_CONFIG_KEYS`) and living only here since. This key is the same shape with a sharper edge,
 *    because what it disables IS the review gate rather than a build convenience.
 *
 * 4. IT IS AN `experimental.*` FLAG, so `.claude/rules/experiments.md` applies in full: an AI may never
 *    DELETE it, RENAME it, NARROW what it controls, flip its default to ON, or make EITHER branch
 *    unconditional. Only a human ends an experiment, and your own reasoning is never that human. If it
 *    looks finished, say so and leave the key alone.
 *
 * 5. IT IS NEVER QUIET. An unreviewed PR must not read as a reviewed one, so the suppression is stated in
 *    stage ②'s output, on the dashboard, and in the PR body — which is the squash-merge commit body, and
 *    therefore the only record that outlives the branch. Do not remove those, either.
 */
export const HOME_KEY_TURN_OFF_ALL_REVIEWERS = 'turnOffAllReviewers';
/**
 * How many builds may be live on this machine before `pnpm wp-build` refuses to start another. The FIRST
 * NUMERIC key in this file — see `readOptionalPositiveInteger` for why "known key, wrong type → REJECT"
 * applies to it exactly as it applies to the booleans.
 */
export const HOME_KEY_MAX_CONCURRENT_BUILDS = 'maxConcurrentBuilds';

/**
 * EVERY key's value when it is not named — including on the machine with no such file at all, which is
 * essentially every machine. False, for all of them, with no exceptions and no per-key table.
 *
 * That uniformity is the policy, not a coincidence: every `experimental.*` flag ships OFF and stays OFF
 * for two years, so "this machine never opted in" is byte-for-byte the behaviour of having no file. ON
 * requires an explicit `true`; absent, and an explicit `false`, are the same state.
 *
 * Named rather than written as a bare `false` at each call site so the reason travels with the value —
 * and there is deliberately exactly ONE such constant, because a second one would be a second place a
 * default is stated, free to disagree with this one.
 */
export const GUARD_OFF_WHEN_ABSENT = false;

/**
 * The one NON-boolean default, and the one key whose absent value is not `GUARD_OFF_WHEN_ABSENT`.
 *
 * Three, because contention between agents running full sweeps at once was measured at ~3.2x total test
 * time (`.claude/rules/build-verification.md` § "What actually makes builds slow"), and a fourth simultaneous build
 * is well past the
 * point where anybody gains anything. It is a NUMBER rather than an on/off flag because the useful
 * machine-to-machine difference here is core count, not opinion — which is also why it is the one key in
 * this file with a non-false default: "0 builds allowed" would be a machine that cannot build at all.
 */
export const DEFAULT_MAX_CONCURRENT_BUILDS = 3;

/**
 * The complete UNDERSTOOD shape. A key not on these lists is ignored with a warning rather than
 * rejected (see the class docblock: this document is machine-global and older releases must survive
 * meeting a newer release's key), so adding a key still means adding it here — a key absent from these
 * lists is never read at all, and the flag it was meant to set keeps the default above.
 *
 * EXPORTED so `home-config.spec.ts` can ENUMERATE them rather than restate them. The cross-version
 * invariant ("every key is independently omittable") is only as good as the list the test walks, and a
 * hand-written copy of that list means a NEW key silently escapes the invariant on the day it is added —
 * which is the one failure mode nobody would notice until an older release started rejecting files.
 * Walking the real constant makes the test cover a new key the moment it appears here.
 */

/**
 * The SETTINGS only. Documentation keys are deliberately NOT here: these lists are walked to build
 * sample documents and to assert cross-version invariants, and every entry is assumed to be a setting
 * with a typed value. `warnUnknownKeys` accepts the documentation keys separately, everywhere.
 */
export const ALLOWED_TOP_LEVEL: readonly string[] = [HOME_EXPERIMENTAL_SECTION];
/**
 * The understood `experimental.*` keys, SPLIT BY VALUE TYPE — because the spec walks these lists to build
 * a sample document, and a sample that wrote `false` into a numeric key would be rejected by the very
 * loader it is testing. Splitting them means a key added to either list is covered by the cross-version
 * invariants automatically, with the right sample value, which is the whole reason the lists are exported.
 *
 * `ALLOWED_EXPERIMENTAL` stays the ONE list the validator warns against — derived from the two, never
 * hand-maintained beside them, so it cannot fall out of step.
 */
/**
 * ─── ONLY A HUMAN ENDS AN EXPERIMENT ──────────────────────────────────────────────────────────────
 *
 * An AI agent may ADD a flag to these lists. It may NEVER DELETE one, and may never make a flagged
 * behaviour unconditional — however settled it looks, however old the flag is, however good the
 * reasoning. Ending an experiment judges evidence that lives on someone else's machine.
 *
 * From a live incident: PR #711 deleted `buildGateLogCapture` and made capture unconditional. Its
 * owner's config said `true`, and after that release the opt-in silently meant nothing. Note the
 * shape — that file says "AI: DO NOT EDIT this file!!", and the agent never touched it; it deleted
 * the key from the CODE, which has the identical effect from the owner's seat. A rule protecting a
 * FILE does not protect the SETTING it selects.
 *
 * If you believe an experiment should end, SAY SO and leave the flag alone.
 * `.claude/rules/experiments.md` §"ONLY A HUMAN ENDS AN EXPERIMENT" carries the full rule and what a
 * human-ended retirement looks like.
 */
export const ALLOWED_EXPERIMENTAL_BOOLEANS: readonly string[] = [
    HOME_KEY_WHOLE_REPO_BUILD_GUARD, HOME_KEY_ORPHAN_DIR_SWEEP, HOME_KEY_TURN_OFF_ALL_REVIEWERS,
];
export const ALLOWED_EXPERIMENTAL_NUMBERS: readonly string[] = [HOME_KEY_MAX_CONCURRENT_BUILDS];
export const ALLOWED_EXPERIMENTAL: readonly string[] = [
    ...ALLOWED_EXPERIMENTAL_BOOLEANS, ...ALLOWED_EXPERIMENTAL_NUMBERS,
];

