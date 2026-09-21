import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
    PrGateConfig, RequiredChecklist, REVIEWER_AGENTS_PLACEHOLDER, ReviewerAgentPolicy, ReviewJsonService, ReviewProvenanceService,
    ReviewerInstructionsService, SubagentProvenanceService, toError, ProvenanceResult, PROVENANCE_MISSING, specTempDirs } from '@webpieces/rules-config';
import { ProvenanceEnforcer } from '../workflow/provenance-enforcer';
import { AiBranchName } from '../workflow/git-readAiBranchName';

const agent = (name: string): ReviewerAgentPolicy => new ReviewerAgentPolicy(name, REVIEWER_AGENTS_PLACEHOLDER);

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
const savedConfigDir = process.env['CLAUDE_CONFIG_DIR'];

// Cleared per test: every fixture relocates HOME, so a developer whose own shell relocates the config
// dir would otherwise be asserting against a second, real tree. The #963 case sets it explicitly.
beforeEach(() => {
    delete process.env['CLAUDE_CONFIG_DIR'];
});

afterEach(() => {
    if (savedHome === undefined) delete process.env['HOME']; else process.env['HOME'] = savedHome;
    if (savedSession === undefined) delete process.env['CLAUDE_CODE_SESSION_ID']; else process.env['CLAUDE_CODE_SESSION_ID'] = savedSession;
    if (savedConfigDir === undefined) delete process.env['CLAUDE_CONFIG_DIR']; else process.env['CLAUDE_CONFIG_DIR'] = savedConfigDir;
});

// A ~/.claude holding the main session transcript and one subagent run of `agentType` on `branch`.
function fakeHarness(sessionId: string, agentType: string, branch: string): string {
    const home = specTempDirs.make('wp-fin-home-');
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
        process.env['HOME'] = fakeHarness('sess-f1', 'envvars-reviewer', 'some/other-branch');
        process.env['CLAUDE_CODE_SESSION_ID'] = 'sess-f1';
        const repoRoot = specTempDirs.make('wp-fin-repo-');

        expect(() => enforce(repoRoot, [new RequiredChecklist('envvars', agent('envvars-reviewer'), '', [])]))
            .toThrow(/: envvars/);

        const parsed = provenanceIn(repoRoot);
        expect(parsed['provenanceStatus']).toBe('missing');
        expect(parsed['sessionId']).toBe('sess-f1');
        expect(parsed['mainTranscript']).toMatch(/sess-f1\.jsonl$/);
    });

    it('links each reviewer that DID run to its own transcript', () => {
        process.env['HOME'] = fakeHarness('sess-f2', 'envvars-reviewer', 'dean/feat');
        process.env['CLAUDE_CODE_SESSION_ID'] = 'sess-f2';
        const repoRoot = specTempDirs.make('wp-fin-repo-');

        enforce(repoRoot, [new RequiredChecklist('envvars-reviewer', agent('envvars-reviewer'), 'docs/env.md', [])]);

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
        const repoRoot = specTempDirs.make('wp-fin-repo-');

        enforce(repoRoot, []);

        const parsed = provenanceIn(repoRoot);
        expect(parsed['reviewers']).toEqual([]);
        expect(parsed['mainTranscript']).toMatch(/sess-f3\.jsonl$/);
    });
});

/**
 * Issue #938: with `reviewerAgents` set, ONE `webpieces-reviewer` run may cover several checklists; without
 * it, the same single run leaves every checklist after the first unattributed.
 */
