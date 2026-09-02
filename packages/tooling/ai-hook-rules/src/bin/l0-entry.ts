/**
 * THE L0 ENTRY TYPES — the shape of one allowlist entry, split out of ./l0-allowlist.
 *
 * Same reason `./l0-codex-read` and `./l0-ignored-tools` are their own modules: the LIST is long and
 * every entry carries a paragraph of reasoning, so the types that describe an entry get crowded out
 * by the entries themselves. Nothing here knows what is on the list; `./l0-allowlist` owns that and
 * imports these, so the dependency runs one way and there is no cycle.
 *
 * NOT re-exported from here onward — `./shim` is the ONE name that gathers L0, and it stars this
 * module alongside the others.
 */

import { AiType } from '../core/agent-event';

/**
 * The token an L0 entry uses to say it serves EVERY harness — SAID OUT LOUD.
 *
 * This used to be `null`, and `null` is shim shape #5 from CLAUDE.md: a widening expressed as an
 * ABSENCE. It made the widest setting the shortest thing to type and, worse, impossible to grep —
 * there is no search that lists "the entries every harness gets", because they were identified by
 * a field that was not there. `grep -n EVERY_HARNESS` now lists every one of them.
 *
 * It is a REAL VALUE in exactly the sense `AI_TYPE_UNKNOWN` is: countable, greppable, and typed.
 */
export const EVERY_HARNESS = 'every-harness';

/**
 * Who one L0 entry is FOR: exactly one harness, or — named, never implied — all of them.
 *
 * Deliberately NOT `readonly AiType[]`. A list re-opens the hole this closed from the other side:
 * `[]` would be a second way to write "nobody", and `['claude-code', 'codex']` a second way to write
 * EVERY_HARNESS — two spellings of one decision, which is shim shape #1. Dean's rule is the whole
 * type: we only support codex or claudecode or FAIL.
 */
export type L0Harness = AiType | typeof EVERY_HARNESS;

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
 *
 * `cure` is the ONE thing that is not uniform across the list, and it is not about L0 at all — see
 * L0_CURE_ALLOW_JS below. Every entry is judged identically while an L0 fault is up; `cure` decides
 * only whether the entry ALSO bypasses the downstream (L1) guards on a HEALTHY tree.
 */
export class L0AllowEntry {
    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        readonly label: string,
        readonly kind: 'pass' | 'allow',
        /**
         * True when this entry REPAIRS the tooling (install, sync, shim restore). A cure has to run
         * before webpieces.config.json can even be loaded, so it bypasses everything, always. A
         * non-cure (read-only orientation) is allowed while a fault is up and is otherwise an ordinary
         * command the downstream guards still judge.
         */
        readonly cure: boolean,
        readonly ere: string | null,
        readonly js: string | null,
        /**
         * The ONE harness this entry exists for, or `EVERY_HARNESS` for the entries every harness gets.
         * There is no default and no absence: an entry must say which it is, or it does not compile.
         *
         * A gated entry is unreachable from any other harness — it is spliced into its own union, which
         * both halves of L0 consult only after answering "which harness sent this call?". It exists
         * because the two harnesses do not have the same TOOLS: `Read` is entry 1 for Claude Code and
         * Codex has no such tool, so read parity at L0 can only be expressed per harness. Anything added
         * here later must satisfy the property stated on AI_TYPE_SH: the sh half's answer is an
         * approximation, so a gated entry may never grant more than the OTHER harness already has.
         */
        readonly harness: L0Harness,
        readonly sample: L0Call,
        readonly extraSamples: readonly L0Call[] = [],
    ) {}

    /** Every call this entry pins: the canonical sample plus every extra spelling. */
    allSamples(): readonly L0Call[] {
        return [this.sample, ...this.extraSamples];
    }
}


