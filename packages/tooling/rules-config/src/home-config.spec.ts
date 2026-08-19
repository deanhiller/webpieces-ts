import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { InformAiError } from './inform-ai-error';
import { toError } from './to-error';
import {
    HomeConfig, HomeConfigService, RETIRED_HOME_CONFIG_KEYS,
    HOME_EXPERIMENTAL_SECTION, HOME_KEY_BUILD_GATE_LOG_CAPTURE, HOME_KEY_WHOLE_REPO_BUILD_GUARD,
    HOME_KEY_ORPHAN_DIR_SWEEP, WHOLE_REPO_BUILD_GUARD_DEFAULT,
    ALLOWED_EXPERIMENTAL, ALLOWED_TOP_LEVEL,
} from './home-config';

const dirs: string[] = [];

afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A fake HOME. Nothing in this suite may touch the real `~/.webpieces/config.json`. */
function fakeHome(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-homeconf-'));
    dirs.push(dir);
    return dir;
}

function writeConfig(home: string, contents: string): string {
    const p = path.join(home, '.webpieces', 'config.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, contents);
    return p;
}

/**
 * Everything the loader wrote to stderr while `body` ran. The unknown-key WARNING is now the entire
 * mitigation for ignoring a key, so it is a behaviour with tests, not incidental logging — which means
 * the suite has to read the channel it actually goes to.
 */
function captureWarnings(body: () => void): string {
    const original = process.stderr.write.bind(process.stderr);
    let captured = '';
    // webpieces-disable no-any-unknown -- matching node's own overloaded write() signature to restore it
    process.stderr.write = ((chunk: unknown): boolean => { captured += String(chunk); return true; }) as
        typeof process.stderr.write;
    // webpieces-disable no-unmanaged-exceptions -- chokepoint: stderr MUST be restored even when body throws
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        body();
    } finally {
        process.stderr.write = original;
    }
    return captured;
}

function loadError(home: string): InformAiError {
    let caught: Error | null = null;
    // webpieces-disable no-unmanaged-exceptions -- chokepoint: the rejection IS the assertion subject
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        new HomeConfigService().load(home);
    } catch (err: unknown) {
        const error = toError(err);
        caught = error;
    }
    if (caught === null) throw new Error('the home config was expected to be REJECTED and was not');
    expect(caught).toBeInstanceOf(InformAiError);
    return caught as InformAiError;
}

/**
 * ══ THE CASE THAT PROTECTS EVERY OTHER USER OF THESE PACKAGES ═══════════════════════════════════════
 *
 * `~/.webpieces/config.json` is OPTIONAL and EXPERIMENTAL, and essentially nobody has one. For all of
 * them the loader must return all-defaults SILENTLY: no throw, no warning, no file created, no
 * behaviour change of any kind. Absence is not a wrong format — it is the normal, supported state, and
 * it is the one path that may never reach an error branch.
 *
 * If any test in this block goes red, the change is wrong regardless of what else passes.
 */
