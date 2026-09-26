import { describe, it, expect } from 'vitest';
import {
    ChecklistInstructionsService, RequiredChecklist, REVIEWER_AGENTS_PLACEHOLDER, ReviewerAgentPolicy, ReviewerBriefing,
    ReviewerInstructionsService, ReviewJsonService,
} from '@webpieces/rules-config';
import { ChecklistNotice } from './checklist-notice';
import { RefusedReviewer, ReviewReport, ReviewReportInput } from './review-report';
import { STANDING_CURRENT, STANDING_REJECTED, STANDING_STALE, VerdictStanding } from './verdict-provenance';

const POLICY = new ReviewerAgentPolicy('webpieces-reviewer', REVIEWER_AGENTS_PLACEHOLDER);
const REVIEW_PATH = '/repo/.webpieces/pr-review/dean-feature/summary.json';
const report = new ReviewReport(
    new ChecklistNotice(), new ReviewerInstructionsService(new ReviewJsonService()),
    new ChecklistInstructionsService(new ReviewJsonService()));

const inputWith = (definedCount: number, applicableCount: number): ReviewReportInput => {
    const input = new ReviewReportInput('/repo', 'dean-feature', REVIEW_PATH);
    input.definedCount = definedCount;
    input.applicableCount = applicableCount;
    return input;
};

// The repo-wide reviewer agent type, which is what the report states ONCE above the spawn blocks now that
// `reviewerAgents` is a required cap and there is no per-checklist spawn block to name it in.
const DB_POLICY = new ReviewerAgentPolicy('db-migration-reviewer', 1);

const withOneOwedReviewer = (): ReviewReportInput => {
    const input = inputWith(1, 1);
    input.reviewer = DB_POLICY;
    const briefing = new ReviewerBriefing('db-migration-reviewer', 'db-migration-reviewer', '/repo');
    briefing.matchedPatterns = ['**/*.sql'];
    input.briefings = [briefing];
    return input;
};

/** One REQUIRED + one OPTIONAL reviewer, both owed — the shape the whole `required` feature turns on. */
const withMixedReviewers = (): ReviewReportInput => {
    const input = inputWith(2, 2);
    input.reviewer = DB_POLICY;
    const req = new ReviewerBriefing('db-migration-reviewer', 'db-migration-reviewer', '/repo');
    req.matchedPatterns = ['**/*.sql'];
    const opt = new ReviewerBriefing('frontend-reviewer', 'frontend-reviewer', '/repo');
    opt.matchedPatterns = ['**/portal/**'];
    opt.docPath = '/repo/.claude/review/frontend.md';
    opt.required = false;
    input.briefings = [req, opt];
    return input;
};

const mixed = (): string => report.render(withMixedReviewers());

const noChecklists = (): string => report.render(inputWith(0, 0));
const nothingMatched = (): string => report.render(inputWith(3, 0));
const oneOwed = (): string => report.render(withOneOwedReviewer());

const countOf = (text: string, needle: string): number => text.split(needle).length - 1;

/**
 * THE regression. On PR #519 an agent read stage ②'s output top to bottom, hit "Carry on and run: pnpm
 * wp-finish-upsert-pr" in the zero-checklist notice, and ran finish — skipping the summary.json instruction
 * printed directly beneath it. These assertions treat the output as an API: exactly one next step, in the
 * order it must actually be performed.
 */