describe('ProvenanceEnforcer — one shared reviewer agent type', () => {
    const shared = (max: number): RequiredChecklist[] => ['a', 'b'].map((id: string): RequiredChecklist =>
        new RequiredChecklist(id, new ReviewerAgentPolicy('webpieces-reviewer', max), '', []));
    const configWith = (max: number): PrGateConfig => {
        const config = new PrGateConfig();
        config.reviewer = new ReviewerAgentPolicy('webpieces-reviewer', max);
        return config;
    };

    it('passes when reviewerAgents lets one run cover both checklists, and records a row per checklist', () => {
        process.env['HOME'] = fakeHarness('sess-g1', 'webpieces-reviewer', 'dean/feat');
        process.env['CLAUDE_CODE_SESSION_ID'] = 'sess-g1';
        const repoRoot = specTempDirs.make('wp-fin-repo-');

        enforcerUnderTest().enforce(shared(1), 'dean/feat', repoRoot, configWith(1));

        // webpieces-disable no-any-unknown -- narrowing the parsed reviewers array
        const reviewers = provenanceIn(repoRoot)['reviewers'] as Record<string, unknown>[];
        expect(reviewers.map((r: Record<string, unknown>): unknown => r['id'])).toEqual(['a', 'b']);
        expect(reviewers.every((r: Record<string, unknown>): boolean => r['agentId'] === 'r1')).toBe(true);
        expect(reviewers.every((r: Record<string, unknown>): boolean => r['agentType'] === 'webpieces-reviewer')).toBe(true);
    });

    // The mirror of the test above, at a cap HIGH enough to have used one subagent per checklist. It still
    // passes on a single run: the cap is a MAXIMUM, so grouping is permitted at every value of it. This is
    // the behaviour change that came with making `reviewerAgents` required — absent used to demand a
    // DISTINCT run per checklist, and no cap can express that, so the demand went with the key.
    it('credits one run for every checklist even at a cap that would have allowed one each', () => {
        process.env['HOME'] = fakeHarness('sess-g2', 'webpieces-reviewer', 'dean/feat');
        process.env['CLAUDE_CODE_SESSION_ID'] = 'sess-g2';
        const repoRoot = specTempDirs.make('wp-fin-repo-');

        expect(enforcerUnderTest().enforce(shared(2), 'dean/feat', repoRoot, configWith(2)).verified).toBe(true);
    });

    it('requires no reviewer provenance when reviewerAgents is zero', () => {
        process.env['HOME'] = fakeHarness('sess-g3', 'unrelated-agent', 'dean/feat');
        process.env['CLAUDE_CODE_SESSION_ID'] = 'sess-g3';
        const repoRoot = specTempDirs.make('wp-fin-repo-');

        const report = enforcerUnderTest().enforce(shared(0), 'dean/feat', repoRoot, configWith(0));

        expect(report.verified).toBe(true);
        expect(report.evidence).toEqual([]);
        expect(provenanceIn(repoRoot)['reviewers']).toEqual([]);
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
    fs.writeFileSync(path.join(dir, `review-${id}.json`), JSON.stringify({ verdict: 'green' }));
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
        const repoRoot = specTempDirs.make('wp-fin-repo-');
        writeVerdict(repoRoot, 'envvars');

        const message = refusalFor(repoRoot, [new RequiredChecklist('envvars', agent('envvars-reviewer'), '', [])]);
        expect(message).toMatch(/envvars/);
        expect(message).not.toMatch(/spawn each as its OWN subagent/);
        expect(message).toMatch(/Do NOT re-spawn/);
        // The recovery the old output never named: the cwd is the thing that has to change.
        expect(message).toMatch(/cwd IS the worktree/);
    });

    it('still says "spawn each as its OWN subagent" when there is no verdict file — that one really did not run', () => {
        process.env['HOME'] = unattributableHarness('sess-u2', 'envvars-reviewer');
        process.env['CLAUDE_CODE_SESSION_ID'] = 'sess-u2';
        const repoRoot = specTempDirs.make('wp-fin-repo-');

        const message = refusalFor(repoRoot, [new RequiredChecklist('envvars', agent('envvars-reviewer'), '', [])]);
        expect(message).toMatch(/no reviewer subagent ran on this branch/);
        expect(message).not.toMatch(/Do NOT re-spawn/);
    });

    // The live output read "1 checklist(s) require …" above a list of SEVEN names, because it counted
    // message paragraphs instead of checklists.
    it('counts CHECKLISTS at fault, not message paragraphs', () => {
        process.env['HOME'] = unattributableHarness('sess-u3', 'nobody');
        process.env['CLAUDE_CODE_SESSION_ID'] = 'sess-u3';
        const repoRoot = specTempDirs.make('wp-fin-repo-');

        const message = refusalFor(repoRoot, [
            new RequiredChecklist('envvars', agent('envvars-reviewer'), '', []),
            new RequiredChecklist('migrations', agent('migrations-reviewer'), '', []),
            new RequiredChecklist('security', agent('security-reviewer'), '', []),
        ]);
        expect(message).toMatch(/^3 checklist\(s\) failed the reviewer-provenance check/);
    });

    // Both failure kinds at once: each checklist gets the instruction that fits IT, in one refusal.
    it('splits a mixed round so neither checklist gets the other one’s instruction', () => {
        process.env['HOME'] = unattributableHarness('sess-u4', 'envvars-reviewer');
        process.env['CLAUDE_CODE_SESSION_ID'] = 'sess-u4';
        const repoRoot = specTempDirs.make('wp-fin-repo-');
        writeVerdict(repoRoot, 'envvars');

        const message = refusalFor(repoRoot, [
            new RequiredChecklist('envvars', agent('envvars-reviewer'), '', []),
            new RequiredChecklist('migrations', agent('migrations-reviewer'), '', []),
        ]);
        expect(message).toMatch(/^2 checklist\(s\)/);
        expect(message).toMatch(/no reviewer subagent ran on this branch for these checklists \([^)]*\): migrations/);
        expect(message).toMatch(/cannot attribute to them: envvars/);
    });

    /**
     * Issue #963: when provenance found NO transcripts for a KNOWN session, the fault is the transcript
     * ROOT and not the reviewers — say so, instead of the cwd/worktree advice.
     *
     * The main agent's transcript is located by session id alone (no cwd, no branch, no stamping), so an
     * empty one while the session id is set can only mean nothing was searched in the right place. The
     * old message sent two debugging rounds into cwd stamping, worktrees and primary clones, none of
     * which was involved, while the real cause was a relocated `$CLAUDE_CONFIG_DIR`.
     */
    it('blames the transcript ROOT, not the reviewers, when the session has no transcript anywhere', () => {
        const home = specTempDirs.make('wp-fin-noroot-');
        process.env['HOME'] = home;
        process.env['CLAUDE_CONFIG_DIR'] = specTempDirs.make('wp-fin-cfg-');
        process.env['CLAUDE_CODE_SESSION_ID'] = 'sess-noroot';
        const repoRoot = specTempDirs.make('wp-fin-repo-');
        writeVerdict(repoRoot, 'envvars');

        const message = refusalFor(repoRoot, [new RequiredChecklist('envvars', agent('envvars-reviewer'), '', [])]);
        expect(message).toMatch(/NO transcripts at all for session sess-noroot/);
        expect(message).toMatch(/CLAUDE_CONFIG_DIR=/);
        expect(message).toMatch(/transcript-LOCATION problem/);
        // The advice written for a DIFFERENT fault must not appear for this one.
        expect(message).not.toMatch(/cwd IS the worktree/);
        // …and the verdicts are still declared intact, so nobody re-spawns over them.
        expect(message).toMatch(/Do NOT re-spawn/);
    });

    // The mirror: the session IS found, only these reviewers are not — which is the case the cwd advice
    // was actually written for, so it must still print.
    it('keeps the cwd advice when the session was found but the reviewers were not', () => {
        process.env['HOME'] = unattributableHarness('sess-u5', 'envvars-reviewer');
        process.env['CLAUDE_CODE_SESSION_ID'] = 'sess-u5';
        const repoRoot = specTempDirs.make('wp-fin-repo-');
        writeVerdict(repoRoot, 'envvars');

        const message = refusalFor(repoRoot, [new RequiredChecklist('envvars', agent('envvars-reviewer'), '', [])]);
        expect(message).toMatch(/cwd IS the worktree/);
        expect(message).not.toMatch(/transcript-LOCATION problem/);
    });
});