describe('ABSENT ~/.webpieces/config.json — the default state, and never an error', () => {
    it('returns all-defaults when the file does not exist', () => {
        expect(new HomeConfigService().load(fakeHome()).buildGateLogCapture).toBe(false);
    });

    it('returns all-defaults when the ~/.webpieces DIRECTORY does not exist either', () => {
        const home = fakeHome();
        expect(fs.existsSync(path.join(home, '.webpieces'))).toBe(false);
        expect(new HomeConfigService().load(home).buildGateLogCapture).toBe(false);
    });

    it('returns all-defaults when ~/.webpieces is a FILE rather than a directory (ENOTDIR)', () => {
        const home = fakeHome();
        fs.writeFileSync(path.join(home, '.webpieces'), 'not a directory\n');
        expect(new HomeConfigService().load(home).buildGateLogCapture).toBe(false);
    });

    it('returns all-defaults when a DIRECTORY sits where config.json belongs (EISDIR)', () => {
        const home = fakeHome();
        fs.mkdirSync(path.join(home, '.webpieces', 'config.json'), { recursive: true });
        expect(new HomeConfigService().load(home).buildGateLogCapture).toBe(false);
    });

    it('returns all-defaults when the file is unreadable (EACCES)', () => {
        // Running as root defeats mode bits, so the case is unobservable there.
        if (process.getuid !== undefined && process.getuid() === 0) return;
        const home = fakeHome();
        const p = writeConfig(home, '{}');
        fs.chmodSync(p, 0o000);
        expect(new HomeConfigService().load(home).buildGateLogCapture).toBe(false);
        fs.chmodSync(p, 0o600);
    });

    it('creates nothing on disk when the file is absent', () => {
        const home = fakeHome();
        new HomeConfigService().load(home);
        expect(fs.readdirSync(home)).toEqual([]);
    });

    it('defaults every flag OFF on the bare data class too', () => {
        expect(new HomeConfig(false, false, false).buildGateLogCapture).toBe(false);
        expect(new HomeConfig(false, false, false).wholeRepoBuildGuard).toBe(false);
    });

    /**
     * whole-repo-build-guard reads ON with no file — it is not experimental any more, and OFF-by-default
     * is precisely why it never fired (a guard nobody opts into prevents nothing).
     *
     * This is NOT the release that blocked every consumer's Bash calls. That one required an entry in the
     * repo-tracked webpieces.config.json and failed at config LOAD when it was missing, so the cure was
     * "edit a file to get your shell back". Here nothing has to exist, and the only thing that can be
     * refused is a command that genuinely builds the world.
     */
    it('reports whole-repo-build-guard ON when the file does not exist', () => {
        expect(new HomeConfigService().load(fakeHome()).wholeRepoBuildGuard).toBe(true);
        expect(WHOLE_REPO_BUILD_GUARD_DEFAULT).toBe(true);
    });
});

describe('PRESENT ~/.webpieces/config.json — accepted shapes', () => {
    it('is ON for the exact documented shape', () => {
        const home = fakeHome();
        writeConfig(home, JSON.stringify({ experimental: { 'whole-repo-build-guard': false, 'orphan-dir-sweep': false, buildGateLogCapture: true } }));
        expect(new HomeConfigService().load(home).buildGateLogCapture).toBe(true);
    });

    it('is OFF for an explicit false — declining a preference is not an error', () => {
        const home = fakeHome();
        writeConfig(home, JSON.stringify({ experimental: { 'whole-repo-build-guard': false, 'orphan-dir-sweep': false, buildGateLogCapture: false } }));
        expect(new HomeConfigService().load(home).buildGateLogCapture).toBe(false);
    });

    it('reads whole-repo-build-guard true and false, independently of buildGateLogCapture', () => {
        for (const on of [true, false]) {
            const home = fakeHome();
            writeConfig(home, JSON.stringify({ experimental: { 'whole-repo-build-guard': on, 'orphan-dir-sweep': false } }));
            const loaded = new HomeConfigService().load(home);
            expect(loaded.wholeRepoBuildGuard).toBe(on);
            // The two keys are different features (#620's log capture vs this guard) and neither implies
            // the other — buildGateLogCapture stays optional and defaults OFF.
            expect(loaded.buildGateLogCapture).toBe(false);
        }
    });
});

/**
 * A file that EXISTS was deliberately created, so from here the policy is webpieces.config.json's: reject
 * the wrong shape and name the exact fix. There is no `??` fallback and no silently-ignored key — an
 * accepted shape is never migrated, and every reader of this file is a coding agent.
 */
