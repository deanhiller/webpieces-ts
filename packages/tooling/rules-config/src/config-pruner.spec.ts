import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { AtomicFile } from './atomic-file';
import { ConfigFile } from './config-file';
import { ConfigPruner, PrunedKey, PruneResult } from './config-pruner';
import { PRUNE_UNKNOWN_COMMAND } from './constants';
import { CONFIG_POLICY_DOC, formatConfigErrorsBanner } from './config-error-banner';
import { HomeConfigService } from './home-config';
import { loadTemplate } from './load-template';
import { RETIRED_CONFIG_KEYS, RETIRED_SCOPE_RULE, retiredKeyError } from './retired-config-keys';
import { toError } from './to-error';
import { validateWebpiecesConfig } from './validate-config';

/**
 * THE INCIDENT THIS FILE PINS DOWN.
 *
 * `whole-repo-build-guard` shipped as an ordinary validated guard and was retired to machine-local one
 * release later. Inside that window both validator branches were wrong, in opposite directions: with the
 * key ABSENT the validator demanded it be added (and printed the block to paste); with the key PRESENT
 * the guard denied every Bash call as an unknown rule. Adding it and not adding it were both errors.
 *
 * What turned a confusing hour into most of a day was the ADVICE. The banner said "Do NOT delete a key
 * just because it is reported unknown", which is the one action that works; the unknown-rule branch said
 * "run `pnpm install` first" while the banner four lines below said "Do NOT run `pnpm install` — it
 * cannot help"; and nothing anywhere named `~/.webpieces/config.json`, which is where the setting had
 * actually gone.
 *
 * Each `describe` below is one of the report's test cases.
 */

const dirs: string[] = [];

afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A throwaway repo dir holding one webpieces.config.json. Returns the dir. */
function repoWith(config: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-prune-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'webpieces.config.json'), config);
    return dir;
}

function pruner(): ConfigPruner {
    return new ConfigPruner(new ConfigFile(), new AtomicFile());
}

/** The one error `validateWebpiecesConfig` produced for `name` (missing-OTHER-rule errors ignored). */
function errorFor(name: string, rawRules: Record<string, Record<string, unknown>>): string {
    const matching = validateWebpiecesConfig(rawRules).filter((e: string): boolean => e.includes(`[${name}]`));
    expect(matching, `exactly one error for ${name}`).toHaveLength(1);
    return matching[0];
}

/**
 * CASE 1 — a genuinely retired key, on a validator that KNOWS the retirement.
 *
 * The message must name the new `~/.webpieces/config.json` location AND deletion as the cure, and
 * `wp-prune-unknown-config` must actually remove it, after which the config validates.
 */
describe('case 1 — retired key, validator knows the retirement', () => {
    const error = errorFor('whole-repo-build-guard', { 'whole-repo-build-guard': { mode: 'ON' } });

    it('names where the setting WENT, by full path, not just that the key is dead', () => {
        expect(error).toContain('~/.webpieces/config.json');
        expect(error).toContain('experimental.whole-repo-build-guard');
    });

    // The destination alone is not enough: the reader also has to be told the value does not move to
    // another key in THIS file, i.e. that removing the entry is the complete edit.
    it('names DELETION as the cure, and the command that does it', () => {
        expect(error).toContain('DELETE this entry from webpieces.config.json');
        expect(error).toContain('Deleting it is the WHOLE fix');
        expect(error).toContain(PRUNE_UNKNOWN_COMMAND);
    });

    it('says the machine-local file is optional and tracked by no repo', () => {
        expect(error).toContain('that file is optional, is tracked by no repo');
    });

    it('prunes the key, and the config then validates', () => {
        const dir = repoWith(JSON.stringify({
            rules: {},
            hookGuards: { 'whole-repo-build-guard': { mode: 'ON' } },
        }, null, 4));
        const result: PruneResult = pruner().pruneFrom(dir);

        expect(result.changed()).toBe(true);
        expect(result.removed.map((r: PrunedKey): string => r.key)).toEqual(['whole-repo-build-guard']);

        // The file on disk no longer carries it, and re-validating the pruned sections is silent about it.
        const after = JSON.parse(fs.readFileSync(path.join(dir, 'webpieces.config.json'), 'utf8')) as
            Record<string, Record<string, Record<string, unknown>>>;
        expect(Object.keys(after['hookGuards'])).toEqual([]);
        const stillReported = validateWebpiecesConfig(after['hookGuards'])
            .filter((e: string): boolean => e.includes('whole-repo-build-guard'));
        expect(stillReported).toEqual([]);
    });

    // Every removal is named. A silent sweep is what would make the one destructive case unrecoverable.
    it('reports each removed key by name rather than a count', () => {
        const dir = repoWith(JSON.stringify({ hookGuards: { 'whole-repo-build-guard': { mode: 'ON' } } }, null, 4));
        const report = pruner().pruneFrom(dir).describeSelf();
        expect(report).toContain('hookGuards.whole-repo-build-guard');
        expect(report).toContain('~/.webpieces/config.json');
    });
});

