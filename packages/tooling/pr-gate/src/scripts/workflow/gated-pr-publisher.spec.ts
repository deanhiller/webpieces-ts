import { describe, it, expect } from 'vitest';
import { GateTokenService, CliExitError } from '@webpieces/rules-config';
import { GatedPrPublisher, PublishedPr } from './gated-pr-publisher';
import { GitExec } from './git-exec';

const SALT = 's3cr3t';
const PARENT_SHA = 'a'.repeat(40);
const NEW_HEAD_SHA = 'b'.repeat(40);

// A GatedPrPublisher whose gh + push seams are canned, so the ORDERING is exercised with no gh, no
// network and no repo. `calls` records the seam name in the order it was actually invoked — that
// sequence IS the invariant under test.
class FakePublisher extends GatedPrPublisher {
    calls: string[] = [];
    editedBody: string = '';
    editedTitle: string = '';

    constructor(
        private readonly existingPr: string,
        private readonly editOk: boolean = true,
        private readonly pushOk: boolean = true,
        private readonly createOk: boolean = true,
    ) {
        // GitExec is never reached — `push` is overridden below.
        super(null as unknown as GitExec);
    }

    protected override findOpenPr(): string {
        this.calls.push('findOpenPr');
        return this.existingPr;
    }

    protected override editPr(prNumber: string, title: string, bodyFile: string): boolean {
        this.calls.push('editPr');
        this.editedTitle = title;
        this.editedBody = bodyFile;
        return this.editOk;
    }

    protected override push(): void {
        this.calls.push('push');
        if (!this.pushOk) throw new CliExitError(1, '❌ Failed to push branch (git push exited 1)');
    }

    protected override createPr(): boolean {
        this.calls.push('createPr');
        return this.createOk;
    }
}

// The body wp-finish-upsert-pr hands the publisher: the dashboard plus the token for the LOCAL head sha.
const gatedBody = (headSha: string): string =>
    `# dashboard\n\n${new GateTokenService().gateTokenMarker(SALT, headSha)}\n`;

const publish = (fake: FakePublisher, headSha: string = NEW_HEAD_SHA): PublishedPr =>
    fake.publish('dean/feature', 'My PR title', gatedBody(headSha));

describe('existing PR — the body is written BEFORE the push', () => {
    it('edits the PR, THEN pushes (the ordering that removes the synchronize race)', () => {
        const fake = new FakePublisher('42');
        const result = publish(fake);

        expect(fake.calls).toEqual(['findOpenPr', 'editPr', 'push']);
        expect(fake.calls.indexOf('editPr')).toBeLessThan(fake.calls.indexOf('push'));
        expect(result.number).toBe('42');
        expect(result.createFailed).toBe(false);
    });

    it('never creates a second PR when one already exists', () => {
        const fake = new FakePublisher('42');
        publish(fake);
        expect(fake.calls).not.toContain('createPr');
    });

    it('the body already on the PR when the push fires carries HMAC(salt, NEW head) — a synchronize read landing immediately after the push verifies', () => {
        const fake = new FakePublisher('42');
        publish(fake, NEW_HEAD_SHA);

        // What CI would read at the instant `synchronize` arrives is exactly what editPr received.
        const tokens = new GateTokenService();
        expect(tokens.verifyGateToken(fake.editedBody, SALT, NEW_HEAD_SHA)).toBe(true);
        // ...and it is NOT the previous run's token, which is what the old push-first order exposed.
        expect(tokens.verifyGateToken(fake.editedBody, SALT, PARENT_SHA)).toBe(false);
    });

    it('passes the title through to gh pr edit', () => {
        const fake = new FakePublisher('42');
        publish(fake);
        expect(fake.editedTitle).toBe('My PR title');
    });
});

describe('gh pr edit fails', () => {
    it('aborts BEFORE pushing, so the remote is left wholly untouched', () => {
        const fake = new FakePublisher('42', false);
        expect((): PublishedPr => publish(fake)).toThrowError(/gh pr edit failed on PR #42/);
        expect(fake.calls).toEqual(['findOpenPr', 'editPr']);
        expect(fake.calls).not.toContain('push');
    });
});

describe('push fails after the body edit landed', () => {
    it('throws rather than reporting a published PR — the gate check goes red, never falsely green', () => {
        const fake = new FakePublisher('42', true, false);
        expect((): PublishedPr => publish(fake)).toThrowError(/Failed to push branch/);
        expect(fake.calls).toEqual(['findOpenPr', 'editPr', 'push']);
        // Nothing after the push ran, so no merge/auto-merge can be kicked off on the stale remote head.
        expect(fake.calls).not.toContain('createPr');
    });
});

describe('no existing PR — create path', () => {
    it('pushes FIRST, then creates (gh pr create needs the remote ref, and `opened` sees the final body)', () => {
        const fake = new FakePublisher('');
        const result = publish(fake);

        expect(fake.calls).toEqual(['findOpenPr', 'push', 'createPr']);
        expect(fake.calls).not.toContain('editPr');
        expect(result.number).toBe('');
        expect(result.createFailed).toBe(false);
    });

    it('reports createFailed so the caller does not claim a PR that was never opened', () => {
        const fake = new FakePublisher('', true, true, false);
        expect(publish(fake).createFailed).toBe(true);
    });

    it('a push failure with no PR yet just propagates — nothing was edited, so no extra explanation', () => {
        const fake = new FakePublisher('', true, false);
        expect((): PublishedPr => publish(fake)).toThrowError(/Failed to push branch/);
        expect(fake.calls).toEqual(['findOpenPr', 'push']);
    });
});
