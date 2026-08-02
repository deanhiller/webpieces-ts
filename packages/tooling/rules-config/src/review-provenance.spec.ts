import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    ReviewProvenanceService, ReviewerTranscript, ReviewerPaths, OfferedContext,
    ProvenanceWriteRequest, DEFAULT_RETENTION_DAYS,
} from './review-provenance';
import { ReviewerEvidence } from './subagent-provenance';

const svc = new ReviewProvenanceService();
const savedHome = process.env['HOME'];
const savedSession = process.env['CLAUDE_CODE_SESSION_ID'];

afterEach(() => {
    if (savedHome === undefined) delete process.env['HOME']; else process.env['HOME'] = savedHome;
    if (savedSession === undefined) delete process.env['CLAUDE_CODE_SESSION_ID']; else process.env['CLAUDE_CODE_SESSION_ID'] = savedSession;
});

// A fake ~/.claude with the main session transcript and, optionally, a settings.json retention setting.
function fakeHome(sessionId: string, cleanupPeriodDays = 0): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-prov-home-'));
    const projects = path.join(home, '.claude', 'projects', '-Some-Slug');
    fs.mkdirSync(projects, { recursive: true });
    fs.writeFileSync(path.join(projects, `${sessionId}.jsonl`), JSON.stringify({ sessionId }) + '\n');
    if (cleanupPeriodDays > 0) {
        fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ cleanupPeriodDays }));
    }
    return home;
}

function tmpPrDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'wp-prdir-'));
}

// webpieces-disable no-any-unknown -- opaque parsed JSON in a test assertion
function readProvenance(prDir: string): Record<string, unknown> {
    // webpieces-disable no-any-unknown -- parsed JSON is opaque until the assertions narrow it
    return JSON.parse(fs.readFileSync(path.join(prDir, 'provenance.json'), 'utf8')) as Record<string, unknown>;
}

describe('ReviewProvenanceService.mainTranscript', () => {
    it('resolves the main agent transcript from CLAUDE_CODE_SESSION_ID without deriving the cwd-slug', () => {
        process.env['HOME'] = fakeHome('sess-main');
        process.env['CLAUDE_CODE_SESSION_ID'] = 'sess-main';
        expect(svc.mainTranscript()).toMatch(/-Some-Slug[/\\]sess-main\.jsonl$/);
    });

    it('is empty outside a Claude Code session', () => {
        process.env['HOME'] = fakeHome('sess-main');
        delete process.env['CLAUDE_CODE_SESSION_ID'];
        expect(svc.mainTranscript()).toBe('');
        expect(svc.sessionId()).toBe('');
    });

    it('is empty when no project dir holds a transcript for this session', () => {
        process.env['HOME'] = fakeHome('sess-other');
        process.env['CLAUDE_CODE_SESSION_ID'] = 'sess-main';
        expect(svc.mainTranscript()).toBe('');
    });

    it('never throws when ~/.claude does not exist', () => {
        process.env['HOME'] = path.join(os.tmpdir(), 'wp-prov-nonexistent-home');
        process.env['CLAUDE_CODE_SESSION_ID'] = 'sess-main';
        expect(svc.mainTranscript()).toBe('');
    });
});

