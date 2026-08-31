import { AiType } from '../core/agent-event';

/**
 * THE discriminator, and the only one. Codex's PreToolUse envelope carries a REQUIRED `turn_id`;
 * Claude Code's has no such key. Everything else in the two envelopes is the same key names
 * (`hook_event_name`, `tool_name`, `tool_input`, `cwd`, `session_id`, `transcript_path`), which is
 * exactly why one positive key is the whole test rather than a shape heuristic.
 *
 * Exported as a TWIN — an sh fragment and a JS predicate — because L0 has two halves that must
 * answer the identical question: the rendered POSIX-sh shim (which has no JSON parser and scrapes
 * text) and this binary (which has the parsed object). That is the same pattern
 * ../bin/l0-allowlist.ts already uses for `L0_ALLOW_ERE_SH` / `L0_ALLOW_JS`, and detect-ai.spec.ts
 * asserts the two agree over a corpus the same way.
 *
 * ─── THE SH HALF IS AN APPROXIMATION, AND SINCE L0 BRANCHES ON IT, HERE IS EXACTLY HOW FAR OFF ──────
 *
 * The JS half asks the precise question (`turn_id` is a key of the TOP-LEVEL envelope). The sh half has
 * no JSON parser, so it asks a structural approximation of it: after deleting all whitespace, does the
 * payload contain `{` or `,` immediately followed by `"turn_id":`? That is strictly narrower than the
 * bare substring test it replaced, and the tightening is not cosmetic — `bin/l0-allowlist.ts` now gates
 * an allowlist entry on this answer, so a wrong answer is a grant.
 *
 * WHAT IT CAN AND CANNOT DISTINGUISH:
 *
 *  - A Claude payload MENTIONING the key in a command — `grep '"turn_id":' x.json` — is answered
 *    `claude-code`, and not by luck: JSON escapes every `"` inside a string value, so the bytes on the
 *    wire are `\"turn_id\":`, which contains no `"turn_id":` at all. There is no spelling of a shell
 *    command that puts the RAW token into the payload.
 *  - A NESTED `turn_id` key — an MCP tool_input that happens to carry one — IS misread as `codex`.
 *    This is the residual gap and sh cannot close it. Do not write a JSON parser in sh to try.
 *
 * WHY THE RESIDUAL GAP IS NOT A PRIVILEGE ESCALATION, stated as the property to preserve rather than
 * as a reassurance: the ONLY thing the harness answer gates at L0 is `CODEX_READ_ALLOW_ERE`, which
 * admits nothing but a single, unredirected, unchained READ (`cat`/`head`/`tail`/`less`/`more`/`bat`,
 * or `sed -n '<range>p'`). Allowlist entry 1 — "any Read", with no path restriction — already grants
 * Claude Code the identical capability under every L0 fault. So a misclassification hands a Claude
 * session another SPELLING of a read it could already do, and never a capability it lacked. Anything
 * added to the aiType-gated set later must be checked against that property, because it is what makes
 * the approximation tolerable. `codex-l0-read.spec.ts` pins both halves of this.
 *
 * WHENEVER THE JS HALF IS RUNNING IT IS AUTHORITATIVE: the binary calls `detectAiType()` on the parsed
 * envelope (see `enforceCommittedShim`), so the approximation decides only faults D/X/U/K, where the
 * binary never runs at all.
 *
 * WIRED INTO THE RENDERED SHIM (`PARSE_PAYLOAD_SH` in ../bin/shim.ts), which is what makes the L0 audit
 * line's `ai=` field possible. Note the release ordering that governs the ARTIFACT rather than this
 * constant: `committedShimStale()` compares the committed `.claude/webpieces/ai-hook.sh` against
 * `renderShim()` of the INSTALLED release, so the committed shim is NOT regenerated in the same PR that
 * changes the renderer — it is regenerated after that release publishes, or by `wp-upgrade-shim`.
 */
export const AI_TYPE_TOKEN_SH = '"turn_id":';

/**
 * Sets `AI` to the literal `AiType` value — `codex` or `claude-code` — from `$PAYLOAD`. The values
 * are the SAME strings the TypeScript union carries, so the twin test can compare them byte for byte
 * instead of translating between two vocabularies (translation is where twins drift).
 *
 * Two steps, and both are load-bearing:
 *   1. `tr -d` deletes every whitespace byte into `WP_AI_ENV`, so the structural test below does not
 *      have to spell "optional whitespace" — which a POSIX `case` glob cannot express — and a
 *      pretty-printed envelope is read exactly like a compact one. The stripped copy is used for THIS
 *      test only; `$PAYLOAD` itself is untouched and stays the input every `sed` scrape reads.
 *   2. the glob requires `{` or `,` IMMEDIATELY before the quoted key, i.e. the structural context a
 *      real JSON key has and a mention inside a value does not.
 */
export const AI_TYPE_SH = `WP_AI_ENV="$(printf '%s' "$PAYLOAD" | tr -d ' \\t\\n\\r')"
case "$WP_AI_ENV" in *[{,]'${AI_TYPE_TOKEN_SH}'*) AI=codex ;; *) AI=claude-code ;; esac`;

/**
 * JS twin of AI_TYPE_SH. Asks the precise question the sh half approximates: is `turn_id` a key of
 * the top-level envelope?
 */
// webpieces-disable no-any-unknown -- the argument IS unparsed JSON from another process's stdout; naming a type here would assert a shape we have not yet established, which is the question this function exists to answer
// webpieces-disable no-function-outside-class -- twin of an sh fragment in the dependency-free adapter layer; it must stay callable on a tree too broken to build a DI container, exactly like isAllowed()
export function detectAiType(payload: unknown): AiType {
    if (payload === null || typeof payload !== 'object') return 'claude-code';
    // webpieces-disable no-any-unknown -- narrowing the same unparsed JSON; the index signature is the widest true statement about it
    return 'turn_id' in (payload as Record<string, unknown>) ? 'codex' : 'claude-code';
}