describe('exactly one "what to do next", in the right order', () => {
    const everyVariant = (): string[] => [noChecklists(), nothingMatched(), oneOwed()];

    it('names wp-finish-upsert-pr as something to run EXACTLY once, in every variant', () => {
        for (const text of everyVariant()) {
            expect(countOf(text, 'wp-finish-upsert-pr')).toBe(1);
        }
    });

    it('puts the summary.json instruction BEFORE the finish command, always', () => {
        for (const text of everyVariant()) {
            expect(text.indexOf('Write the PR summary to:')).toBeGreaterThanOrEqual(0);
            expect(text.indexOf('Write the PR summary to:')).toBeLessThan(text.indexOf('wp-finish-upsert-pr'));
        }
    });

    it('prints the summary.json path and the schema the finish gate validates', () => {
        expect(noChecklists()).toContain(REVIEW_PATH);
        expect(noChecklists()).toContain('"riskLevel"');
    });

    // No line may read as "you are done, go finish" before step 1 has been stated.
    it('never says to carry on / continue to a command before summary.json is asked for', () => {
        for (const text of everyVariant()) {
            expect(text).not.toMatch(/carry on and run/i);
            const beforeStep1 = text.slice(0, text.indexOf('STEP 1'));
            expect(beforeStep1).not.toContain('wp-finish-upsert-pr');
        }
    });

    /**
     * #1033: Claude auto-mode refused the author's write of `review.json` as Self-Approval — a file named
     * like the reviewers' verdicts, requested with "review your own changes, then write the review file".
     * The author's step is a PR SUMMARY, and nothing stage ② prints may frame it as the author reviewing.
     */
    it('asks the author for a PR summary at summary.json — never for its own review', () => {
        for (const text of everyVariant()) {
            expect(text).toContain('write the PR summary (title, summary, risk) to summary.json');
            expect(text).not.toMatch(/review your own changes|write the review file|your PR review/i);
            expect(text).not.toMatch(/(^|[^-\w])review\.json/);
        }
    });

    it('makes step 1 explicitly non-optional', () => {
        expect(noChecklists()).toContain('Step 1 is NOT optional');
    });
});

/**
 * THE regression this ordering exists for. The block used to print the spawn blocks and THEN say to write
 * summary.json "WHILE any reviewer subagents above are still running" — an instruction to spawn first. A
 * reviewer whose checklist judges the PR's stated intent (title / summary / risk level) reads summary.json
 * itself, so spawning first means it reads nothing (false RED, wasted run) or, on a second stage-② run on
 * the same branch, the PREVIOUS run's file (false GREEN against a title that no longer exists). Asserted on
 * the rendered string because the ordering IS the contract.
 */
describe('summary.json is written BEFORE any reviewer is spawned', () => {
    it('puts the summary.json instruction before the first spawn block', () => {
        const text = oneOwed();
        expect(text.indexOf('Write the PR summary to:')).toBeLessThan(text.indexOf('subagent_type:'));
    });

    it('numbers writing the PR summary as step 1 and spawning as step 2', () => {
        const text = oneOwed();
        expect(text.indexOf('STEP 1')).toBeLessThan(text.indexOf('STEP 2'));
        expect(text).toMatch(/STEP 2 — only once that file is written, review these/);
        expect(text).toContain('STEP 3');
    });

    it('never tells the AI to write the PR summary while the reviewers run', () => {
        for (const text of [noChecklists(), nothingMatched(), oneOwed()]) {
            expect(text).not.toMatch(/WHILE any reviewer subagents/i);
        }
    });

    // Nothing to spawn ⇒ no step 2 to number, so finish must be step 2 rather than a step 3 with a hole.
    it('drops the spawn step entirely when no reviewer is owed', () => {
        const text = nothingMatched();
        expect(text).toContain('▶ NEXT — 2 steps');
        expect(text).not.toContain('STEP 3');
        expect(text).not.toContain('subagent_type:');
    });

    it('counts three steps when a reviewer is owed', () => {
        expect(oneOwed()).toContain('▶ NEXT — 3 steps');
    });
});

