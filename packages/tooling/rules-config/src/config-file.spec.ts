import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ConfigFile, CONFIG_PARSE_ATTEMPTS } from './config-file';
import { InformAiError } from './inform-ai-error';

/**
 * A ConfigFile whose reads are scripted, so "another process was mid-write" is DETERMINISTIC instead
 * of a race we would have to hope for. Each entry is what that attempt sees on disk; the last entry
 * repeats once the script runs out. The sleep is stubbed to nothing so the retry costs no test time.
 */
class ScriptedConfigFile extends ConfigFile {
    attempts = 0;

    constructor(private readonly contents: readonly string[]) {
        super();
    }

    protected override readFileText(): string {
        const index = Math.min(this.attempts, this.contents.length - 1);
        this.attempts++;
        return this.contents[index];
    }

    protected override sleepSync(): void {
        // no-op: the retry delay is real behavior, but waiting for it in a unit test is not.
    }
}

// A read that fails outright on the first attempt (the ENOENT window between unlink and rename).
class FlakyReadConfigFile extends ConfigFile {
    attempts = 0;

    protected override readFileText(): string {
        this.attempts++;
        if (this.attempts === 1) throw new Error('ENOENT: no such file or directory');
        return VALID;
    }

    protected override sleepSync(): void {
        // no-op in tests
    }
}

const HALF_WRITTEN = '{ "rules": { "max-file-l';
const VALID = '{ "rules": { "max-file-lines": { "mode": "ON" } } }';
const CONFLICT_MARKED = '<<<<<<< HEAD\n{ "rules": {} }\n=======\n{ "rules": {} }\n>>>>>>> main\n';

describe('ConfigFile.readRawConfig — transient vs genuine parse failure', () => {
    it('a parse failure that succeeds on the SECOND attempt returns the config (no error at all)', () => {
        const configFile = new ScriptedConfigFile([HALF_WRITTEN, VALID]);
        const parsed = configFile.readRawConfig('/repo/webpieces.config.json');
        expect(parsed.rules?.['max-file-lines']).toEqual({ mode: 'ON' });
        expect(configFile.attempts).toBe(2);
    });

    it('a parse failure that persists across ALL attempts still throws (no fail-open)', () => {
        const configFile = new ScriptedConfigFile([HALF_WRITTEN]);
        expect(() => configFile.readRawConfig('/repo/webpieces.config.json')).toThrow(InformAiError);
        expect(configFile.attempts).toBe(CONFIG_PARSE_ATTEMPTS);
    });

    it('a valid config parses on the first attempt — no retry, no delay on the happy path', () => {
        const configFile = new ScriptedConfigFile([VALID]);
        configFile.readRawConfig('/repo/webpieces.config.json');
        expect(configFile.attempts).toBe(1);
    });

    it('a transient READ failure (ENOENT mid-rename) is retried like a parse failure', () => {
        const configFile = new FlakyReadConfigFile();
        expect(configFile.readRawConfig('/repo/webpieces.config.json').rules).toBeDefined();
        expect(configFile.attempts).toBe(2);
    });

    it('the surviving failure names the retry count and points at the always-allowed inspection path', () => {
        const configFile = new ScriptedConfigFile([CONFLICT_MARKED]);
        const read = (): unknown => configFile.readRawConfig('/repo/webpieces.config.json');
        expect(read).toThrow(`retried ${CONFIG_PARSE_ATTEMPTS} times`);
        expect(read).toThrow('STILL BEING WRITTEN by another process');
        expect(read).toThrow('READING AND EDITING webpieces.config.json IS ALWAYS ALLOWED');
        expect(read).toThrow('/repo/webpieces.config.json');
    });
});

describe('ConfigFile.readRawConfig — against a real file on disk', () => {
    let dir: string;

    beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-cfgparse-')); });
    afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it('reads and parses a real valid config', () => {
        const file = path.join(dir, 'webpieces.config.json');
        fs.writeFileSync(file, VALID);
        expect(new ConfigFile().readRawConfig(file).rules).toBeDefined();
    });

    it('a real conflict-marked config throws after the retries (the genuine case still blocks)', () => {
        const file = path.join(dir, 'webpieces.config.json');
        fs.writeFileSync(file, CONFLICT_MARKED);
        expect(() => new ConfigFile().readRawConfig(file)).toThrow(InformAiError);
    });
});
