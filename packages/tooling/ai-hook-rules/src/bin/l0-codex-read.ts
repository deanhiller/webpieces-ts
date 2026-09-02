import { READ_COMMANDS, SED_RANGE_BODY } from '../core/shell-read-parity';

// ---------------------------------------------------------------------------
// CODEX READ PARITY AT L0 — the deadlock PR #731 measured and deliberately left open.
//
// Allowlist entry 1 is "any Read", and under Claude Code that single entry is what makes every L0 fault
// SURVIVABLE rather than fatal: the agent is denied all work, reads the config / the logs / the matrix
// doc, and diagnoses its way out. CODEX HAS NO `Read` TOOL. Measured on codex-cli 0.151.0, a file read
// arrives as `tool_name: "Bash"` running `sed -n '1,240p' package.json`. Nothing on the list above
// matches that, so under D/X/U/K/S a Codex session is denied EVERYTHING — including the reads the deny
// message is telling it to perform. That is a hard deadlock, and it is the exact failure class this
// whole module exists to remove.
//
// So this entry is entry 1's twin for the other harness, and it is GATED ON its harness (see
// L0AllowEntry.harness). A Claude payload can never reach it — Claude already has `Read`, and widening
// L0's Bash surface for a harness that does not need it is a change to the one behaviour that must not
// change. `codex-l0-read.spec.ts` proves the unreachability rather than asserting it in a comment.
//
// ─── AS WIDE AS core/shell-read-parity.ts AND NO WIDER ─────────────────────────────────────────────
// That module is the repo's ONE definition of "this Codex Bash call is a read", and this pattern is
// built from its exported vocabulary (READ_COMMANDS, SED_RANGE_BODY) rather than a second list. It
// cannot literally call it — L0's sh half has no JS, and the JS half runs where nothing above it can be
// trusted — so what is shared is the vocabulary and what is asserted is agreement over a corpus.
//
// Where it is deliberately NARROWER than that module: the shell-read predicate also resolves every
// operand against the filesystem and rejects anything outside the tree. A regex cannot ask the
// filesystem, so this pattern simply refuses everything the predicate refuses SYNTACTICALLY and accepts
// a superset only in the "does this path exist here" dimension. That dimension is not a privilege
// boundary at L0: entry 1 grants Claude an unrestricted Read of any path already.
//
// NO `cd` PREFIX AND NO CAPTURE TAIL, unlike every entry above, and that is the point rather than an
// oversight. `shell-read-parity` treats `|`, `&&`, `;` and every redirect as PROOF the command is not a
// read; splicing CAPTURE_TAIL_ERE on would make this entry accept `cat x | tail -20`, which that module
// says is not a read — i.e. it would make this entry WIDER than the definition it is supposed to share.
// The cost is that `sed -n '1,240p' x 2>/dev/null` is denied; the deny text names the bare spelling, and
// bare is how Codex actually spells a read (measured).
//
// WHAT CANNOT RIDE ALONG: every character class below excludes `;` `&` `|` `` ` `` `<` `>` `$` and the
// double quote, so no chaining, no redirect, no substitution and no expansion is expressible — the same
// set `NOT_ONE_COMMAND` rejects, enforced by construction instead of by a scan. A path containing
// spaces is reachable through the single-quoted branch, where sh performs no expansion at all.
// Keep in sync with CODEX_READ_BODY_JS below (locked by a unit test).
// `-50` (head/tail's line count) as well as `-n` / `--number`: `shell-read-parity` skips every token
// starting with `-`, so a flag shape it accepts and this pattern rejects is a spelling the deny would
// leave untypable — the deadlock this entry exists to remove, one level down.
const CODEX_READ_FLAG_ERE = '(-[0-9]+|-{1,2}[A-Za-z][A-Za-z0-9=._-]*)';
// A path token: no leading `-` (that is a flag, and a bare `-` is stdin, not a file), or any path at all
// inside single quotes — where the ONLY character that can end the region is the one the class excludes.
const CODEX_READ_PATH_ERE = "([A-Za-z0-9._/@~+,:][A-Za-z0-9._/@~+,:-]*|'[^']+')";
const CODEX_READ_ARG_ERE = '(' + CODEX_READ_FLAG_ERE + '|' + CODEX_READ_PATH_ERE + ')';
// `<pager> [flags…] <path> [more args…]` — at least one path operand is REQUIRED, so `cat` on its own
// (which reads stdin, not a file) is not a read here either.
const CODEX_PAGER_ERE =
    '(' + [...READ_COMMANDS].join('|') + ')([[:space:]]+' + CODEX_READ_ARG_ERE + ')*'
    + '[[:space:]]+' + CODEX_READ_PATH_ERE + '([[:space:]]+' + CODEX_READ_ARG_ERE + ')*';
