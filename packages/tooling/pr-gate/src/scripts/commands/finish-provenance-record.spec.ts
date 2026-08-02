import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    PrGateConfig, RequiredChecklist, ReviewJsonService, ReviewProvenanceService,
    ReviewerInstructionsService, SubagentProvenanceService,
} from '@webpieces/rules-config';
import { FinishUpsertPrCommand } from './finish-upsert-pr-command';
import { AiBranchName } from '../workflow/git-readAiBranchName';

/**
 * The guarantee under test: `wp-finish-upsert-pr` writes the transcript-provenance record BEFORE it refuses
 * for a missing reviewer. A record that only ever appeared on success could not answer the one question it
 * exists for — "what did the reviewers actually do the time this was rejected?" — so the ORDER is the
 * feature, not an implementation detail.
 *
 * Only the collaborators `enforceProvenance` touches are real; the rest of the command (git, gh, the build
 * gate) is never reached on this path. The provenance readers themselves are covered by
 * subagent-provenance.spec.ts and review-provenance.spec.ts.
 */

const savedHome = process.env['HOME'];
const savedSession = process.env['CLAUDE_CODE_SESSION_ID'];

afterEach(() => {
    if (savedHome === undefined) delete process.env['HOME']; else process.env['HOME'] = savedHome;
    if (savedSession === undefined) delete process.env['CLAUDE_CODE_SESSION_ID']; else process.env['CLAUDE_CODE_SESSION_ID'] = savedSession;
});

// A ~/.claude holding the main session transcript and one subagent run of `agentType` on `branch`.
function fakeHarness(sessionId: string, agentType: string, branch: string): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-fin-home-'));
    const projects = path.join(home, '.claude', 'projects', '-Slug');
    const subagents = path.join(projects, sessionId, 'subagents');
    fs.mkdirSync(subagents, { recursive: true });
    fs.writeFileSync(path.join(projects, `${sessionId}.jsonl`), '{}\n');
    fs.writeFileSync(path.join(subagents, 'agent-r1.meta.json'), JSON.stringify({ agentType, spawnDepth: 1 }));
    fs.writeFileSync(path.join(subagents, 'agent-r1.jsonl'), JSON.stringify({ isSidechain: true, gitBranch: branch }) + '\n');
    return home;
}

class FixedBranchName extends AiBranchName {
    getFeatureName(): string {
        return 'dean/feat';
    }
}

// The command with only the provenance collaborators wired; nothing else is reached on this path.
function commandUnderTest(): FinishUpsertPrCommand {
    const reviewJsonService = new ReviewJsonService();
    const stub = null as unknown as never;
    return new FinishUpsertPrCommand(
        stub, new FixedBranchName(), stub, stub, stub, stub, stub, stub, stub, stub, stub,
        reviewJsonService, stub,
        new SubagentProvenanceService(),
        new ReviewProvenanceService(),
        new ReviewerInstructionsService(reviewJsonService),
        stub, stub,
    );
}

// enforceProvenance is private — the guarantee is about the command's behaviour, not about a public API,
// and exposing it purely to be tested would be a worse design than reaching for it here.
// webpieces-disable no-any-unknown -- narrowing to the one private method under test
type ProvenanceEntry = {
    enforceProvenance(required: readonly RequiredChecklist[], branch: string, repoRoot: string, config: PrGateConfig): unknown;
};

function enforce(repoRoot: string, required: RequiredChecklist[]): void {
    // webpieces-disable no-any-unknown -- see ProvenanceEntry above
    const command = commandUnderTest() as unknown as ProvenanceEntry;
    command.enforceProvenance(required, 'dean/feat', repoRoot, new PrGateConfig());
}

function provenanceIn(repoRoot: string): Record<string, unknown> {
    const file = path.join(repoRoot, '.webpieces', 'pr-review', 'dean/feat', 'provenance.json');
    // webpieces-disable no-any-unknown -- opaque parsed JSON in a test assertion
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

describe('FinishUpsertPrCommand provenance record', () => {
    it('writes the record BEFORE refusing for a reviewer that never ran', () => {
        process.env['HOME'] = fakeHarness('sess-f1', 'some-other-agent', 'dean/feat');
        process.env['CLAUDE_CODE_SESSION_ID'] = 'sess-f1';
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-fin-repo-'));

        expect(() => enforce(repoRoot, [new RequiredChecklist('envvars', 'envvars-reviewer', '', [])]))
            .toThrow(/envvars-reviewer/);

        const parsed = provenanceIn(repoRoot);
        expect(parsed['provenanceStatus']).toBe('missing');
        expect(parsed['sessionId']).toBe('sess-f1');
        expect(parsed['mainTranscript']).toMatch(/sess-f1\.jsonl$/);
    });

    it('links each reviewer that DID run to its own transcript', () => {
        process.env['HOME'] = fakeHarness('sess-f2', 'envvars-reviewer', 'dean/feat');
        process.env['CLAUDE_CODE_SESSION_ID'] = 'sess-f2';
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-fin-repo-'));

        enforce(repoRoot, [new RequiredChecklist('envvars-reviewer', 'envvars-reviewer', 'docs/env.md', [])]);

        const parsed = provenanceIn(repoRoot);
        expect(parsed['provenanceStatus']).toBe('ok');
        // webpieces-disable no-any-unknown -- narrowing the parsed reviewers array
        const reviewers = parsed['reviewers'] as Record<string, unknown>[];
        expect(reviewers).toHaveLength(1);
        expect(reviewers[0]?.['agentId']).toBe('r1');
        expect(reviewers[0]?.['transcript']).toMatch(/subagents[/\\]agent-r1\.jsonl$/);
        expect(reviewers[0]?.['verdictFile']).toMatch(/review-envvars-reviewer\.json$/);
        expect(reviewers[0]?.['instructionsFile']).toMatch(/envvars-reviewer\.instructions\.md$/);
        expect(reviewers[0]?.['docPath']).toBe(path.resolve(repoRoot, 'docs/env.md'));
    });

    it('records the session even for a repo with no checklists at all', () => {
        process.env['HOME'] = fakeHarness('sess-f3', 'unused', 'dean/feat');
        process.env['CLAUDE_CODE_SESSION_ID'] = 'sess-f3';
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-fin-repo-'));

        enforce(repoRoot, []);

        const parsed = provenanceIn(repoRoot);
        expect(parsed['reviewers']).toEqual([]);
        expect(parsed['mainTranscript']).toMatch(/sess-f3\.jsonl$/);
    });
});