/**
 * CASE 2 — the SAME key on a STALE validator, which is the generic fallback.
 *
 * This is not an exotic configuration: it is the ordinary linked-worktree layout, where the worktree is
 * on one release and the parent checkout that supplies the hook's resolution is on an older one (measured
 * mid-incident: worktree 0.4.616, parent 0.4.579). A validator that predates the retirement has no table
 * entry, so it can only emit `unknownRuleError` — which therefore has to be useful on its own.
 *
 * A validator old enough to lack the entry cannot be imported here, so the fallback is driven directly:
 * that IS the code path such a tree runs.
 */
describe('case 2 — retired key, validator too old to know it (generic fallback)', () => {
    const error = errorFor('brand-new-rule', { 'brand-new-rule': { mode: 'ON' } });

    it('still raises the possibility that the key is RETIRED', () => {
        expect(error).toContain('RETIRED');
    });

    it('still says deletion may be the whole fix, and names the mechanical cure', () => {
        expect(error).toContain('DELETE the "brand-new-rule" key');
        expect(error).toContain(PRUNE_UNKNOWN_COMMAND);
        expect(error).toContain('deleting the key here is the WHOLE fix');
    });

    it('still points at ~/.webpieces/config.json for machine-local settings', () => {
        expect(error).toContain('~/.webpieces/config.json');
        expect(error).toContain('experimental');
    });

    /**
     * The heart of the report. The old text asserted `pnpm install` as the FIRST cure and deletion only
     * as a last resort — for a key that is correct-to-delete and has nothing to do with an install.
     */
    it('does NOT prescribe `pnpm install` at all', () => {
        expect(error).not.toContain('pnpm install');
    });

    it('leads with deletion rather than with the stale pin', () => {
        expect(error.indexOf('DELETE')).toBeLessThan(error.indexOf('Secondary'));
    });
});

/**
 * CASE 3 — `~/.webpieces/config.json` is itself the file that fails validation.
 *
 * VERIFIED ALREADY CORRECT, and kept as a regression pin rather than a fix. The report's complaint was
 * that the reader gets pointed at the repo config for a problem that does not live there; driving the
 * real loader shows every rejection already names the machine-local path twice — in the bracketed label
 * and as a resolved `File:` line — and never names webpieces.config.json at all. These assertions exist
 * so that stays true.
 */
describe('case 3 — the machine-local file is the one that is wrong', () => {
    function homeError(contents: string): string {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-home-'));
        dirs.push(home);
        const file = path.join(home, '.webpieces', 'config.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, contents);
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: the rejection IS the assertion subject
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            new HomeConfigService().load(home);
        } catch (err: unknown) {
            const error = toError(err);
            return error.message;
        }
        throw new Error(`expected ${contents} to be rejected`);
    }

    const cases: readonly string[] = [
        '{ not json',                                    // unparseable
        '{"experimental":{"bogusFlag":true}}',           // unknown flag
        '{"experimental":{"whole-repo-build-guard":"yes"}}', // wrong TYPE for a known flag
        '{"experimental":{"captureBuildGateLog":true}}', // retired flag
    ];

    it('names THAT file — in the label and as a resolved path — for every failure mode', () => {
        for (const contents of cases) {
            const message = homeError(contents);
            expect(message, contents).toContain('[~/.webpieces/config.json]');
            expect(message, contents).toMatch(/File: .*[/\\]\.webpieces[/\\]config\.json/);
        }
    });

    it('never sends the reader to the repo config, which cannot fix any of them', () => {
        for (const contents of cases) {
            expect(homeError(contents), contents).not.toContain('webpieces.config.json]');
        }
    });
});

