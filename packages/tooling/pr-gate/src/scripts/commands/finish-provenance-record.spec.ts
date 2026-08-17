import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    PrGateConfig, RequiredChecklist, ReviewJsonService, ReviewProvenanceService,
    ReviewerInstructionsService, SubagentProvenanceService, toError,
} from '@webpieces/rules-config';
import { ProvenanceEnforcer } from '../workflow/provenance-enforcer';
import { AiBranchName } from '../workflow/git-readAiBranchName';

/**
 * The guarantee under test: `wp-finish-upsert-pr` writes the transcript-provenance record BEFORE it refuses
 * for a missing reviewer. A record that only ever appeared on success could not answer the one question it
 * exists for — "what did the reviewers actually do the time this was rejected?" — so the ORDER is the
 * feature, not an implementation detail.
 *
 * Drives ProvenanceEnforcer directly. This used to construct the whole FinishUpsertPrCommand with a row of
 * `null as never` stubs and then reach through `command as unknown as { enforceProvenance(...) }`, because
 * the method was private on a 700-line command; extracting the class made `enforce` simply public, and the
 * stub row — which broke every time the command gained a constructor parameter — is gone with it.
 *
 * The provenance readers themselves are covered by subagent-provenance.spec.ts and review-provenance.spec.ts.
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

// Every collaborator is REAL — the class is small enough to build outright, which is the point of the split.
function enforcerUnderTest(): ProvenanceEnforcer {
    const reviewJsonService = new ReviewJsonService();
    return new ProvenanceEnforcer(
        new FixedBranchName(),
        new SubagentProvenanceService(),
        new ReviewProvenanceService(),
        new ReviewerInstructionsService(reviewJsonService),
        reviewJsonService,
    );
}

function enforce(repoRoot: string, required: RequiredChecklist[]): void {
    enforcerUnderTest().enforce(required, 'dean/feat', repoRoot, new PrGateConfig());
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

/**
 * "RAN BUT UNATTRIBUTABLE" IS NOT "NEVER RAN", AND THE TWO NEED OPPOSITE INSTRUCTIONS.
 *
 * Measured live: stage ② reported all seven reviewers already reviewed, verdict STANDS, do NOT re-spawn —
 * and stage ③, minutes later on the same branch, reported all seven as never having run and told the agent
 * to spawn each as its own subagent. Obeying ③ overwrites the seven verdicts ② just certified, and the
 * replacements are stamped with the same cwd, so ③ refuses again: a loop that destroys evidence every
 * iteration. Assert this SEPARATELY from the credit rule — fixing attribution still leaves the
 * loop-inducing text reachable by any other attribution failure.
 */
// A harness whose reviewer ran but is stamped with a branch that does not match — attribution fails, and
// nothing in `context` can rescue it because the test writes no diff and the transcript touches nothing.
function unattributableHarness(sessionId: string, agentType: string): string {
    return fakeHarness(sessionId, agentType, 'some/other-branch');
}

// The verdict file stage ② wrote, at the path the enforcer derives for `id`.
function writeVerdict(repoRoot: string, id: string): void {
    const dir = path.join(repoRoot, '.webpieces', 'pr-review', 'dean/feat');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `review-${id}.json`), JSON.stringify({ verdict: 'green', override: '' }));
}

function refusalFor(repoRoot: string, required: RequiredChecklist[]): string {
    // webpieces-disable no-unmanaged-exceptions -- the refusal IS the assertion subject
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        enforce(repoRoot, required);
        return '';
    } catch (err: unknown) {
        const error = toError(err);
        return error.message;
    }
}

describe('ProvenanceEnforcer refusal wording', () => {
    it('never says "spawn each as its OWN subagent" for a checklist whose verdict already exists', () => {
        process.env['HOME'] = unattributableHarness('sess-u1', 'envvars-reviewer');
        process.env['CLAUDE_CODE_SESSION_ID'] = 'sess-u1';
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-fin-repo-'));
        writeVerdict(repoRoot, 'envvars');

        const message = refusalFor(repoRoot, [new RequiredChecklist('envvars', 'envvars-reviewer', '', [])]);
        expect(message).toMatch(/envvars-reviewer/);
        expect(message).not.toMatch(/spawn each as its OWN subagent/);
        expect(message).toMatch(/Do NOT re-spawn/);
        // The recovery the old output never named: the cwd is the thing that has to change.
        expect(message).toMatch(/cwd IS the worktree/);
    });

    it('still says "spawn each as its OWN subagent" when there is no verdict file — that one really did not run', () => {
        process.env['HOME'] = unattributableHarness('sess-u2', 'envvars-reviewer');
        process.env['CLAUDE_CODE_SESSION_ID'] = 'sess-u2';
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-fin-repo-'));

        const message = refusalFor(repoRoot, [new RequiredChecklist('envvars', 'envvars-reviewer', '', [])]);
        expect(message).toMatch(/spawn each as its OWN subagent/);
        expect(message).not.toMatch(/Do NOT re-spawn/);
    });

    // The live output read "1 checklist(s) require …" above a list of SEVEN names, because it counted
    // message paragraphs instead of checklists.
    it('counts CHECKLISTS at fault, not message paragraphs', () => {
        process.env['HOME'] = unattributableHarness('sess-u3', 'nobody');
        process.env['CLAUDE_CODE_SESSION_ID'] = 'sess-u3';
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-fin-repo-'));

        const message = refusalFor(repoRoot, [
            new RequiredChecklist('envvars', 'envvars-reviewer', '', []),
            new RequiredChecklist('migrations', 'migrations-reviewer', '', []),
            new RequiredChecklist('security', 'security-reviewer', '', []),
        ]);
        expect(message).toMatch(/^3 checklist\(s\) failed the reviewer-provenance check/);
    });

    // Both failure kinds at once: each checklist gets the instruction that fits IT, in one refusal.
    it('splits a mixed round so neither checklist gets the other one’s instruction', () => {
        process.env['HOME'] = unattributableHarness('sess-u4', 'envvars-reviewer');
        process.env['CLAUDE_CODE_SESSION_ID'] = 'sess-u4';
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-fin-repo-'));
        writeVerdict(repoRoot, 'envvars');

        const message = refusalFor(repoRoot, [
            new RequiredChecklist('envvars', 'envvars-reviewer', '', []),
            new RequiredChecklist('migrations', 'migrations-reviewer', '', []),
        ]);
        expect(message).toMatch(/^2 checklist\(s\)/);
        expect(message).toMatch(/did not run on this branch \(spawn each as its OWN subagent[^)]*\): migrations-reviewer/);
        expect(message).toMatch(/cannot attribute to them: envvars-reviewer/);
    });
});