/**
 * A verdict that says UNVERIFIED must REFUSE, whatever else is true.
 *
 * Review finding: `enforce` refused on `result.missing`, so a `PROVENANCE_MISSING` carrying no names
 * would have been a silent pass — reported unverified and blocked by nothing. Today's one construction
 * site always passes the list, so this was a latent type hole rather than a live bug; `refuse` now keys
 * on the STATUS and falls back to `detail`, which is what this pins.
 */
describe('ProvenanceEnforcer refuses on the STATUS, not the length of the name list', () => {
    it('throws for a MISSING verdict that carries no names, using its detail as the reason', () => {
        const namelessMissing = new ProvenanceResult(PROVENANCE_MISSING, 'transcripts unreadable this round', {}, []);
        const provenance = new SubagentProvenanceService();
        provenance.verifyReviewers = (): ProvenanceResult => namelessMissing;
        const reviewJsonService = new ReviewJsonService();
        const enforcer = new ProvenanceEnforcer(
            new FixedBranchName(), provenance, new ReviewProvenanceService(),
            new ReviewerInstructionsService(reviewJsonService), reviewJsonService,
        );
        const repoRoot = specTempDirs.make('wp-fin-repo-');

        expect(() => enforcer.enforce(
            [new RequiredChecklist('envvars', agent('envvars-reviewer'), '', [])], 'dean/feat', repoRoot, new PrGateConfig()))
            .toThrow(/transcripts unreadable this round/);
    });

    // …and never announces "0 checklist(s) failed" on the way out.
    it('never reports a fault count of zero while refusing', () => {
        const namelessMissing = new ProvenanceResult(PROVENANCE_MISSING, 'transcripts unreadable this round', {}, []);
        const provenance = new SubagentProvenanceService();
        provenance.verifyReviewers = (): ProvenanceResult => namelessMissing;
        const reviewJsonService = new ReviewJsonService();
        const enforcer = new ProvenanceEnforcer(
            new FixedBranchName(), provenance, new ReviewProvenanceService(),
            new ReviewerInstructionsService(reviewJsonService), reviewJsonService,
        );
        const repoRoot = specTempDirs.make('wp-fin-repo-');

        expect(() => enforcer.enforce([], 'dean/feat', repoRoot, new PrGateConfig())).toThrow(/^1 checklist\(s\) failed/);
    });
});