describe('PRESENT ~/.webpieces/config.json — rejected shapes', () => {
    /**
     * ══ THE CROSS-VERSION INVARIANT — no key here may ever become REQUIRED ══════════════════════════
     *
     * This file is MACHINE-GLOBAL and the repos on a machine pin DIFFERENT webpieces releases. A
     * required key makes the set of valid files EMPTY: omit it and the new release rejects the file,
     * add it and every older release rejects it as unknown. Both rejections block.
     *
     * So every key must load from a file that does not mention it. This test enumerates the accepted
     * keys one at a time and asserts each is independently omittable — it goes red the moment somebody
     * reintroduces a required read, which is the mistake this suite exists to prevent.
     *
     * IT WALKS `ALLOWED_EXPERIMENTAL` ITSELF, not a hand-written copy of it. That is the point of the
     * export: a list restated here would cover the keys that existed the day it was written, so the NEXT
     * key added to the loader would silently escape the invariant — and nobody would find out until an
     * older release on somebody else's repo started rejecting the file. Walking the real constant makes a
     * new key covered the moment it appears.
     */
    it('accepts a file that omits ANY given key — a required key would be unsatisfiable across versions', () => {
        const everyKey: readonly string[] = ALLOWED_EXPERIMENTAL;
        // A guard on the guard: an empty (or accidentally emptied) list would make the loop vacuous and
        // this test green for the wrong reason.
        expect(everyKey.length).toBeGreaterThan(0);
        for (const omitted of everyKey) {
            const experimental: Record<string, boolean> = {};
            for (const key of everyKey) if (key !== omitted) experimental[key] = false;
            const home = fakeHome();
            writeConfig(home, JSON.stringify({ experimental }));
            const loaded = new HomeConfigService().load(home);
            // Every PRESENT key was written `false`, so each assertion below reads the key's DECLARED
            // default when it is the omitted one and `false` otherwise. Writing `false` rather than
            // `true` is what keeps this meaningful for whole-repo-build-guard: with `true` both branches
            // would evaluate to true and the loop would stop distinguishing "omitted" from "present".
            expect(loaded.wholeRepoBuildGuard).toBe(
                omitted === HOME_KEY_WHOLE_REPO_BUILD_GUARD ? WHOLE_REPO_BUILD_GUARD_DEFAULT : false);
            expect(loaded.orphanDirSweep).toBe(false);
            expect(loaded.buildGateLogCapture).toBe(false);
        }
    });

    /**
     * The empty document is the same case as no file at all, and the two must AGREE key for key —
     * a machine that creates `{}` may not silently get different behaviour from one with no file.
     * Experimental flags read off; `whole-repo-build-guard` reads its on-by-default value.
     */
    it('accepts an empty document, reading exactly what the absent file reads', () => {
        for (const body of ['{}', JSON.stringify({ experimental: {} })]) {
            const home = fakeHome();
            writeConfig(home, body);
            const loaded = new HomeConfigService().load(home);
            expect(loaded.wholeRepoBuildGuard).toBe(WHOLE_REPO_BUILD_GUARD_DEFAULT);
            expect(loaded.orphanDirSweep).toBe(false);
            expect(loaded.buildGateLogCapture).toBe(false);
        }
    });

    /**
     * THE PROMOTION, pinned. `whole-repo-build-guard` shipped OFF-by-default and therefore never fired:
     * a guard nobody opts into does not prevent anything, which is how a sibling repo's `ci:local`
     * verify chain went on running three whole-world passes per inner loop for months. It is ON for
     * every tree now, and turning it off is one machine-local line — nothing has to be ADDED anywhere
     * to be in the default state, which is what separates this from the required-key outage that got
     * the repo-config spelling retired.
     */
    it('goes OFF only when a machine says so out loud', () => {
        const home = fakeHome();
        writeConfig(home, JSON.stringify({ experimental: { [HOME_KEY_WHOLE_REPO_BUILD_GUARD]: false } }));
        expect(new HomeConfigService().load(home).wholeRepoBuildGuard).toBe(false);
    });

    it('rejects a non-boolean whole-repo-build-guard, showing the value it got', () => {
        const home = fakeHome();
        writeConfig(home, JSON.stringify({ experimental: { 'whole-repo-build-guard': 'true' } }));
        const msg = loadError(home).message;
        expect(msg).toContain('must be the boolean');
        expect(msg).toContain('"true"');
    });

    it('rejects a non-boolean value, showing the value it got', () => {
        const home = fakeHome();
        writeConfig(home, JSON.stringify({ experimental: { buildGateLogCapture: 'true' } }));
        const msg = loadError(home).message;
        expect(msg).toContain('must be the boolean');
        expect(msg).toContain('"true"');
    });

    it('rejects a non-object experimental section', () => {
        const home = fakeHome();
        writeConfig(home, JSON.stringify({ experimental: [true] }));
        expect(loadError(home).message).toContain('"experimental" must be a JSON object');
    });

    // A PRESENT but unparseable file is the "wrong format" case, not the absent case.
    it('rejects unparseable JSON', () => {
        const home = fakeHome();
        writeConfig(home, '{ "experimental": { "buildGateLogCapture": tru');
        expect(loadError(home).message).toContain('not valid JSON');
    });

    it('rejects a document that is not a JSON object', () => {
        for (const body of ['[]', '"on"', 'null', '7']) {
            const home = fakeHome();
            writeConfig(home, body);
            expect(loadError(home).message).toContain('single JSON OBJECT');
        }
    });

    // Every rejection must say the file is optional and that deleting it is a legal fix — otherwise an
    // agent that cannot work out the right shape has no exit.
    it('always names the file and says deleting it is a valid fix', () => {
        const home = fakeHome();
        const p = writeConfig(home, JSON.stringify({ experimental: { buildGateLogCapture: 1 } }));
        const msg = loadError(home).message;
        expect(msg).toContain(p);
        expect(msg).toContain('deleting it outright is a valid fix');
    });
});

