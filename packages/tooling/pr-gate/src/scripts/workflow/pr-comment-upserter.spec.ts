import { specTempDirs } from '@webpieces/tooling-testkit';
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CapturedOutput, PrGateFeature } from '../../__tests__/feature-harness';
import { PrCommentRequest, PrCommentUpserter } from './pr-comment-upserter';

// The production upserter from the shipped container, with `gh` SCRIPTED (#1381): no gh, no network, no PR.
const FIND = ['api', '--paginate'];
const WRITE = ['api', '--method'];

let dir = '';
let feature: PrGateFeature;
let output: CapturedOutput;

function request(): PrCommentRequest {
    const r = new PrCommentRequest();
    r.prNumber = '42';
    r.marker = '<!-- webpieces-pr-detail v1 -->';
    r.body = '<!-- webpieces-pr-detail v1 -->\n## Dashboard';
    r.payloadDir = dir;
    r.payloadName = 'detail-comment.json';
    r.label = 'full dashboard comment';
    return r;
}

function upserter(): PrCommentUpserter {
    return feature.container.get(PrCommentUpserter);
}

/** The one `gh api --method …` write the upsert issued, as a command line. */
function writeCall(): string {
    return feature.processes.callsStartingWith('gh', WRITE).map((c): string => c.commandLine).join('\n');
}

beforeEach(async (): Promise<void> => {
    dir = specTempDirs.make('wp-comment-upsert-');
    feature = await PrGateFeature.create();
    output = CapturedOutput.start();
});

afterEach((): void => {
    output.stop();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('PrCommentUpserter — idempotency is the whole contract', () => {
    /**
     * `wp-finish-upsert-pr` re-runs on EVERY push. A PR that grew a new dashboard comment per push would
     * be unreadable, and worse, `wp-check-pr` would have several bodies to pick a gate token from.
     */
    it('PATCHes the existing comment when one carries the marker', async () => {
        feature.processes.respondToPrefix('gh', FIND, feature.processes.ok('999\n'));
        feature.processes.respondToPrefix('gh', WRITE, feature.processes.ok());

        const result = await upserter().upsert(request());

        expect(result.ok).toBe(true);
        expect(result.updated).toBe(true);
        expect(writeCall()).toContain('PATCH');
        expect(writeCall()).toContain('issues/comments/999');
        // The comment is found by its hidden MARKER, never by position.
        expect(feature.processes.callsStartingWith('gh', FIND)[0].commandLine).toContain('<!-- webpieces-pr-detail v1 -->');
    });

    it('POSTs a new comment when none exists yet', async () => {
        feature.processes.respondToPrefix('gh', FIND, feature.processes.ok(''));
        feature.processes.respondToPrefix('gh', WRITE, feature.processes.ok());

        const result = await upserter().upsert(request());

        expect(result.updated).toBe(false);
        expect(writeCall()).toContain('POST');
        expect(writeCall()).toContain('issues/42/comments');
    });

    /** The body travels as a JSON payload file, because `gh api --input` cannot take it on argv. */
    it('writes the body as a JSON payload gh api can consume', async () => {
        feature.processes.respondToPrefix('gh', FIND, feature.processes.ok(''));
        feature.processes.respondToPrefix('gh', WRITE, feature.processes.ok());

        await upserter().upsert(request());

        const written = JSON.parse(fs.readFileSync(path.join(dir, 'detail-comment.json'), 'utf8'));
        expect(written.body).toContain('## Dashboard');
        expect(writeCall()).toContain(`--input ${path.join(dir, 'detail-comment.json')}`);
    });

    /**
     * The payload name is per-request precisely so the two comments finish posts in ONE run cannot
     * clobber each other's file. They used to be one hard-coded `checklist-comment.json`.
     */
    it('keeps the two comments in separate payload files within one run', async () => {
        feature.processes.respondToPrefix('gh', FIND, feature.processes.ok(''));
        feature.processes.respondToPrefix('gh', WRITE, feature.processes.ok());

        await upserter().upsert(request());
        const checklist = request();
        checklist.payloadName = 'checklist-comment.json';
        checklist.body = 'reviewer output';
        await upserter().upsert(checklist);

        expect(JSON.parse(fs.readFileSync(path.join(dir, 'detail-comment.json'), 'utf8')).body)
            .toContain('## Dashboard');
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'checklist-comment.json'), 'utf8')).body)
            .toBe('reviewer output');
    });
});

describe('PrCommentUpserter — failure is reported, never thrown', () => {
    /**
     * Every caller reaches this AFTER the PR is up. Throwing here would turn a finished run into a failed
     * one over a comment, so the verdict is returned and the CALLER decides whether it matters.
     */
    it('returns ok:false rather than throwing when gh fails', async () => {
        feature.processes.respondToPrefix('gh', FIND, feature.processes.fail(1, 'HTTP 502'));
        feature.processes.respondToPrefix('gh', WRITE, feature.processes.fail(1, 'HTTP 502'));

        const r = await upserter().upsert(request());

        expect(r.ok).toBe(false);
        expect(output.stderr).toContain('Could not post the full dashboard comment');
    });

    /** No PR number ⇒ nothing to comment on. A silent no-op, not an error and not a gh call. */
    it('no-ops without calling gh when there is no PR', async () => {
        const r = request();
        r.prNumber = '';
        const result = await upserter().upsert(r);

        expect(result.ok).toBe(false);
        expect(feature.processes.calls).toEqual([]);
    });
});