/**
 * CASE 4 — an unknown key caused by a genuinely STALE PIN must not be silently dropped.
 *
 * Inverting the advice to "delete it" creates exactly one hazard: a key that is valid, and merely newer
 * than the running validator, would be deleted along with the dead ones. Several things contain it, and
 * each is asserted here.
 */
describe('case 4 — a valid-but-newer key is never dropped without warning', () => {
    it('the message still names the stale pin as a case, and points at the drift guard for it', () => {
        const error = errorFor('brand-new-rule', { 'brand-new-rule': { mode: 'ON' } });
        expect(error).toContain('package.json pins an @webpieces OLDER');
        expect(error).toContain('version-drift guard');
        // ...and says which cure belongs to that case, so it is not confused with deletion.
        expect(error).toContain('bump the pin');
    });

    /**
     * The structural containment: the drift guard runs in the SHIM, before the validator is exec'd, and
     * denies every tool call on drift. So a tree with a stale pin never reaches the pruner at all — which
     * is the argument that makes delete-first safe rather than merely convenient.
     */
    it('the shim decides drift before exec`ing the guard bin, so a stale tree never reaches the pruner', () => {
        const shim = fs.readFileSync(
            path.join(__dirname, '..', '..', 'ai-hook-rules', 'templates', 'ai-hook.sh'), 'utf8');
        expect(shim).toContain('DRIFT_PKG');
        // The guard bin only runs when there is no drift — the condition that makes `pnpm install` a no-op
        // by the time any validator message is on screen.
        expect(shim).toMatch(/-z "\$DRIFT_PKG"/);
    });

    // A rename is a retirement whose value must CARRY OVER. Pruning one would lose it, so it is kept.
    it('the pruner refuses to remove a rename, which still has a destination in this file', () => {
        const dir = repoWith(JSON.stringify({ hookGuards: { 'main-stale-guard': { mode: 'ON' } } }, null, 4));
        const result = pruner().pruneFrom(dir);
        expect(result.changed()).toBe(false);
        expect(result.describeSelf()).toContain('nothing to remove');
    });

    // A rulesDir means an unrecognised name may be a legitimate CUSTOM rule. Never touch those.
    it('the pruner removes nothing at all when a rulesDir is configured', () => {
        const dir = repoWith(JSON.stringify({
            rulesDir: ['./my-rules'],
            rules: { 'my-custom-rule': { mode: 'ON' } },
        }, null, 4));
        expect(pruner().pruneFrom(dir).changed()).toBe(false);
    });

    // The retired table is a worklist, and `prunable` is the field that decides delete-vs-rename. An entry
    // added without thinking about it would silently become non-prunable; this states the current split.
    it('exactly the retirements that left this file are prunable', () => {
        const prunable = RETIRED_CONFIG_KEYS
            .filter(e => e.scope === RETIRED_SCOPE_RULE && e.prunable)
            .map(e => e.key);
        expect(prunable).toEqual(['whole-repo-build-guard']);
    });

    // A real rule the validator DOES know is never touched, whatever else is in the file.
    it('leaves every key that has a schema exactly where it is', () => {
        const dir = repoWith(JSON.stringify({
            hookGuards: { 'pr-merge-guard': { mode: 'ON' }, 'dead-key': { mode: 'ON' } },
        }, null, 4));
        const result = pruner().pruneFrom(dir);
        expect(result.removed.map((r: PrunedKey): string => r.key)).toEqual(['dead-key']);
        const after = JSON.parse(fs.readFileSync(path.join(dir, 'webpieces.config.json'), 'utf8')) as
            Record<string, Record<string, unknown>>;
        expect(Object.keys(after['hookGuards'])).toEqual(['pr-merge-guard']);
    });
});