/**
 * THE POLICY GUARD, mirroring `retired-config-keys.spec.ts`: a retired key must FAIL the load with an
 * instruction naming its destination. If someone re-adds a fallback that quietly accepts one, this goes red.
 */
describe('RETIRED_HOME_CONFIG_KEYS — the no-back-compat guard', () => {
    it('has at least one entry (an empty table would make every case below vacuous)', () => {
        expect(RETIRED_HOME_CONFIG_KEYS.length).toBeGreaterThan(0);
    });

    it('never lists a key as its own destination, and always carries an instruction', () => {
        for (const entry of RETIRED_HOME_CONFIG_KEYS) {
            expect(entry.movedTo).not.toBe(entry.key);
            expect(entry.instruction.trim().length).toBeGreaterThan(0);
        }
    });

    it('actually FAILS the load, naming the destination and the mechanical edit', () => {
        for (const entry of RETIRED_HOME_CONFIG_KEYS) {
            const home = fakeHome();
            const parts = entry.key.split('.');
            const doc: Record<string, unknown> = parts.length === 1
                ? { [parts[0]]: true }
                : { [parts[0]]: { [parts[1]]: true } };
            writeConfig(home, JSON.stringify(doc));
            const msg = loadError(home).message;
            expect(msg).toContain(`"${entry.key}" is RETIRED`);
            if (entry.movedTo === '') expect(msg).toContain('removed with no replacement');
            else expect(msg).toContain(entry.movedTo);
            expect(msg).toContain(entry.instruction);
        }
    });

    /**
     * RETIRED IS NOT "UNKNOWN", AND THIS IS THE ASSERTION THAT KEEPS THE TWO APART.
     *
     * Since an unrecognised key is now IGNORED with a warning, a retirement that fell through to the
     * unknown path would not merely print the wrong words — it would silently drop a value the user
     * wanted, while telling them their spelling might be off. The retirement table exists precisely
     * because these keys carry a MIGRATION, so they must throw, and they must throw first.
     */
    it('reports a retired key as retired, and never as a merely-unrecognised one', () => {
        const home = fakeHome();
        writeConfig(home, JSON.stringify({ experimental: { captureBuildGateLog: true } }));
        const msg = loadError(home).message;
        expect(msg).toContain('is RETIRED');
        expect(msg).not.toContain('was IGNORED');
    });

    it('emits no unknown-key warning for a retired key — it throws before reaching that path', () => {
        const home = fakeHome();
        writeConfig(home, JSON.stringify({ experimental: { captureBuildGateLog: true } }));
        const warnings = captureWarnings((): void => { loadError(home); });
        expect(warnings).toBe('');
    });
});