describe('a repo with zero checklists gets the verdict first, not a tutorial', () => {
    it('gives the all-clear before any configuration guidance', () => {
        const text = noChecklists();
        expect(text.indexOf('✅')).toBeLessThan(text.indexOf('webpieces.config.json'));
    });

    it('states the verdict within the first handful of lines after the header', () => {
        const lines = noChecklists().split('\n');
        const verdict = lines.findIndex((l: string): boolean => l.includes('NONE CONFIGURED'));
        const allClear = lines.findIndex((l: string): boolean => l.includes('✅'));
        expect(verdict).toBeGreaterThanOrEqual(0);
        expect(allClear).toBe(verdict + 1);
    });

    // Deleting the how-to would be the wrong fix — it is what teaches a repo to get reviews at all.
    it('still keeps the how-to-configure guidance, just below the all-clear', () => {
        const text = noChecklists();
        expect(text).toContain('"id": "db-migrations"');
        expect(text).toContain('"patterns"');
        // The retired per-entry key must not be taught by the how-to.
        expect(text).not.toContain('"subagent"');
    });
});

/**
 * `commands.pr-gate.reviewerAgents` (issue #938). Absent: a separate reviewer-agent subagent per
 * checklist, one spawn block each. Present: ONE statement of the cap and the grouping decision, and each
 * checklist block is just the instructions file to hand to whichever subagent covers it.
 */