describe('ReviewProvenanceService.retentionDays', () => {
    it('reads cleanupPeriodDays from ~/.claude/settings.json', () => {
        process.env['HOME'] = fakeHome('sess-r', 7);
        expect(svc.retentionDays()).toBe(7);
    });

    it('falls back to the documented default when the setting is absent', () => {
        process.env['HOME'] = fakeHome('sess-r');
        expect(svc.retentionDays()).toBe(DEFAULT_RETENTION_DAYS);
    });

    it('falls back to the default when settings.json is malformed', () => {
        const home = fakeHome('sess-r');
        fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{ not json');
        process.env['HOME'] = home;
        expect(svc.retentionDays()).toBe(DEFAULT_RETENTION_DAYS);
    });
});

describe('ReviewProvenanceService.expiresOn', () => {
    it('is the OLDEST transcript mtime + retentionDays — when the audit trail STARTS losing links', () => {
        const dir = tmpPrDir();
        const older = path.join(dir, 'older.jsonl');
        const newer = path.join(dir, 'newer.jsonl');
        fs.writeFileSync(older, '{}');
        fs.writeFileSync(newer, '{}');
        // Backdate `older` by 10 days so the two mtimes are unambiguously different.
        const tenDaysAgo = new Date(fs.statSync(newer).mtime.getTime() - 10 * 24 * 60 * 60 * 1000);
        fs.utimesSync(older, tenDaysAgo, tenDaysAgo);

        const expected = new Date(tenDaysAgo.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        expect(svc.expiresOn([newer, older], 30)).toBe(expected);
    });

    it('is empty when nothing was linked', () => {
        expect(svc.expiresOn([], 30)).toBe('');
        expect(svc.expiresOn([path.join(os.tmpdir(), 'wp-prov-missing.jsonl')], 30)).toBe('');
    });
});

describe('ReviewProvenanceService.write', () => {
    it('records the session, the reviewers, and what each was offered versus what it read', () => {
        process.env['HOME'] = fakeHome('sess-w', 14);
        process.env['CLAUDE_CODE_SESSION_ID'] = 'sess-w';
        const prDir = tmpPrDir();
        const transcript = path.join(prDir, 'agent-abc.jsonl');
        fs.writeFileSync(transcript, '{}');

        const request = new ProvenanceWriteRequest(prDir, 'dean/feat', 'deadbeef', 'ok');
        request.offered = new OfferedContext(`${prDir}/diff`, `${prDir}/instructions`);
        request.reviewers = [new ReviewerTranscript(
            new ReviewerEvidence('envvars-reviewer', 'abc', true, false, 26, 14, transcript),
            new ReviewerPaths(`${prDir}/review-envvars-reviewer.json`, `${prDir}/x.instructions.md`, 'docs/envvars.md'),
        )];

        const written = svc.write(request);
        expect(written).toBe(path.join(prDir, 'provenance.json'));

        const parsed = readProvenance(prDir);
        expect(parsed['sessionId']).toBe('sess-w');
        expect(parsed['mainTranscript']).toMatch(/sess-w\.jsonl$/);
        expect(parsed['branch']).toBe('dean/feat');
        expect(parsed['headSha']).toBe('deadbeef');
        expect(parsed['provenanceStatus']).toBe('ok');
        expect(parsed['transcriptRetentionDays']).toBe(14);
        expect(parsed['transcriptsExpireOn']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        // The note-to-the-reader must be the FIRST key, so anything opening the file reads what it is first.
        expect(Object.keys(parsed)[0]).toBe('_WHAT_THIS_IS');

        // webpieces-disable no-any-unknown -- narrowing the parsed reviewers array for the assertions below
        const reviewers = parsed['reviewers'] as Record<string, unknown>[];
        expect(reviewers).toHaveLength(1);
        expect(reviewers[0]?.['id']).toBe('envvars-reviewer');
        expect(reviewers[0]?.['agentId']).toBe('abc');
        expect(reviewers[0]?.['transcript']).toBe(transcript);
        expect(reviewers[0]?.['transcriptExists']).toBe(true);
        expect(reviewers[0]?.['readDiff']).toBe(true);
        expect(reviewers[0]?.['readDoc']).toBe(false);
        expect(reviewers[0]?.['toolCallCount']).toBe(26);
        expect(reviewers[0]?.['offRepoSearches']).toBe(14);
        expect(reviewers[0]?.['docPath']).toBe('docs/envvars.md');
    });

    it('writes a record with empty links rather than throwing when the transcript is gone', () => {
        process.env['HOME'] = fakeHome('sess-gone');
        delete process.env['CLAUDE_CODE_SESSION_ID'];
        const prDir = tmpPrDir();
        const request = new ProvenanceWriteRequest(prDir, 'dean/feat', '', 'skipped');
        request.reviewers = [new ReviewerTranscript(
            new ReviewerEvidence('r', 'a1'), new ReviewerPaths('', '', ''))];

        expect(svc.write(request)).not.toBe('');
        const parsed = readProvenance(prDir);
        expect(parsed['sessionId']).toBe('');
        expect(parsed['mainTranscript']).toBe('');
        expect(parsed['transcriptsExpireOn']).toBe('');
        // webpieces-disable no-any-unknown -- narrowing the parsed reviewers array
        const reviewers = parsed['reviewers'] as Record<string, unknown>[];
        expect(reviewers[0]?.['transcriptExists']).toBe(false);
    });

    it('returns "" instead of throwing when the record cannot be written', () => {
        // A prDir whose parent is a FILE — mkdirSync cannot create it.
        const file = path.join(tmpPrDir(), 'not-a-dir');
        fs.writeFileSync(file, 'x');
        expect(svc.write(new ProvenanceWriteRequest(path.join(file, 'pr'), 'b', '', 'ok'))).toBe('');
    });
});

describe('ReviewProvenanceService.archive', () => {
    it('copies the record to old-provenance.json so an archived review keeps its transcript links', () => {
        process.env['HOME'] = fakeHome('sess-a');
        process.env['CLAUDE_CODE_SESSION_ID'] = 'sess-a';
        const prDir = tmpPrDir();
        svc.write(new ProvenanceWriteRequest(prDir, 'dean/feat', 'sha', 'ok'));

        const archived = svc.archive(prDir);
        expect(archived).toBe(path.join(prDir, 'old-provenance.json'));
        // A COPY: unlike review.json this file is not an input to anything, so it stays put.
        expect(fs.existsSync(path.join(prDir, 'provenance.json'))).toBe(true);
        expect(readProvenance(prDir)['sessionId']).toBe('sess-a');
    });

    it('is a no-op when there is nothing to archive', () => {
        expect(svc.archive(tmpPrDir())).toBe('');
    });
});