/**
 * SHIM SHAPE #6 — the doc the banner CITES may not teach the advice the banner deleted.
 *
 * The first cut of this change fixed the message and left `webpieces.config-policy.md` — the page the
 * banner's own last line links to, shipped from this very package — still saying "Do not start by
 * deleting keys" and prescribing `pnpm install` as step 1. A cured message pointing at an uncured page
 * is not a fix; it is the propagation route. `CONFIG_POLICY_DOC` names the file once so the link, the
 * installer that writes it, and this spec cannot drift apart.
 */
describe('the linked policy doc agrees with the banner', () => {
    const doc = loadTemplate(CONFIG_POLICY_DOC);

    it('is the document the banner actually links to', () => {
        expect(formatConfigErrorsBanner(['x'])).toContain(CONFIG_POLICY_DOC);
    });

    it('no longer carries the delete-last / install-first advice the banner removed', () => {
        expect(doc).not.toContain('Do not start by deleting keys');
        expect(doc).not.toContain('Only if an error survives a fresh install');
        // The banner asserts `pnpm install` cannot help; the doc may not present it as step 1.
        expect(doc).not.toMatch(/1\.\s+\*\*`pnpm install`\*\*/);
    });

    it('teaches deletion, the mechanical cure, and the machine-local file instead', () => {
        expect(doc).toContain('delete it');
        expect(doc).toContain(PRUNE_UNKNOWN_COMMAND);
        expect(doc).toContain('~/.webpieces/config.json');
        expect(doc).toContain('Do NOT run `pnpm install`');
    });

    /**
     * The SOURCE docstrings count too, and this is where the advice leaked back out twice. The prose in
     * retired-config-keys.ts is what an agent reads before adding a retirement, so an "install fixes the
     * common case" sentence there re-teaches exactly what the banner deleted — and it sits in the same
     * package as the banner that contradicts it.
     */
    it('no source doc in this package still offers `pnpm install` as the cure for a validation failure', () => {
        const sources = ['retired-config-keys.ts', 'config-error-banner.ts', 'validate-config.ts']
            .map((name: string): string => fs.readFileSync(path.join(__dirname, name), 'utf8'));
        for (const source of sources) {
            expect(source).not.toContain('which fixes the far more common cause');
            expect(source).not.toContain('run `pnpm install` first');
        }
    });
});

/**
 * CASE 5 — ONE validator run may never say both "run `pnpm install`" and "do NOT run `pnpm install`".
 *
 * These two lines used to appear in a single output about four lines apart, and cancelled out. The
 * survivor is the banner's negative: by the time any validator message is on screen the shim has already
 * confirmed package.json and node_modules agree (case 4 above), so there is nothing to install.
 */
describe('case 5 — the output never contradicts itself about `pnpm install`', () => {
    /** The complete thing a reader sees: the errors, rendered inside the banner. */
    function fullOutput(rawRules: Record<string, Record<string, unknown>>): string {
        return formatConfigErrorsBanner(validateWebpiecesConfig(rawRules));
    }

    const outputs: ReadonlyArray<readonly [string, string]> = [
        ['unknown rule', fullOutput({ 'brand-new-rule': { mode: 'ON' } })],
        ['retired rule', fullOutput({ 'whole-repo-build-guard': { mode: 'ON' } })],
        ['retired rename', fullOutput({ 'main-stale-guard': { mode: 'ON' } })],
        ['a single retired-key error', formatConfigErrorsBanner([retiredKeyError(RETIRED_CONFIG_KEYS[0])])],
    ];

    it('mentions `pnpm install` exactly once, and only to rule it out', () => {
        for (const [label, output] of outputs) {
            expect(output.split('pnpm install'), label).toHaveLength(2);
            expect(output, label).toContain('Do NOT run `pnpm install` — it cannot help');
        }
    });

    it('never carries the positive instruction that used to sit four lines above the negative', () => {
        for (const [label, output] of outputs) {
            expect(output, label).not.toContain('run `pnpm install` first');
            expect(output, label).not.toContain('after a fresh install');
        }
    });
});
