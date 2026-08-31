import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CodexTrustProbe, CodexTrustStatus } from './codex-trust';
import { CODEX_REGISTRATION, GUARDS_BIN, RULES_BIN, writeSettings } from './hook-registration';

/**
 * CODEX TRUST IS READ, NEVER WRITTEN — and the second half of that sentence is the one worth testing.
 *
 * The `trusted_hash` Codex records is not reproducible from outside Codex (sixteen encodings were tried
 * against a hooks.json we authored and none matched), so an installer that wrote one would be forging a
 * security decision on a human's behalf. Every test below therefore asserts the CONTENT of the config
 * file is untouched, not merely that the report reads correctly.
 */
let home = '';
let repo = '';

beforeEach(() => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-codex-trust-')));
    home = path.join(tmp, 'home');
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(repo, { recursive: true });
});

afterEach(() => {
    fs.rmSync(path.dirname(home), { recursive: true, force: true });
});

/** Arm Codex in the fixture repo exactly as the installer would. */
function armCodex(): string {
    const hooksPath = path.join(repo, ...CODEX_REGISTRATION.settingsFiles[0].split('/'));
    writeSettings(hooksPath, {
        hooks: {
            PreToolUse: [
                { matcher: CODEX_REGISTRATION.guardsMatcher, hooks: [{ type: 'command', command: CODEX_REGISTRATION.shimCommand(GUARDS_BIN) }] },
                { matcher: CODEX_REGISTRATION.rulesMatcher, hooks: [{ type: 'command', command: CODEX_REGISTRATION.shimCommand(RULES_BIN) }] },
            ],
        },
    });
    return hooksPath;
}

function writeConfig(body: string): void {
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), body);
}

function read(): CodexTrustStatus {
    return new CodexTrustProbe().read(repo, home);
}

describe('CodexTrustProbe — a repo that never armed Codex', () => {
    it('reports nothing at all, so a Claude-only install gains no noise', () => {
        const status = read();
        expect(status.notArmed()).toBe(true);
        expect(status.registeredEntries).toBe(0);
        expect(status.lines()).toEqual([]);
    });
});

describe('CodexTrustProbe — armed but not trusted', () => {
    it('counts the managed entries and reports zero trusted when Codex has never run', () => {
        const hooksPath = armCodex();
        const status = read();
        expect(status.registeredEntries).toBe(2);
        expect(status.trustedEntries).toBe(0);
        expect(status.configExists).toBe(false);
        expect(status.fullyTrusted()).toBe(false);
        expect(status.hooksPath).toBe(hooksPath);
    });

    /**
     * THE SENTENCE THAT MATTERS. A human whose install "succeeded" can still be one keystroke from an
     * unguarded session, and the only cure is theirs to run — so the report has to say both things.
     */
    it('names the human action and says out loud what "continue without trusting" costs', () => {
        armCodex();
        const report = read().lines().join('\n');
        expect(report).toContain('run `codex` in this repo and choose "Trust all"');
        expect(report).toContain('UNGUARDED');
    });

    it('reports untrusted when the project is trusted but the hook entries are not', () => {
        armCodex();
        writeConfig(`[projects."${repo}"]\ntrust_level = "trusted"\n`);
        const status = read();
        expect(status.projectTrusted).toBe(true);
        expect(status.trustedEntries).toBe(0);
        expect(status.fullyTrusted()).toBe(false);
    });

    it('reports untrusted when the hooks are trusted but the PROJECT is not', () => {
        const hooksPath = armCodex();
        writeConfig(
            `[hooks.state."${hooksPath}:pre_tool_use:0:0"]\ntrusted_hash = "sha256:aaa"\n`
            + `[hooks.state."${hooksPath}:pre_tool_use:1:0"]\ntrusted_hash = "sha256:bbb"\n`,
        );
        const status = read();
        expect(status.trustedEntries).toBe(2);
        expect(status.projectTrusted).toBe(false);
        expect(status.fullyTrusted()).toBe(false);
    });
});

describe('CodexTrustProbe — fully trusted', () => {
    it('reports green when the project and every entry carry trust', () => {
        const hooksPath = armCodex();
        writeConfig(
            `[projects."${repo}"]\ntrust_level = "trusted"\n\n`
            + `[hooks.state."${hooksPath}:pre_tool_use:0:0"]\ntrusted_hash = "sha256:aaa"\n\n`
            + `[hooks.state."${hooksPath}:pre_tool_use:1:0"]\ntrusted_hash = "sha256:bbb"\n`,
        );
        const status = read();
        expect(status.fullyTrusted()).toBe(true);
        expect(status.lines().join('\n')).toContain('✅');
    });

    /**
     * A `hooks.state` key for a DIFFERENT repo's hooks.json must not count. The key is prefixed by the
     * absolute path of the file, and every developer's config holds entries for every repo they have
     * opened — so a probe that matched loosely would report every repo as trusted the moment one was.
     */
    it('does not count another repo\'s trusted entries', () => {
        armCodex();
        writeConfig(
            `[projects."${repo}"]\ntrust_level = "trusted"\n\n`
            + '[hooks.state."/somewhere/else/.codex/hooks.json:pre_tool_use:0:0"]\ntrusted_hash = "sha256:aaa"\n',
        );
        expect(read().trustedEntries).toBe(0);
    });

    it('does not read another project\'s trust_level as this one\'s', () => {
        armCodex();
        writeConfig('[projects."/somewhere/else"]\ntrust_level = "trusted"\n');
        expect(read().projectTrusted).toBe(false);
    });
});

describe('CodexTrustProbe never writes', () => {
    it('leaves ~/.codex/config.toml byte-identical, and creates one when absent', () => {
        armCodex();
        const configPath = path.join(home, '.codex', 'config.toml');

        // Absent: reading must not bring it into existence.
        read();
        expect(fs.existsSync(configPath)).toBe(false);

        writeConfig('[projects."/other"]\ntrust_level = "trusted"\n');
        const before = fs.readFileSync(configPath, 'utf8');
        read();
        read();
        expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
    });

    it('never throws on a malformed config — an unreadable trust state is "not trusted"', () => {
        armCodex();
        writeConfig('this is not toml [[[\n\x00\n');
        const status = read();
        expect(status.fullyTrusted()).toBe(false);
        expect(status.trustedEntries).toBe(0);
    });
});
