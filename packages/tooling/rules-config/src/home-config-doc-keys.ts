import { injectable, bindingScopeValues } from 'inversify';

import { InformAiError } from './inform-ai-error';

/**
 * The documentation-key convention for `~/.webpieces/config.json`.
 *
 * ─── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────────
 * JSON has no comments, and that file is HAND-AUTHORED by a human on their own machine. So the only
 * way to leave a note in it used to be a key the loader would reject — which bought the note at the
 * price of a warning on EVERY `wp-*` run, in every repo on the machine.
 *
 * One machine's note read, in full caps: "THIS KEY IS ALWAYS REJECTED, AS A WARNING. THAT IS OK AND
 * EXPECTED — DO NOT 'FIX' IT." An agent read the warning, did not read the note, and offered to delete
 * the key to silence it. A warning that has to be explained away every time is a warning that trains
 * its readers to ignore warnings, so the convention is UNDERSTOOD now rather than merely tolerated:
 *
 *   `_doc`   — a note to whoever opens the file next.
 *   `_aiDoc` — a note addressed specifically to an AI agent reading it.
 *
 * Both are accepted anywhere a key may appear (top level and inside `experimental`), must be strings,
 * and are IGNORED. They are the only keys here whose presence and absence mean the same thing to the
 * loader. The leading `_` says "not a setting" at a glance.
 *
 * ─── ACCEPTED EVERYWHERE, ADVERTISED NOWHERE ──────────────────────────────────────────────────────
 * These names are deliberately NOT in `ALLOWED_TOP_LEVEL` or `ALLOWED_EXPERIMENTAL`. Those lists are
 * the SETTINGS, and they are walked elsewhere — by the spec, to build typed sample documents, and by
 * the "did you mean" hint. A documentation key has no typed value to contribute to a sample, and
 * offering `_doc` as the nearest match to a misspelled setting would send someone hunting for what it
 * configures. It configures nothing. `warnUnknownKeys` skips them; this class type-checks them.
 */
export const HOME_KEY_DOC = '_doc';
export const HOME_KEY_AI_DOC = '_aiDoc';
export const DOCUMENTATION_KEYS: readonly string[] = [HOME_KEY_DOC, HOME_KEY_AI_DOC];

/**
 * Type-checks the documentation keys. Split out of `home-config.ts` as its own cohesive unit — the
 * convention, its two names, and the one rule they carry.
 */
@injectable(bindingScopeValues.Singleton)
export class HomeDocKeys {
    /**
     * A documentation key holds PROSE, and holding anything else is an ERROR rather than a warning.
     *
     * `_doc: true` is not a note — it is somebody reaching for a setting and landing on the one key
     * name the loader promises to ignore. Left as a warning it would read as "accepted", because every
     * other accepted key in this file is a setting that does something. So the single thing these keys
     * enforce is that they really are prose, which is the same "known key, wrong type → REJECT" rule
     * the boolean and numeric keys already follow.
     *
     * `describeFile` is the loader's own file banner, passed in rather than rebuilt here, so a
     * rejection from this class is indistinguishable from any other rejection the loader renders.
     */
    // webpieces-disable no-any-unknown -- the document is user-authored and unvalidated at this point
    assertAreStrings(raw: Record<string, unknown>, prefix: string, describeFile: (m: string) => string): void {
        for (const key of DOCUMENTATION_KEYS) {
            const value = raw[key];
            if (value === undefined || typeof value === 'string') continue;
            throw new InformAiError(describeFile(
                `"${prefix}${key}" is a documentation key and must be a string. It holds a note for ` +
                `whoever reads this file next and is otherwise IGNORED — it is not a setting, so a ` +
                `${typeof value} here means a real setting was intended. Write the note as a string, ` +
                `or use the key you actually meant.`));
        }
    }

    /** True for a key this convention owns, so the unknown-key warning can skip it. */
    isDocumentationKey(key: string): boolean {
        return DOCUMENTATION_KEYS.includes(key);
    }
}
