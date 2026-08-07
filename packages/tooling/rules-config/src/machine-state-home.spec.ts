import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { MachineStateHome, WEBPIECES_STATE_HOME_ENV } from './machine-state-home';

/**
 * Real environment variables, real directories, real permission failures. Nothing here is mocked,
 * because every claim in `decisions/0001` § D3 is a claim about what the FILESYSTEM does — "a full
 * override, not a prefix" and "never throws on an unwritable HOME" are only true if the bytes land
 * where this says they do.
 */

let tmp = '';
let clone = '';
const savedHome = process.env['HOME'];
const savedOverride = process.env[WEBPIECES_STATE_HOME_ENV];

beforeEach((): void => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-state-home-'));
    clone = path.join(tmp, 'clone');
    fs.mkdirSync(clone, { recursive: true });
    delete process.env[WEBPIECES_STATE_HOME_ENV];
});

afterEach((): void => {
    if (savedHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = savedHome;
    if (savedOverride === undefined) delete process.env[WEBPIECES_STATE_HOME_ENV];
    else process.env[WEBPIECES_STATE_HOME_ENV] = savedOverride;
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('MachineStateHome — the state root above the clone', () => {
    it('defaults to $HOME/.webpieces and creates it', (): void => {
        const home = path.join(tmp, 'home');
        fs.mkdirSync(home);
        process.env['HOME'] = home;

        const resolved = new MachineStateHome().resolve(clone);

        expect(resolved.root).toBe(path.join(home, '.webpieces'));
        expect(resolved.degraded).toBe(false);
        expect(fs.existsSync(resolved.root)).toBe(true);
    });

    // D3: the override IS the root. A prefix would nest a `<key>` under it and defeat the one use case
    // it exists for — "put the state exactly here".
    it('treats WEBPIECES_STATE_HOME as a FULL override with no nesting', (): void => {
        const override = path.join(tmp, 'explicit');
        process.env['HOME'] = path.join(tmp, 'home-that-is-ignored');
        process.env[WEBPIECES_STATE_HOME_ENV] = override;

        const resolved = new MachineStateHome().resolve(clone);

        expect(resolved.root).toBe(override);
        expect(resolved.degraded).toBe(false);
        // Not `<override>/.webpieces`, and nothing keyed by the clone underneath it.
        expect(fs.readdirSync(override)).toHaveLength(0);
    });

    it('creates the override directory when it does not exist yet', (): void => {
        process.env[WEBPIECES_STATE_HOME_ENV] = path.join(tmp, 'deep', 'not', 'there');

        const resolved = new MachineStateHome().resolve(clone);

        expect(resolved.degraded).toBe(false);
        expect(fs.existsSync(resolved.root)).toBe(true);
    });

    // The whole point of D3's "never throw": this runs under code on a hook's blocking path.
    it('degrades to <clone>/.webpieces — without throwing — when HOME cannot be written', (): void => {
        // A regular FILE as the parent, so mkdir fails with ENOTDIR even for root. A chmod-based
        // unwritable directory is a no-op when the suite happens to run as root, which CI sometimes does.
        const blocker = path.join(tmp, 'not-a-dir');
        fs.writeFileSync(blocker, '');
        process.env['HOME'] = path.join(blocker, 'home');

        const resolved = new MachineStateHome().resolve(clone);

        expect(resolved.degraded).toBe(true);
        expect(resolved.root).toBe(path.join(clone, '.webpieces'));
        expect(resolved.reason).toContain('could not be created');
    });

    it('degrades when HOME is unset entirely, and says so', (): void => {
        delete process.env['HOME'];
        // os.homedir() is only consulted when $HOME is empty, and on a machine with a password-database
        // home it will answer — so this asserts the DEGRADED SHAPE holds whichever branch is taken.
        const resolved = new MachineStateHome().resolve(clone);

        if (resolved.degraded) {
            expect(resolved.root).toBe(path.join(clone, '.webpieces'));
            expect(resolved.reason).not.toBe('');
        } else {
            expect(resolved.root.endsWith('.webpieces')).toBe(true);
        }
    });

    it('degrades when the override is not a usable directory, naming the override', (): void => {
        const blocker = path.join(tmp, 'file-override');
        fs.writeFileSync(blocker, '');
        process.env[WEBPIECES_STATE_HOME_ENV] = path.join(blocker, 'inside');

        const resolved = new MachineStateHome().resolve(clone);

        expect(resolved.degraded).toBe(true);
        expect(resolved.root).toBe(path.join(clone, '.webpieces'));
        expect(resolved.reason).toContain(WEBPIECES_STATE_HOME_ENV);
    });

    it('$HOME wins over os.homedir(), so the state root is testable at all', (): void => {
        const home = path.join(tmp, 'explicit-home');
        fs.mkdirSync(home);
        process.env['HOME'] = home;

        // Not the real user's home — which is what makes a temp-HOME test of anything downstream possible.
        expect(new MachineStateHome().resolve(clone).root).toBe(path.join(home, '.webpieces'));
        expect(new MachineStateHome().resolve(clone).root).not.toBe(path.join(savedHome ?? '/nonexistent', '.webpieces'));
    });
});