/**
 * ══ FORWARD COMPATIBILITY — THE OTHER HALF OF "NO KEY MAY BE REQUIRED" ══════════════════════════════
 *
 * `~/.webpieces/config.json` is MACHINE-GLOBAL: ONE document, read by EVERY repo on the machine, and
 * those repos pin DIFFERENT @webpieces releases. For the set of valid documents to be non-empty across
 * all of them at once, BOTH of these must hold:
 *
 *   • omitting a key must not fail  → already guaranteed above ("accepts a file that omits ANY key")
 *   • ADDING a key must not fail    → this block
 *
 * With only the first, adding any new key hard-blocked every repo on the machine still on an older
 * release — an outage caused by opting in to an experimental flag. This is deliberately the OPPOSITE
 * policy from webpieces.config.json, which is repo-tracked and therefore read by exactly one release;
 * see the class docblock in home-config.ts for the full argument.
 */
describe('an UNKNOWN key is ignored, not rejected — because older releases share this file', () => {
    /**
     * THE OTHER HALF OF THE INVARIANT, pinned the same way: walk `ALLOWED_EXPERIMENTAL` itself, write
     * every known key alongside a key nothing has ever heard of, and assert the document still LOADS
     * with each known key read correctly. Together with the omit-any-key test above, the pair says the
     * whole rule — an OLD file loads on a NEW release, and a NEW file loads on an OLD one — and both
     * automatically cover any key added to the loader later.
     */
    it('loads every known key correctly even when an unknown key sits beside them', () => {
        expect(ALLOWED_EXPERIMENTAL.length).toBeGreaterThan(0);
        const experimental: Record<string, boolean> = { 'a-key-from-the-future': true };
        for (const key of ALLOWED_EXPERIMENTAL) experimental[key] = true;
        const home = fakeHome();
        writeConfig(home, JSON.stringify({ experimental, aSectionFromTheFuture: { nested: 1 } }));
        const loaded = new HomeConfigService().load(home);
        expect(loaded.wholeRepoBuildGuard).toBe(true);
        expect(loaded.orphanDirSweep).toBe(true);
        expect(loaded.buildGateLogCapture).toBe(true);
        // …and the section that IS known is still the only one read, so a future sibling section cannot
        // change what this release does.
        expect(ALLOWED_TOP_LEVEL).toContain(HOME_EXPERIMENTAL_SECTION);
    });

    it('loads a file carrying a key from a hypothetical newer release', () => {
        const home = fakeHome();
        writeConfig(home, JSON.stringify({
            experimental: { 'whole-repo-build-guard': true, 'some-future-flag': true },
        }));
        const loaded = new HomeConfigService().load(home);
        expect(loaded.wholeRepoBuildGuard).toBe(true);
    });

    it('ignores an unknown TOP-LEVEL section, so a future release may add one beside experimental', () => {
        const home = fakeHome();
        writeConfig(home, JSON.stringify({
            preferences: { theme: 'dark' },
            experimental: { [HOME_KEY_ORPHAN_DIR_SWEEP]: true },
        }));
        const loaded = new HomeConfigService().load(home);
        expect(loaded.orphanDirSweep).toBe(true);
    });

    /**
     * The cost of ignoring is that a TYPO now silently does nothing, and the warning is the entire
     * mitigation for it. If these go red the change has become a silent one, which was never the deal.
     */
    it('WARNS that the key was ignored, naming it and the keys it does understand', () => {
        const home = fakeHome();
        writeConfig(home, JSON.stringify({ experimental: { 'some-future-flag': true } }));
        const warnings = captureWarnings((): void => { new HomeConfigService().load(home); });
        expect(warnings).toContain('experimental.some-future-flag');
        expect(warnings).toContain('IGNORED');
        expect(warnings).toContain(`"${HOME_EXPERIMENTAL_SECTION}.${HOME_KEY_BUILD_GATE_LOG_CAPTURE}"`);
    });

    // The "understood here" list is rendered at the LEVEL the bad key was found, so a mistyped section
    // is answered with the sections rather than with a list of flags that could not go there anyway.
    it('warns about an unknown top-level key, listing the sections rather than the flags', () => {
        const home = fakeHome();
        writeConfig(home, JSON.stringify({ experimentl: { buildGateLogCapture: true } }));
        const warnings = captureWarnings((): void => { new HomeConfigService().load(home); });
        expect(warnings).toContain('"experimentl"');
        expect(warnings).toContain(`Did you mean "${HOME_EXPERIMENTAL_SECTION}"?`);
        expect(warnings).toContain(`Understood here: "${HOME_EXPERIMENTAL_SECTION}".`);
    });

    // The did-you-mean is what separates "you mistyped" from "this is newer than me", and it has to be
    // fuzzier than the case-insensitive equality it replaced — a rejection used to be the signal, and
    // now the suggestion is.
    it('suggests the near match for a one-character typo', () => {
        const home = fakeHome();
        writeConfig(home, JSON.stringify({ experimental: { buildGateLogCaptured: true } }));
        const warnings = captureWarnings((): void => { new HomeConfigService().load(home); });
        expect(warnings).toContain(`Did you mean "${HOME_EXPERIMENTAL_SECTION}.${HOME_KEY_BUILD_GATE_LOG_CAPTURE}"?`);
    });

    it('suggests the near match for a case-only typo, as it always did', () => {
        const home = fakeHome();
        writeConfig(home, JSON.stringify({ experimental: { buildgatelogcapture: true } }));
        const warnings = captureWarnings((): void => { new HomeConfigService().load(home); });
        expect(warnings).toContain(`Did you mean "${HOME_EXPERIMENTAL_SECTION}.${HOME_KEY_BUILD_GATE_LOG_CAPTURE}"?`);
    });

    /**
     * A near-miss of a RETIRED key gets that key's MIGRATION, not the generic "might be newer" line.
     *
     * `assertNotRetired` matches exactly, so `captureBuildGateLog` throws with its rename while
     * `captureBuildGateLogg` — one character away, and the likelier thing to actually type — used to fall
     * through to the least useful of the three answers. It stays a WARNING rather than becoming a throw:
     * this release cannot know which key was meant, and guessing wrong in the throwing direction is the
     * thing this whole change removes.
     */
    it('points a near-miss of a RETIRED key at its migration instruction', () => {
        const retired = RETIRED_HOME_CONFIG_KEYS[0];
        const typo = `${retired.key.split('.')[1]}g`;
        const home = fakeHome();
        writeConfig(home, JSON.stringify({ experimental: { [typo]: true } }));
        const warnings = captureWarnings((): void => { new HomeConfigService().load(home); });
        expect(warnings).toContain(`RETIRED key "${retired.key}"`);
        expect(warnings).toContain(retired.instruction);
    });

    // A live key always wins the suggestion — a typo of something that still exists must never be
    // answered with a dead key's migration.
    it('prefers a near KNOWN key over a near RETIRED one', () => {
        const home = fakeHome();
        writeConfig(home, JSON.stringify({ experimental: { buildGateLogCaptur: true } }));
        const warnings = captureWarnings((): void => { new HomeConfigService().load(home); });
        expect(warnings).toContain(`Did you mean "${HOME_EXPERIMENTAL_SECTION}.${HOME_KEY_BUILD_GATE_LOG_CAPTURE}"?`);
        expect(warnings).not.toContain('RETIRED');
    });

    // A genuinely NEW key must NOT be dressed up as a typo — that would send an agent "fixing" the
    // spelling of a key that is spelled correctly for the release that introduced it.
    it('does not guess a near match for a key that resembles nothing, and says why it might be there', () => {
        const home = fakeHome();
        writeConfig(home, JSON.stringify({ experimental: { 'telemetry-opt-in': true } }));
        const warnings = captureWarnings((): void => { new HomeConfigService().load(home); });
        expect(warnings).not.toContain('Did you mean');
        expect(warnings).toContain('NEWER @webpieces');
    });

    /** An understood file stays completely silent — the absent-file promise extended to a valid one. */
    it('says nothing at all when every key is understood', () => {
        const home = fakeHome();
        writeConfig(home, JSON.stringify({ experimental: { [HOME_KEY_WHOLE_REPO_BUILD_GUARD]: true } }));
        const warnings = captureWarnings((): void => { new HomeConfigService().load(home); });
        expect(warnings).toBe('');
    });

    /**
     * The one thing an unknown key must NOT do is change behaviour: a document of nothing but unknown
     * keys has to read byte-for-byte like the no-file state — the same promise the absent-file block
     * makes. Asserted against the DEFAULT constants rather than literal booleans, because
     * `whole-repo-build-guard` defaults ON and hard-coding `false` here would silently re-assert the
     * opt-in it stopped being.
     */
    it('leaves every flag at its default when the file contains only unknown keys', () => {
        const home = fakeHome();
        writeConfig(home, JSON.stringify({ experimental: { 'some-future-flag': true }, alsoFuture: true }));
        const loaded = new HomeConfigService().load(home);
        const absent = new HomeConfigService().load(fakeHome());
        expect(loaded.wholeRepoBuildGuard).toBe(absent.wholeRepoBuildGuard);
        expect(loaded.orphanDirSweep).toBe(absent.orphanDirSweep);
        expect(loaded.buildGateLogCapture).toBe(absent.buildGateLogCapture);
    });
});

