/**
 * One retired `~/.webpieces/config.json` key and the mechanical edit that replaces it. Data-only.
 *
 * This mirrors `RetiredConfigKey` rather than reusing it: that table's entries carry a `scope`
 * (rule-name vs key-in-section) that describes webpieces.config.json's two-level layout and means
 * nothing here, and its `label` convention names that file's sections. One shared class covering both
 * would be a type with fields that are dead for half its instances.
 */
export class RetiredHomeConfigKey {
    // Dotted path exactly as it appears in the file, e.g. `experimental.captureBuildGateLog`.
    key: string;
    // Where the value goes now. Empty when the key is deleted outright.
    movedTo: string;
    // The imperative fix, written for the agent that will apply it verbatim.
    instruction: string;

    constructor(key: string, movedTo: string, instruction: string) {
        this.key = key;
        this.movedTo = movedTo;
        this.instruction = instruction;
    }
}

/**
 * Every retired home-config key — the ONE place in the codebase where a dead home-config key may be
 * named, exactly as `RETIRED_CONFIG_KEYS` is for webpieces.config.json. Newest at the bottom.
 *
 * When you retire a key here, DELETE its read path in the same change. `home-config.spec.ts` asserts
 * every entry below actually FAILS the load, so a fallback that quietly accepts one turns it red.
 */
export const RETIRED_HOME_CONFIG_KEYS: readonly RetiredHomeConfigKey[] = [
    // `captureBuildGateLog` was the working name while the build-log feature was being built, and it
    // appears in the branch history and in in-flight drafts, so it is exactly the spelling an agent
    // reconstructing the file from memory will type. It never shipped in a release; it is listed so that
    // typing it produces the DELETION instruction rather than a bare "unknown key". It used to point at
    // `experimental.buildGateLogCapture`; that key is itself gone now (capture is unconditional), so the
    // destination is "no replacement, delete it" and this entry is the only place either name survives.
    new RetiredHomeConfigKey(
        'experimental.captureBuildGateLog', '',
        'Delete the key. Capturing the build gate\'s output to a log file is no longer optional — every ' +
        'build the PR gate runs writes its full output to a file and prints a "FullLog :" pointer at it.',
    ),
];

/**
 * An experiment a HUMAN ended, and the sentence that says so.
 *
 * Distinct from `RETIRED_HOME_CONFIG_KEYS`, and deliberately not merged with it: a retired key is a
 * HARD FAILURE on exact match, which is too harsh for a machine-global hand-authored file — somebody
 * who opted INTO a behaviour they now get unconditionally must not have their shell broken for saying
 * yes early. So an ended experiment falls through to the unknown-key WARNING, and this table only
 * makes that warning SAY something.
 *
 * The gap it closes is the one that produced this table. `buildGateLogCapture` was deleted and capture
 * made unconditional; its owner's config still said `true`, and every `wp-*` run told him only that the
 * key "is not a key this @webpieces release understands" — which reads like a typo or a version skew,
 * not like an answer. His actual question was "how did that happen?", and nothing on screen answered it.
 */
export class EndedExperiment {
    // Dotted path exactly as it appears in the file.
    key: string;
    // The release in which the experiment ended.
    endedIn: string;
    // What replaced it, and what to do with the key now. Written for whoever reads the warning.
    note: string;

    constructor(key: string, endedIn: string, note: string) {
        this.key = key;
        this.endedIn = endedIn;
        this.note = note;
    }
}

export const ENDED_EXPERIMENTS: readonly EndedExperiment[] = [
    new EndedExperiment(
        'experimental.buildGateLogCapture', '0.4.693',
        'Capturing the build gate\'s output to a log file is UNCONDITIONAL now, so this flag switches ' +
        'nothing — you already have what it asked for. Delete the key.'),
];
