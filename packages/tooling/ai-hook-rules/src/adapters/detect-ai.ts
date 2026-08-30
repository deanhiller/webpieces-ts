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
 * The sh half is an APPROXIMATION and says so out loud: it matches the six bytes `"turn_id":` in the
 * raw payload, so a Claude payload that happened to embed that exact quoted-key-with-colon spelling
 * inside a string value would be misread as Codex. Matching a JSON key from sh without a JSON parser
 * cannot do better, the spelling is contrived (an agent grepping for `turn_id` types it bare), and
 * the consequence of the miss is bounded: the Codex path is a SUPERSET of guards, never fewer.
 *
 * NOT WIRED INTO THE RENDERED SHIM IN THIS CHANGE. `committedShimStale()` compares the committed
 * `.claude/webpieces/ai-hook.sh` against `renderShim()` of the INSTALLED release, so changing the
 * renderer and regenerating the artifact together makes L0 fault S fire for everyone mid-upgrade.
 * The constant ships here first; the shim consumes it a release later.
 */
export const AI_TYPE_TOKEN_SH = '"turn_id":';

/**
 * Sets `AI` to the literal `AiType` value — `codex` or `claude-code` — from `$PAYLOAD`. The values
 * are the SAME strings the TypeScript union carries, so the twin test can compare them byte for byte
 * instead of translating between two vocabularies (translation is where twins drift).
 */
export const AI_TYPE_SH = `case "$PAYLOAD" in *'${AI_TYPE_TOKEN_SH}'*) AI=codex ;; *) AI=claude-code ;; esac`;

/**
 * JS twin of AI_TYPE_SH. Asks the precise question the sh half approximates: is `turn_id` a key of
 * the top-level envelope?
 */
// webpieces-disable no-function-outside-class -- twin of an sh fragment in the dependency-free adapter layer; it must stay callable on a tree too broken to build a DI container, exactly like isAllowed()
export function detectAiType(payload: unknown): AiType {
    if (payload === null || typeof payload !== 'object') return 'claude-code';
    return 'turn_id' in (payload as Record<string, unknown>) ? 'codex' : 'claude-code';
}