/**
 * The carve-out that makes strict rejection safe: the hook guards grant an unconditional Write/Edit PASS
 * to this path, so an agent is never blocked from repairing the file the loader just rejected. Every
 * spelling an agent actually writes must resolve, or the carve-out silently does not apply.
 */
describe('isHomeConfigPath — the guard carve-out', () => {
    const home = '/home/me';

    it('matches the absolute path', () => {
        expect(new HomeConfigService().isHomeConfigPath('/home/me/.webpieces/config.json', home)).toBe(true);
    });

    it('matches the ~ form', () => {
        expect(new HomeConfigService().isHomeConfigPath('~/.webpieces/config.json', home)).toBe(true);
    });

    it('matches the $HOME and ${HOME} forms', () => {
        expect(new HomeConfigService().isHomeConfigPath('$HOME/.webpieces/config.json', home)).toBe(true);
        expect(new HomeConfigService().isHomeConfigPath('${HOME}/.webpieces/config.json', home)).toBe(true);
    });

    it('matches a non-normalized path', () => {
        expect(new HomeConfigService().isHomeConfigPath('/home/me/x/../.webpieces/./config.json', home)).toBe(true);
    });

    it('does NOT match a repo-local .webpieces/config.json, nor anything else under home', () => {
        const svc = new HomeConfigService();
        expect(svc.isHomeConfigPath('/repo/.webpieces/config.json', home)).toBe(false);
        expect(svc.isHomeConfigPath('/home/me/.webpieces/logs/x.log', home)).toBe(false);
        expect(svc.isHomeConfigPath('/home/me/webpieces.config.json', home)).toBe(false);
        expect(svc.isHomeConfigPath('', home)).toBe(false);
    });
});
