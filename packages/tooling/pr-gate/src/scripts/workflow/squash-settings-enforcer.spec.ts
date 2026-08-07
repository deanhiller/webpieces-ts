import { describe, expect, it } from 'vitest';
import {
    SquashSettings, SquashSettingsEnforcer, SQUASH_MESSAGE_REQUIRED, SQUASH_TITLE_REQUIRED,
} from './squash-settings-enforcer';

// An enforcer whose two gh seams are driven from the test, so nothing here touches gh or the network.
class FakeEnforcer extends SquashSettingsEnforcer {
    current = new SquashSettings();
    patched = 0;
    patchOk = true;

    protected override read(): SquashSettings {
        return this.current;
    }

    protected override patch(): boolean {
        this.patched += 1;
        return this.patchOk;
    }
}

function settings(title: string, message: string, admin: boolean): SquashSettings {
    const s = new SquashSettings();
    s.title = title;
    s.message = message;
    s.admin = admin;
    return s;
}

// Capture stdout+stderr for one call, so the tests can assert on what a human is actually told.
function output(run: () => void): string {
    const chunks: string[] = [];
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    // webpieces-disable no-any-unknown -- stubbing the two stream writers for the duration of one call
    const capture = (s: string | Uint8Array): boolean => {
        chunks.push(String(s));
        return true;
    };
    process.stdout.write = capture as typeof process.stdout.write;
    process.stderr.write = capture as typeof process.stderr.write;
    // webpieces-disable no-unmanaged-exceptions -- chokepoint: the streams MUST be restored either way
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        run();
    } finally {
        process.stdout.write = out;
        process.stderr.write = err;
    }
    return chunks.join('');
}

describe('SquashSettingsEnforcer — the correct pair costs nothing', () => {
    it('does nothing at all when the settings are already PR_TITLE + PR_BODY', () => {
        const e = new FakeEnforcer();
        e.current = settings(SQUASH_TITLE_REQUIRED, SQUASH_MESSAGE_REQUIRED, true);
        const said = output((): void => {
            e.ensure();
        });

        expect(e.patched).toBe(0);
        expect(said).toBe('');
    });
});

describe('SquashSettingsEnforcer — repair', () => {
    /**
     * COMMIT_MESSAGES is the live case this was written for: the framework's own repo sat on it while both
     * consumer repos were already correct, so a UI merge there would have landed the branch's raw internal
     * commit messages instead of the gated body.
     */
    it('repairs COMMIT_MESSAGES and says what it changed', () => {
        const e = new FakeEnforcer();
        e.current = settings(SQUASH_TITLE_REQUIRED, 'COMMIT_MESSAGES', true);
        const said = output((): void => {
            e.ensure();
        });

        expect(e.patched).toBe(1);
        // Never silent: a tool that changes a shared repo's settings has to say so, and say what it was.
        expect(said).toContain('COMMIT_MESSAGES');
        expect(said).toContain('PR_TITLE');
        expect(said).toContain('PR_BODY');
    });

    it('repairs a wrong TITLE too, not just the message', () => {
        const e = new FakeEnforcer();
        e.current = settings('MERGE_MESSAGE', SQUASH_MESSAGE_REQUIRED, true);
        e.ensure();
        expect(e.patched).toBe(1);
    });

    it('reports the consequence when the PATCH itself fails, and never throws', () => {
        const e = new FakeEnforcer();
        e.current = settings(SQUASH_TITLE_REQUIRED, 'BLANK', true);
        e.patchOk = false;
        const said = output((): void => {
            expect((): void => {
                e.ensure();
            }).not.toThrow();
        });
        expect(said).toContain('gh api -X PATCH');
    });
});

describe('SquashSettingsEnforcer — no admin, and unreadable', () => {
    /**
     * A contributor without admin must not be blocked by a setting only an owner can change, so this
     * degrades to a warning — but one that names the consequence and hands over a runnable command, since
     * the reader's job is to forward it, not to go research what these settings do.
     */
    it('warns with a runnable command instead of attempting a PATCH it cannot make', () => {
        const e = new FakeEnforcer();
        e.current = settings(SQUASH_TITLE_REQUIRED, 'COMMIT_MESSAGES', false);
        const said = output((): void => {
            e.ensure();
        });

        expect(e.patched).toBe(0);
        expect(said).toContain('not an admin');
        expect(said).toContain('gh api -X PATCH');
        // wp-land-pr passes --body-file explicitly, so it is right regardless — worth saying, because it
        // means the reader is not actually stuck while they wait on an owner.
        expect(said).toContain('wp-land-pr');
    });

    /**
     * An unreadable answer is NOT a diagnosis. A gh hiccup returning '' must never be read as "wrong" —
     * that would PATCH a repo whose settings were fine, on no evidence.
     */
    it('treats an unreadable answer as unknown, never as wrong', () => {
        const e = new FakeEnforcer(); // default SquashSettings — all '' / false
        const said = output((): void => {
            e.ensure();
        });

        expect(e.patched).toBe(0);
        expect(said).toContain('Could not read');
    });
});
