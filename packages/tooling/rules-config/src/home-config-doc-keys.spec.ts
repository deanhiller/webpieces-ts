import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { InformAiError } from './inform-ai-error';
import { toError } from './to-error';
import {
    DEFAULT_MAX_CONCURRENT_BUILDS, HomeConfig, HomeConfigService,
    HOME_EXPERIMENTAL_SECTION, HOME_KEY_ORPHAN_DIR_SWEEP,
    ALLOWED_EXPERIMENTAL, ALLOWED_TOP_LEVEL,
} from './home-config';
import { DOCUMENTATION_KEYS, HOME_KEY_DOC, HOME_KEY_AI_DOC } from './home-config-doc-keys';
import { ENDED_EXPERIMENTS } from './home-config-retired-keys';

const dirs: string[] = [];

afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A fake HOME. Nothing in this suite may touch the real `~/.webpieces/config.json`. */
function fakeHome(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-dockeys-'));
    dirs.push(dir);
    return dir;
}

function writeConfig(home: string, contents: string): string {
    const p = path.join(home, '.webpieces', 'config.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, contents);
    return p;
}

/** Everything the loader wrote to stderr while `body` ran. */
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
 * ══ DOCUMENTATION KEYS — the note a human leaves for the next reader ════════════════════════════════
 *
 * JSON has no comments, so leaving a note in this hand-authored file used to cost a warning on EVERY
 * `wp-*` run. One machine's note said, in full caps, that the warning was expected and must not be
 * "fixed" — and an agent still offered to delete the key to silence it. A warning that has to be
 * explained away every time trains readers to ignore warnings, so the convention is understood now.
 */
describe('_doc / _aiDoc are understood documentation keys, not unknown ones', () => {
    it.each(DOCUMENTATION_KEYS)('%s at the top level is accepted with NO warning', (key: string): void => {
        const home = fakeHome();
        writeConfig(home, JSON.stringify({ [key]: 'a note for the next reader' }));

        let loaded: HomeConfig | null = null;
        const warnings = captureWarnings((): void => { loaded = new HomeConfigService().load(home); });

        expect(warnings).toBe('');
        expect(loaded).not.toBeNull();
    });

    it.each(DOCUMENTATION_KEYS)('%s inside experimental is accepted with NO warning', (key: string): void => {
        const home = fakeHome();
        writeConfig(home, JSON.stringify({
            [HOME_EXPERIMENTAL_SECTION]: { [key]: 'why this machine opted in', [HOME_KEY_ORPHAN_DIR_SWEEP]: true },
        }));

        let loaded: HomeConfig | null = null;
        const warnings = captureWarnings((): void => { loaded = new HomeConfigService().load(home); });

        expect(warnings).toBe('');
        expect(loaded?.orphanDirSweep).toBe(true);
    });

    it('a documentation key changes nothing — it is IGNORED, not a setting', (): void => {
        const home = fakeHome();
        writeConfig(home, JSON.stringify({ [HOME_KEY_DOC]: 'x', [HOME_KEY_AI_DOC]: 'y' }));

        const loaded = new HomeConfigService().load(home);

        expect(loaded.wholeRepoBuildGuard).toBe(false);
        expect(loaded.orphanDirSweep).toBe(false);
        expect(loaded.maxConcurrentBuilds).toBe(DEFAULT_MAX_CONCURRENT_BUILDS);
    });

    /**
     * `_doc: true` is not a note — it is somebody reaching for a setting and landing on the one key
     * name the loader promises to ignore. Warning would read as "accepted", because every other
     * accepted key here does something.
     */
    it.each(DOCUMENTATION_KEYS)('%s holding a non-string is REJECTED, not warned', (key: string): void => {
        const home = fakeHome();
        writeConfig(home, JSON.stringify({ [key]: true }));

        const err = loadError(home);

        expect(err.message).toContain(key);
        expect(err.message).toContain('must be a string');
    });

    /**
     * Accepted, but deliberately absent from the SETTINGS lists — those are walked elsewhere to build
     * typed sample documents, and a documentation key has no typed value to contribute.
     */
    it('documentation keys are NOT in the settings lists, and are never advertised', (): void => {
        const home = fakeHome();
        writeConfig(home, JSON.stringify({ nonsense: 1 }));

        const warnings = captureWarnings((): void => { new HomeConfigService().load(home); });

        for (const key of DOCUMENTATION_KEYS) {
            expect(ALLOWED_TOP_LEVEL).not.toContain(key);
            expect(ALLOWED_EXPERIMENTAL).not.toContain(key);
            expect(warnings).not.toContain(key);
        }
    });
});

/**
 * ══ AN ENDED EXPERIMENT SAYS SO ═════════════════════════════════════════════════════════════════════
 *
 * A flag a human retired is not hard-failed here — that would break the shell of somebody who opted in
 * early — so it falls through to the unknown-key warning. Without this, that warning said only "not a
 * key this @webpieces release understands", which reads like a typo or a version skew. The owner of the
 * config that prompted this asked "how did that happen?" and nothing on screen answered him.
 */
describe('an ENDED experiment is named in the warning, not left as a generic unknown key', () => {
    it('names the release it ended in and what replaced it', (): void => {
        const home = fakeHome();
        writeConfig(home, JSON.stringify({
            [HOME_EXPERIMENTAL_SECTION]: { buildGateLogCapture: true },
        }));

        const warnings = captureWarnings((): void => { new HomeConfigService().load(home); });

        expect(warnings).toContain('buildGateLogCapture');
        expect(warnings).toContain('ENDED in @webpieces 0.4.693');
        expect(warnings).toContain('UNCONDITIONAL');
        expect(warnings).toContain('Delete the key');
    });

    /** It must not ALSO tell them to check their spelling or upgrade — they did neither thing wrong. */
    it('replaces the misleading typo/upgrade advice rather than adding to it', (): void => {
        const home = fakeHome();
        writeConfig(home, JSON.stringify({
            [HOME_EXPERIMENTAL_SECTION]: { buildGateLogCapture: true },
        }));

        const warnings = captureWarnings((): void => { new HomeConfigService().load(home); });

        expect(warnings).not.toContain('If it is a typo, fix the spelling');
    });

    it('every ENDED_EXPERIMENTS entry is genuinely unknown to the loader', (): void => {
        for (const ended of ENDED_EXPERIMENTS) {
            const bare = ended.key.replace(`${HOME_EXPERIMENTAL_SECTION}.`, '');
            expect(ALLOWED_EXPERIMENTAL).not.toContain(bare);
            expect(ended.note).not.toBe('');
            expect(ended.endedIn).not.toBe('');
        }
    });
});