// `sed -n '<range>p' <path>` — BOTH halves required, exactly as sedOperands() requires them: without
// `-n` sed echoes and edits, and any script that is not a bare range print is a transformation.
const CODEX_SED_ERE =
    'sed[[:space:]]+-n[[:space:]]+(' + SED_RANGE_BODY + "|'" + SED_RANGE_BODY + "')"
    + '([[:space:]]+' + CODEX_READ_ARG_ERE + ')*[[:space:]]+' + CODEX_READ_PATH_ERE
    + '([[:space:]]+' + CODEX_READ_ARG_ERE + ')*';
export const CODEX_READ_BODY_ERE = '(' + CODEX_PAGER_ERE + '|' + CODEX_SED_ERE + ')';

// JS-regex-source twin of CODEX_READ_BODY_ERE (POSIX `[[:space:]]` → `\s`). A unit test asserts they agree.
const CODEX_READ_FLAG_JS = '(-[0-9]+|-{1,2}[A-Za-z][A-Za-z0-9=._-]*)';
const CODEX_READ_PATH_JS = "([A-Za-z0-9._\\/@~+,:][A-Za-z0-9._\\/@~+,:-]*|'[^']+')";
const CODEX_READ_ARG_JS = '(' + CODEX_READ_FLAG_JS + '|' + CODEX_READ_PATH_JS + ')';
const CODEX_PAGER_JS =
    '(' + [...READ_COMMANDS].join('|') + ')(\\s+' + CODEX_READ_ARG_JS + ')*'
    + '\\s+' + CODEX_READ_PATH_JS + '(\\s+' + CODEX_READ_ARG_JS + ')*';
const CODEX_SED_JS =
    'sed\\s+-n\\s+(' + SED_RANGE_BODY + "|'" + SED_RANGE_BODY + "')"
    + '(\\s+' + CODEX_READ_ARG_JS + ')*\\s+' + CODEX_READ_PATH_JS + '(\\s+' + CODEX_READ_ARG_JS + ')*';
export const CODEX_READ_BODY_JS = '(' + CODEX_PAGER_JS + '|' + CODEX_SED_JS + ')';

/** The measured Codex spelling of a file read, and this entry's canonical sample. */
export const CODEX_READ_CMD = "sed -n '1,240p' package.json";

/**
 * The line every L0 deny's "still allowed" block prints for the harness with no `Read` tool.
 *
 * It exists because the block already said "any Read" and a Codex session HAS no Read — so the one
 * sentence telling a blocked agent how to inspect its way out named a tool it could not call. That is
 * the deadlock shape this module is a catalogue of, one level up in the message instead of the pattern.
 *
 * CONSTRAINT (see NO_CHAINING_RULE in ./shim): this string is interpolated into a `REASON="…"` shell
 * assignment and then printf'd into a JSON string, so it may contain no double quote and no backslash.
 */
export const CODEX_READ_STILL_ALLOWED =
    `on CODEX (no Read tool): a bare read command - ${[...READ_COMMANDS].join('/')} <file>, `
    + `or ${CODEX_READ_CMD} - with nothing piped, redirected or chained onto it`;
// ---------------------------------------------------------------------------
// THE CODEX-ONLY UNION — a SECOND, separately-anchored list, consulted only after both halves of L0
// have answered "which harness sent this call?" (AI_TYPE_SH in sh, detectAiType() in JS).
//
// A separate union rather than a flag inside L0_ALLOW_ERE, for two reasons that are both structural:
//   1. UNREACHABILITY IS THE POINT. A Claude payload never evaluates this pattern at all — the sh half
//      guards it with `[ "$AI" = codex ]` and the JS half with an `aiType === 'codex'` test — so
//      "Claude Code behaviour does not change" is a property of the control flow, not of the regex.
//   2. IT IS ANCHORED DIFFERENTLY. Every ungated entry tolerates a `cd <dir> &&` prefix and a
//      `2>&1 | tail -N` capture tail. A read-shaped command may tolerate NEITHER without becoming
//      wider than core/shell-read-parity.ts, which treats both as proof the command is not a read.
//      Folding this body into L0_ALLOW_ERE would silently splice both onto it.
//
// Built from the SAME constants the L0_ALLOWLIST entry carries — it cannot filter that array here,
// because the array imports these bodies and the import would be a cycle. `codex-l0-read.spec.ts`
// locks the two together instead: the gated entry's `ere`/`js` must BE this union's source.
// ---------------------------------------------------------------------------
/** The Codex-gated Bash allowlist as a POSIX ERE — anchored at BOTH ends, no prefix, no tail. */
export const L0_CODEX_ALLOW_ERE =
    '^(' + CODEX_READ_BODY_ERE + ')[[:space:]]*$';

/** L0_CODEX_ALLOW_ERE as it must be SPELLED inside a single-quoted sh string — the `'\''` dance. */
export const L0_CODEX_ALLOW_ERE_SH = L0_CODEX_ALLOW_ERE.split("'").join(`'\\''`);

/** JS twin of L0_CODEX_ALLOW_ERE. A unit test asserts the two agree over a corpus. */
export const L0_CODEX_ALLOW_JS =
    new RegExp('^(' + CODEX_READ_BODY_JS + ')\\s*$');