describe('reviewerAgents — how many reviewer subagents stage ② asks for', () => {
    const owed = (max: number, ids: readonly string[]): ReviewerReportFixture => {
        const input = inputWith(ids.length, ids.length);
        input.reviewer = new ReviewerAgentPolicy('webpieces-reviewer', max);
        input.briefings = ids.map((id: string): ReviewerBriefing => {
            const b = new ReviewerBriefing('webpieces-reviewer', id, '/repo');
            b.matchedPatterns = ['**'];
            return b;
        });
        return input;
    };

    // `reviewerAgents` is REQUIRED, so every report states a cap. A cap at the checklist count is the
    // closest thing to the deleted un-capped mode, and it must still read as a cap: one stated
    // subagent_type, an AT MOST line, and none of the old "a SEPARATE subagent for each" prose.
    it('a cap equal to the checklist count still renders as a cap, not the deleted per-checklist mode', () => {
        const text = report.render(owed(3, ['a', 'b', 'c']));
        expect(text).toContain('AT MOST 3 subagent(s) of type `webpieces-reviewer` (commands.pr-gate.reviewerAgents = 3)');
        expect(text).not.toContain('a SEPARATE `webpieces-reviewer` subagent for each');
        expect(text.split('subagent_type: webpieces-reviewer').length - 1).toBe(1);
        expect(text).toContain('/repo/.webpieces/pr-review/dean-feature/instructions/b.instructions.md');
    });

    it('with reviewerAgents = 1: one subagent for all of them, subagent_type stated once', () => {
        const text = report.render(owed(1, ['a', 'b', 'c', 'd']));
        expect(text).toContain('AT MOST 1 subagent(s) of type `webpieces-reviewer` (commands.pr-gate.reviewerAgents = 1)');
        expect(text).toContain('Use ONE subagent for all of them.');
        expect(text.split('subagent_type: webpieces-reviewer').length - 1).toBe(1);
        expect(text).toContain('submit ONE verdict per');
        for (const id of ['a', 'b', 'c', 'd']) {
            expect(text).toContain(`instructions:  /repo/.webpieces/pr-review/dean-feature/instructions/${id}.instructions.md`);
        }
        expect(text).not.toContain('SEPARATE');
    });

    it('with reviewerAgents = 2 over 8 checklists: a grouping example that fits the numbers', () => {
        const text = report.render(owed(2, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']));
        expect(text).toContain('AT MOST 2 subagent(s)');
        expect(text).toContain('2 with about 4 each');
    });

    it('a re-run after a red verdict lists only the checklists still owed, under the same cap', () => {
        const input = owed(1, ['a', 'b', 'c']);
        input.reviewed = [new RequiredChecklist('a', POLICY, '', []), new RequiredChecklist('b', POLICY, '', [])];
        const text = report.render(input);
        expect(text).toContain('review these 1 REQUIRED checklist(s) with');
        expect(text).toContain('AT MOST 1 subagent(s)');
        expect(text).toContain('instructions/c.instructions.md');
        expect(text).not.toContain('instructions/a.instructions.md');
    });

    it('counts optional picks against the SAME cap as the required ones', () => {
        const input = owed(2, ['req', 'opt']);
        input.briefings[1].required = false;
        const text = report.render(input);
        expect(text).toContain('at most 2 IN TOTAL');
        expect(text).toContain('COUNTING the 1 required checklist(s) above');
    });

    it('points Codex at the one canonical agent definition, once', () => {
        for (const max of [1, 2]) {
            const text = report.render(owed(max, ['a', 'b']));
            expect(text.split('/repo/.claude/agents/webpieces-reviewer.md').length - 1).toBe(1);
            expect(text).toContain('Codex (no agent types)');
        }
    });
});

type ReviewerReportFixture = ReturnType<typeof inputWith>;

describe('reviewers still owed', () => {
    it('prints one spawn block naming the subagent and its generated instructions file', () => {
        const text = oneOwed();
        expect(text).toContain('subagent_type: db-migration-reviewer');
        expect(text).toContain('/repo/.webpieces/pr-review/dean-feature/instructions/db-migration-reviewer.instructions.md');
        expect(text).toContain('file(s) matched "**/*.sql"');
    });

    it('reuses an already-reviewed checklist instead of re-spawning it', () => {
        const input = withOneOwedReviewer();
        input.reviewed = [new RequiredChecklist('db-migration-reviewer', POLICY, '', [])];
        const text = report.render(input);
        expect(text).toContain('already reviewed on this branch');
        expect(text).toContain('nothing to spawn');
        expect(text).not.toContain('subagent_type:');
        // Even here — nothing left to spawn — the ONE next step is still summary.json, then finish.
        expect(countOf(text, 'wp-finish-upsert-pr')).toBe(1);
    });

    it('calls out unreadable verdict files so the AI fixes the file instead of re-running a reviewer', () => {
        const input = withOneOwedReviewer();
        input.formatErrors = ['review-db-migration-reviewer.json: missing "status"'];
        expect(report.render(input)).toContain('missing "status"');
    });
});

describe('bounded reviewer rounds', () => {
    it('prints the repository-owned global round budget on the first invocation', () => {
        const input = withOneOwedReviewer();
        input.round = 1;
        input.maxReviewerRounds = 2;
        const text = report.render(input);
        expect(text).toContain('subagent_type: db-migration-reviewer');
        expect(text).toContain('GLOBAL REVIEW ROUND 1 OF 2');
    });

    it('at the cap directs the coordinator to finish without another reviewer', () => {
        const input = withOneOwedReviewer();
        input.round = 2;
        input.maxReviewerRounds = 2;
        input.roundAction = 'finish';
        input.redChecklistIds = ['db-migration-reviewer'];
        input.briefings = [];
        const text = report.render(input);
        expect(text).toContain('NOT re-reviewed');
        expect(text).toContain('pnpm wp-finish-upsert-pr');
        expect(text).not.toContain('subagent_type:');
        expect(countOf(text, 'wp-finish-upsert-pr')).toBe(1);
    });

    it('leaves the default review output intact', () => {
        const text = oneOwed();
        expect(text).toContain('subagent_type: db-migration-reviewer');
        expect(text).not.toContain('main_agent_instructions');
        expect(text).not.toContain('SINGLE-ROUND');
    });
});

/**
 * Stage ② had the SAME defect `wp-finish-upsert-pr` did: a refused checklist has no passing verdict, so it
 * is not in `reviewed`, so it was printed as an ordinary owed reviewer with an ordinary spawn block — word
 * for word what a reviewer that never ran gets. An agent obeys that, the reviewer re-reads unchanged code
 * and refuses again, and the loop starts one stage earlier than the loop that was reported.
 *
 * The refusal text itself is NOT re-worded here: it comes from ReviewJsonService.refusalError, the one
 * renderer, so these assertions are about placement and framing, which is what stage ② got wrong.
 */
describe('a reviewer that already REFUSED is not re-instructed as one that never ran', () => {
    const REFUSAL = 'Checklist "db-migration-reviewer" FAILED review (status:"red"). The reviewer wrote:\n      no backfill';

    const withRefusal = (): ReviewReportInput => {
        const input = withOneOwedReviewer();
        input.refused = [new RefusedReviewer('db-migration-reviewer', REFUSAL)];
        return input;
    };

    it("prints the reviewer's own finding instead of only a spawn block", () => {
        const text = report.render(withRefusal());
        expect(text).toContain('no backfill');
        expect(text).toContain('ALREADY REVIEWED THIS BRANCH AND REFUSED');
    });

    it('conditions the re-spawn on fixing the finding FIRST, and says so before the coordinates', () => {
        const text = report.render(withRefusal());
        expect(text.indexOf('FIX THE FINDING FIRST')).toBeLessThan(text.indexOf('instructions:  '));
    });

    it('warns at the top of the step, before an agent starts spawning everything listed', () => {
        const text = report.render(withRefusal());
        expect(text.indexOf('already ANSWERED and refused')).toBeLessThan(text.indexOf('⛔ db-migration-reviewer'));
    });

    // It still owes a FRESH verdict, so dropping its spawn block would leave nothing saying how to get one.
    it('keeps the spawn coordinates, for after the fix', () => {
        const text = report.render(withRefusal());
        expect(text).toContain('subagent_type: db-migration-reviewer');
        expect(text).toContain('db-migration-reviewer.instructions.md');
    });

    // Stage ② enforces nothing and must therefore destroy nothing: retiring the verdict is finish's act on
    // the refusal it is actually enforcing (asserted here as the absence of any claim that it moved).
    it('never claims the verdict was retired — stage ② archives nothing', () => {
        const text = report.render(withRefusal());
        expect(text).not.toContain('RETIRED');
        expect(text).not.toContain('.json.old');
    });

    it('leaves the ordinary spawn block alone when nothing refused', () => {
        const text = oneOwed();
        expect(text).not.toContain('REFUSED');
        expect(text).toContain('▶ db-migration-reviewer — 0 file(s) matched "**/*.sql"');
    });
});

/**
 * OPTIONAL reviewers are OFFERED, never spawned unasked — and the two instructions must never share a step.
 *
 * An agent reading a merged list acts on the stronger of the two verbs, which is "spawn", and the human is
 * never asked at all. That failure is silent: the PR opens, the reviews all ran, and the only evidence that
 * anything went wrong is a token bill. So the split is asserted structurally, not just by wording.
 */
describe('required reviewers are spawned; optional ones are only offered', () => {
    it('puts the required reviewer in a spawn step and the optional one in a later ask step', () => {
        const text = mixed();
        expect(text).toMatch(/STEP 2 — only once that file is written, review these 1 REQUIRED/);
        expect(text.indexOf('STEP 3 — these 1 OPTIONAL')).toBeGreaterThan(text.indexOf('STEP 2'));
        // Order matters: the mandatory work is stated before the discretionary work.
        expect(text.indexOf('db-migration-reviewer')).toBeLessThan(text.indexOf('frontend-reviewer'));
    });

    it('tells the AI to ask ONCE, multi-select, with an explicit way to decline', () => {
        const text = mixed();
        expect(text).toContain('ASK THE HUMAN');
        expect(text).toContain('ONE multi-select question');
        expect(text).toContain('"None — required only"');
        expect(text).toContain('Do not ask one question per reviewer');
    });

    it('forbids deciding for the human, and forbids asking about the required ones', () => {
        const text = mixed();
        expect(text).toContain('you may NOT decide for the human');
        expect(text).toContain('do NOT ask whether to run them');
    });

    // The one non-obvious half of the contract: `required` governs whether a reviewer must RUN, never
    // whether its answer counts. Without this line, "optional" reads as "ignorable".
    it('warns that an optional reviewer that IS run still blocks on red', () => {
        expect(mixed()).toMatch(/red verdict from an\n.*optional reviewer blocks the PR exactly like a required one/);
    });

    // A human choosing between reviews needs to know what each one would look at; "4 file(s) matched" does not
    // say that. Required reviewers get no such line — there is nothing to decide.
    it('shows the guidance doc for an optional reviewer, and not for a required one', () => {
        const text = mixed();
        expect(text).toContain('reviews against: /repo/.claude/review/frontend.md');
        expect(countOf(text, 'reviews against:')).toBe(1);
    });

    it('counts four steps with both kinds owed, and still names finish exactly once', () => {
        const text = mixed();
        expect(text).toContain('▶ NEXT — 4 steps');
        expect(text).toContain('STEP 4 — only once every reviewer you ran has submitted its verdict');
        expect(countOf(text, 'wp-finish-upsert-pr')).toBe(1);
    });

    it('numbers the ask as STEP 2 when nothing is required, so there is no hole', () => {
        const input = withMixedReviewers();
        input.briefings = input.briefings.filter((b: ReviewerBriefing): boolean => !b.required);
        const text = report.render(input);
        expect(text).toContain('▶ NEXT — 3 steps');
        expect(text).toContain('STEP 2 — these 1 OPTIONAL');
        expect(text).toContain('② Write the PR summary, offer the optional reviewers, then finish');
    });
});

/**
 * `--no-optional`: the human said up front to submit without the optional reviews.
 *
 * It removes the OFFER and nothing else. The skipped checklists are still named — a human who meant "not
 * the slow ones" and gets "none of them" can only catch that if the output says which ones went unreviewed.
 */
describe('--no-optional suppresses the offer without hiding what was skipped', () => {
    const skipped = (): string => {
        const input = withMixedReviewers();
        input.skipOptional = true;
        return report.render(input);
    };

    it('prints no ask step and no spawn coordinates for the optional reviewer', () => {
        const text = skipped();
        expect(text).not.toContain('ASK THE HUMAN');
        expect(text).not.toContain('subagent_type: frontend-reviewer');
        expect(text).toContain('▶ NEXT — 3 steps');
    });

    it('still spawns the REQUIRED reviewer — the flag is not a way past the gate', () => {
        expect(skipped()).toContain('subagent_type: db-migration-reviewer');
    });

    it('names the skipped checklists rather than only counting them', () => {
        const text = skipped();
        expect(text).toContain('OPTIONAL checklist(s) matched this diff and were SKIPPED (--no-optional)');
        expect(text).toContain('frontend-reviewer');
        expect(text).toContain('Drop the flag and re-run');
    });

    // The false all-clear this feature could most easily introduce.
    it('never claims everything was reviewed when optional reviews were skipped', () => {
        const input = withMixedReviewers();
        input.skipOptional = true;
        input.reviewed = [new RequiredChecklist('db-migration-reviewer', POLICY, '', [])];
        const text = report.render(input);
        expect(text).not.toContain('Every checklist that applies is already reviewed');
        expect(text).toContain('every REQUIRED checklist is reviewed (optional ones skipped above)');
    });
});

/**
 * Reuse must be stated as a RULE, not merely as a state. A ✅ reading "nothing to spawn" describes the
 * present; an agent that notices the reused verdicts judged an earlier tree then re-spawns them on its own
 * initiative, which costs a full subagent run per reviewer AND destroys a verdict that was already banked (a
 * re-spawned reviewer writes to the same review-<id>.json). Reviews are once per branch by construction —
 * a passing verdict is never archived the way summary.json is — so the output has to say so out loud.
 */
describe('the carry-forward rule is stated, not left to be inferred', () => {
    const reusedOnly = (): string => {
        const input = withOneOwedReviewer();
        input.reviewed = [new RequiredChecklist('db-migration-reviewer', POLICY, '', [])];
        return report.render(input);
    };

    it('names the rule and forbids re-spawning when everything is reused', () => {
        const text = reusedOnly();
        expect(text).toContain('CARRIES FORWARD for as long as its checklist\'s in-scope files are unchanged');
        expect(text).toContain('Do NOT re-spawn');
    });

    it('warns that a re-spawn overwrites the banked verdict, not just that it costs tokens', () => {
        expect(reusedOnly()).toContain('replaces the verdict it already');
    });

    // The all-clear is NOT printed while anything is still owed, so a mixed run would otherwise carry the
    // rule nowhere — and "spawn these two, reuse that one" is precisely the shape that invites re-spawning
    // the reused one along with the rest.
    it('still forbids re-spawning on the reuse line when other reviewers ARE owed', () => {
        const input = withMixedReviewers();
        input.reviewed = [new RequiredChecklist('frontend-reviewer', POLICY, '', [])];
        const text = report.render(input);
        expect(text).not.toContain('nothing to spawn');
        expect(text).toContain('verdict STANDS, do NOT re-spawn');
        expect(text).toContain('subagent_type: db-migration-reviewer');
    });

    // Skipping optional reviews and reusing verdicts are different things; the rule belongs to the reuse.
    it('carries the rule in the --no-optional all-clear too', () => {
        const input = withMixedReviewers();
        input.skipOptional = true;
        input.reviewed = [new RequiredChecklist('db-migration-reviewer', POLICY, '', [])];
        expect(report.render(input)).toContain('CARRIES FORWARD');
    });
});

/**
 * Issue #863 — the banner NAMES every carried verdict and why, and every existing verdict that was
 * re-briefed and why, so a reader never has to guess whether an earlier green still counts.
 */
describe('carried, stale and rejected verdicts are each printed with their reason (issue #863)', () => {
    it('prints a CARRIED green with the sha it was briefed on and the unchanged-scope reason', () => {
        const input = withOneOwedReviewer();
        input.reviewed = [new RequiredChecklist('security-auth-reviewer', POLICY, '', [])];
        input.standings = [new VerdictStanding('security-auth-reviewer', STANDING_CURRENT, 'green', '5e57c16a0000', 'x')];
        expect(report.render(input))
            .toContain('security-auth-reviewer — carried GREEN from 5e57c16a, in-scope files unchanged');
    });

    it('prints a STALE green and a REJECTED verdict as re-briefed, each with its reason', () => {
        const input = withOneOwedReviewer();
        input.standings = [
            new VerdictStanding('db-migration-reviewer', STANDING_STALE, 'green', '1f75a798aaaa', 'in-scope files CHANGED since'),
            new VerdictStanding('other-reviewer', STANDING_REJECTED, 'green', '', 'not submitted through pnpm wp-write-review'),
        ];
        const text = report.render(input);
        expect(text).toContain('db-migration-reviewer — GREEN from 1f75a798 is STALE: in-scope files CHANGED since; re-briefed below');
        expect(text).toContain('other-reviewer — verdict REJECTED: not submitted through pnpm wp-write-review; re-briefed below');
    });

    it('tells a Codex coordinator to spawn with NO forked turns and hand over only the instructions files', () => {
        const text = report.render(withOneOwedReviewer());
        expect(text).toContain('Codex (no agent types): spawn a generic subagent with NO forked turns');
        expect(text).toContain('hand it ONLY the instructions files below');
    });

    it('never lets the coordinator submit on a reviewer\'s behalf', () => {
        expect(report.render(withOneOwedReviewer())).toContain('pnpm wp-write-review');
        expect(report.render(withOneOwedReviewer())).toContain('refuses the coordinating agent');
    });
});

/**
 * ══ turnOffAllReviewers — the ONE output that must never be quiet ═══════════════════════════════════
 *
 * With the kill switch on, this stage prints the only local warning that an UNREVIEWED PR is about to be
 * posted. Two failure modes are pinned here, and they pull in opposite directions:
 *
 *   • too quiet — a suppressed run renders as the ordinary "nothing matched this diff" all-clear, which
 *     is the exact sentence a docs-only typo fix gets, and the suppression becomes invisible;
 *   • too loud in the wrong way — a spawn block for reviewers that were never briefed, i.e. an
 *     instruction naming an instructions file that does not exist. An agent obeys it and loops.
 */
describe('turnOffAllReviewers — the suppression is stated, and nothing is offered to spawn', () => {
    const suppressedInput = (): ReviewReportInput => {
        const input = inputWith(3, 0); // applicable is 0 BY DECREE — the scanner emptied it
        input.reviewersSuppressed = true;
        input.suppressed = [
            new RequiredChecklist('db-migration-reviewer', POLICY, '', ['db/1.sql'], ['**/*.sql'], true),
            new RequiredChecklist('frontend-reviewer', POLICY, '', ['a.css'], ['**/*.css'], false),
        ];
        return input;
    };

    const suppressed = (): string => report.render(suppressedInput());

    it('says ALL reviewers were suppressed, in the heading and in the body', () => {
        const text = suppressed();
        expect(text).toContain('ALL REVIEWERS SUPPRESSED');
        expect(text).toContain('ALL REVIEWER SUBAGENTS ARE SWITCHED OFF');
    });

    it('names the FLAG and the FILE it came from — the only actionable thing here', () => {
        const text = suppressed();
        expect(text).toContain('turnOffAllReviewers');
        expect(text).toContain('~/.webpieces/config.json');
    });

    it('lists every suppressed checklist and marks the REQUIRED ones as suppressed anyway', () => {
        const text = suppressed();
        expect(text).toContain('db-migration-reviewer');
        expect(text).toContain('frontend-reviewer');
        expect(text).toContain('1 of them REQUIRED');
        expect(text).toContain('(REQUIRED — suppressed anyway)');
    });

    // THE failure this must not have: the zero-applicable notice would say nothing matched, when in fact
    // two checklists matched and both were killed.
    it('does NOT print the ordinary "no checklist applies" notice', () => {
        expect(suppressed()).not.toContain('Every checklist that applies is already reviewed');
    });

    it('prints NO spawn block — there is no briefing and no instructions file to point at', () => {
        const text = suppressed();
        expect(text).not.toContain('subagent_type:');
        expect(text).not.toContain('REQUIRED reviewer subagent(s)');
    });

    // The stage's own contract, unchanged under suppression: write summary.json, THEN finish, and finish
    // named exactly once.
    it('still sends the agent to summary.json first and names wp-finish-upsert-pr exactly once', () => {
        const text = suppressed();
        expect(countOf(text, 'wp-finish-upsert-pr')).toBe(1);
        expect(text.indexOf(REVIEW_PATH)).toBeLessThan(text.indexOf('pnpm wp-finish-upsert-pr'));
    });

    // OFF is byte-for-byte today's output — the flag adds nothing to a machine that never set it.
    it('changes NOTHING when the flag is off', () => {
        expect(report.render(inputWith(3, 0))).toBe(nothingMatched());
        expect(report.render(withOneOwedReviewer())).not.toContain('SUPPRESSED');
    });
});

describe('reviewerAgents zero — project-level review opt-out reporting', () => {
    it('names the project config, requires no reviewer or verdict, and preserves the finish flow', () => {
        const input = inputWith(1, 0);
        input.reviewer = new ReviewerAgentPolicy('webpieces-reviewer', 0);
        input.reviewersSuppressed = true;
        input.suppressed = [new RequiredChecklist('required-review', input.reviewer, '', ['a.ts'], ['**'], true)];

        const text = report.render(input);

        expect(text).toContain('DISABLED FOR THIS PROJECT');
        expect(text).toContain('commands.pr-gate.reviewerAgents: 0');
        expect(text).toContain('build and PR gates remain active');
        expect(text).not.toContain('turnOffAllReviewers');
        expect(text).not.toContain('subagent_type:');
        expect(text).not.toContain('must write:');
        expect(countOf(text, 'wp-finish-upsert-pr')).toBe(1);
    });
});
