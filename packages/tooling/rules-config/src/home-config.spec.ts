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
     */
    it('accepts a file that omits ANY given key — a required key would be unsatisfiable across versions', () => {
        const everyKey: string[] = [
            HOME_KEY_WHOLE_REPO_BUILD_GUARD, HOME_KEY_ORPHAN_DIR_SWEEP, HOME_KEY_BUILD_GATE_LOG_CAPTURE,
        ];
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

    it('rejects an unknown top-level key, naming the only key the file accepts', () => {
        const home = fakeHome();
        writeConfig(home, JSON.stringify({ experimentl: { buildGateLogCapture: true } }));
        const msg = loadError(home).message;
        expect(msg).toContain('"experimentl" is not a known key');
        expect(msg).toContain(`"${HOME_EXPERIMENTAL_SECTION}.${HOME_KEY_BUILD_GATE_LOG_CAPTURE}"`);
    });

    it('rejects an unknown key inside experimental, naming the valid key', () => {
        const home = fakeHome();
        writeConfig(home, JSON.stringify({ experimental: { buildGateLogCaptured: true } }));
        const msg = loadError(home).message;
        expect(msg).toContain('"experimental.buildGateLogCaptured" is not a known key');
        expect(msg).toContain(`"${HOME_EXPERIMENTAL_SECTION}.${HOME_KEY_BUILD_GATE_LOG_CAPTURE}"`);
    });

    it('offers "did you mean" for a case-only typo', () => {
        const home = fakeHome();
        writeConfig(home, JSON.stringify({ experimental: { buildgatelogcapture: true } }));
        expect(loadError(home).message).toContain('Did you mean "experimental.buildGateLogCapture"?');
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
        const p = writeConfig(home, JSON.stringify({ nope: 1 }));
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

    // Retirement must be reported BEFORE "unknown key": the latter sends an agent DELETING a value it
    // should be MOVING, which is the whole reason the table exists.
    it('reports a retired key as retired rather than as unknown', () => {
        const home = fakeHome();
        writeConfig(home, JSON.stringify({ experimental: { captureBuildGateLog: true } }));
        const msg = loadError(home).message;
        expect(msg).toContain('is RETIRED');
        expect(msg).not.toContain('is not a known key');
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
