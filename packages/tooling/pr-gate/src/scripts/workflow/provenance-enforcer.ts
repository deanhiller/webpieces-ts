import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
    prDirFor, reviewJsonPath, RequiredChecklist, PrGateConfig, ReviewJsonService,
    SubagentProvenanceService, PROVENANCE_OK, PROVENANCE_MISSING, PROVENANCE_SKIPPED,
    ProvenanceResult, ReviewerEvidence, ReviewerContext,
    ReviewProvenanceService, ProvenanceWriteRequest, ReviewerTranscript, ReviewerPaths, OfferedContext,
    ReviewerInstructionsService, InformAiError,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { AiBranchName } from './git-readAiBranchName';

/**
 * The provenance outcome: whether each reviewer was VERIFIED to have run (the integrity check, which
 * blocks) plus what each one actually read (the quality signal, which is published). Data-only.
 */
export class ProvenanceReport {
    verified: boolean;
    evidence: ReviewerEvidence[];

    constructor(verified: boolean, evidence: ReviewerEvidence[]) {
        this.verified = verified;
        this.evidence = evidence;
    }
}

/**
 * Proves each checklist verdict came from its OWN independently-run reviewer subagent, and records what
 * each one read.
 *
 * Split out of FinishUpsertPrCommand when that file crossed the 700-line cap, and it is the right seam
 * twice over: this is a self-contained integrity check with its own spec
 * (`finish-provenance-record.spec.ts`), and that spec previously had to reach through
 * `command as unknown as { enforceProvenance(...) }` to get at it. Now `enforce` is simply public.
 *
 * `@injectable(bindingScopeValues.Singleton)` so it is drawn in the DI design and injected by type.
 */
@injectable(bindingScopeValues.Singleton)
export class ProvenanceEnforcer {
    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        private readonly aiBranchName: AiBranchName,
        private readonly provenance: SubagentProvenanceService,
        private readonly provenanceRecord: ReviewProvenanceService,
        private readonly reviewerInstructions: ReviewerInstructionsService,
        private readonly reviewJsonService: ReviewJsonService,
    ) {}

    /**
     * Archive this round's provenance.json alongside the archived review.json, so an archived review keeps
     * the transcript links belonging to the round that produced it — a record overwritten by the NEXT
     * round audits nothing.
     *
     * Here rather than in the command because this class owns the record; the command only knows WHEN to
     * archive, not what the record is.
     */
    archiveRecord(prDir: string): void {
        this.provenanceRecord.archive(prDir);
    }

    // HEAD sha for the audit record. Failure-tolerant ('' rather than a throw): a missing sha degrades
    // the audit trail, and refusing a PR over it would be the wrong trade — see writeProvenanceRecord.
    private gitOut(args: string[]): string {
        const result = spawnSync('git', args, { encoding: 'utf8' });
        return result.status === 0 ? (result.stdout ?? '').trim() : '';
    }

    // Enforce that EACH matched checklist was reviewed by its OWN named subagent, as a DISTINCT run —
    // the coding agent may not self-certify, and one reviewer may not stand in for several. A verified set
    // passes silently; no session id warns but passes; any missing reviewer throws so the PR does not open.
    // eslint-disable-next-line @typescript-eslint/max-params
    enforce(required: readonly RequiredChecklist[], branch: string, repoRoot: string, config: PrGateConfig): ProvenanceReport {
        const report = new ProvenanceReport(true, []); // no reviewers to verify ⇒ vacuously verified
        const subagents = required.map((r: RequiredChecklist): string => r.subagent.trim()).filter((s: string): boolean => s !== '');
        const context = this.contextFor(repoRoot, required, branch);
        // verifyDistinct short-circuits to OK on an empty set, so this runs unconditionally: a repo with no
        // checklists still gets a provenance record naming the session and the main agent's own transcript.
        const result = this.provenance.verifyDistinct(subagents, context);
        report.verified = result.status === PROVENANCE_OK;
        if (result.status === PROVENANCE_SKIPPED) process.stderr.write(`⚠️  ${result.detail}\n`);
        report.evidence = this.provenance.evidenceFor(context, result.agentIds);
        const blind = this.blindReviewers(report.evidence, config);
        // BEFORE the throw below, deliberately. A refused round is the one most worth auditing, and a record
        // that only ever appeared on success could not answer what the reviewers did the time it was refused.
        this.writeProvenanceRecord(repoRoot, required, result, report.evidence);
        this.refuse(result, blind, context);
        return report;
    }

    /**
     * Refuse — with an instruction that matches WHICH failure this is.
     *
     * The count is the number of CHECKLISTS at fault, not the number of message paragraphs. It used to be
     * `errors.length`, which printed "1 checklist(s) require …" above a list of seven names.
     *
     * The split matters more than the count. A checklist with no verdict file needs a reviewer spawned. A
     * checklist WITH one needs the opposite: the reviewer already ran, the verdict is on disk, and only the
     * attribution failed — so telling an agent to "spawn each as its OWN subagent" makes it overwrite seven
     * verdicts with runs that are stamped identically and refused identically. That is a loop that destroys
     * evidence on every iteration, and it is what the previous single message guaranteed.
     *
     * The BLOCK decision is the STATUS, not the length of `missing`. Those agree today — but a
     * `PROVENANCE_MISSING` that arrived carrying no names would otherwise be a silent pass: reported
     * unverified and refused by nothing. Refusing on the status makes the unverified verdict block whatever
     * else is true, and `detail` carries the wording when there are no names to word it from.
     */
    private refuse(result: ProvenanceResult, blind: readonly string[], context: ReviewerContext): void {
        const missing = result.missing;
        const neverRan = missing.filter((t: string): boolean => !fs.existsSync(context.verdictPaths[t] ?? ''));
        const unattributed = missing.filter((t: string): boolean => fs.existsSync(context.verdictPaths[t] ?? ''));
        const paragraphs: string[] = [];
        if (result.status === PROVENANCE_MISSING && missing.length === 0) paragraphs.push(result.detail);
        if (neverRan.length > 0) {
            paragraphs.push(
                `these reviewer subagents did not run on this branch (spawn each as its OWN subagent — do not self-certify): ${neverRan.join(', ')}`);
        }
        if (unattributed.length > 0) paragraphs.push(this.unattributedMessage(unattributed, context));
        if (blind.length > 0) {
            paragraphs.push(`these reviewers wrote a verdict without opening the diff (pr-gate.requireDiffEvidence is on): ${blind.join(', ')}`);
        }
        if (paragraphs.length === 0) return;
        // The UNION, because one checklist can be both unattributed and blind, and counting the paragraphs
        // is what printed "1 checklist(s) require …" above a list of seven names. Floored at 1 so the
        // nameless-MISSING case above cannot announce "0 checklist(s) failed" and then refuse.
        const atFault = Math.max(new Set([...missing, ...blind]).size, 1);
        throw new InformAiError(
            `${atFault} checklist(s) failed the reviewer-provenance check — fix, then re-run pnpm wp-finish-upsert-pr:\n\n` +
            paragraphs.map((e: string): string => `  • ${e}`).join('\n\n'));
    }

    /**
     * The verdict exists but nothing can prove WHICH branch its reviewer looked at.
     *
     * Reachable when a session rooted in the PRIMARY CLONE spawns reviewers for a branch that lives in a
     * linked worktree: the harness stamps record 0 from the spawning session's cwd (the Agent tool has no
     * cwd parameter), so every respawn is stamped identically and re-spawning cannot change the outcome.
     * Saying so is the whole point of this message — the remedy is a session rooted in the worktree, or a
     * reviewer that names this branch's own files.
     */
    private unattributedMessage(unattributed: readonly string[], context: ReviewerContext): string {
        return `these reviewers WROTE a verdict for this branch that provenance cannot attribute to them: ${unattributed.join(', ')}\n` +
            `    Do NOT re-spawn them. A re-spawn overwrites the verdict file it already wrote and is stamped with the\n` +
            `    same cwd, so it is refused again — that loop destroys the verdicts and cannot change the outcome.\n` +
            `    A reviewer is attributed when it names this branch's own files: its verdict\n` +
            `    (${context.verdictPaths[unattributed[0]] ?? '<verdict path>'}) or the extracted diff (${context.diffDir}).\n` +
            `    If the reviewers ran before pnpm wp-review-upsert-pr materialized that diff, re-run this from a Claude\n` +
            `    Code session whose cwd IS the worktree holding ${context.branch} — that is the only cwd the harness will\n` +
            `    stamp on them.`;
    }

    /**
     * WHERE this branch's review materials live — the paths BOTH provenance passes compare against.
     *
     * One object for crediting and for evidence: they ask different questions of the same files, and
     * building the paths twice is how the two could drift apart.
     */
    private contextFor(repoRoot: string, required: readonly RequiredChecklist[], branch: string): ReviewerContext {
        const featureName = this.aiBranchName.getFeatureName();
        const docPaths: Record<string, string> = {};
        const verdictPaths: Record<string, string> = {};
        for (const req of required) {
            const type = req.subagent.trim();
            if (type === '') continue;
            docPaths[type] = req.doc.trim() === '' ? '' : path.resolve(repoRoot, req.doc);
            verdictPaths[type] = this.reviewJsonService.checklistResultPath(reviewJsonPath(repoRoot, featureName), req.id);
        }
        return new ReviewerContext(branch, path.join(prDirFor(repoRoot, featureName), 'diff'), docPaths, verdictPaths);
    }

    /**
     * Write this round's audit record: `.webpieces/pr-review/<featureSlug>/provenance.json`, linking each
     * verdict to the transcript of the subagent that produced it.
     *
     * `<featureSlug>`, not `<branch>`: the dir is named by `AiBranchName.getFeatureName()`, which
     * dash-sanitizes the branch. Calling it `<branch>` is what led a bug reporter to conclude the gate
     * must be comparing a dash-form name against a slash-form git branch — see
     * ProvenanceWriteRequest.featureSlug, whose field carried the same mislabel.
     *
     * A SEPARATE file rather than a field inside review.json / review-<id>.json, for two reasons. The
     * reviewer cannot supply this itself — a subagent's environment exposes the PARENT session id and no
     * agent id, so a self-reported transcript link would be invented — and keeping the AI-authored files
     * byte-untouched means nothing in the record can be mistaken for something a reviewer claimed about
     * itself. Every path here is derived by the tooling from the harness's own artifacts.
     *
     * Never fatal: an unwritable record is a lost audit trail, not a reason to refuse a PR.
     */
    // eslint-disable-next-line @typescript-eslint/max-params
    private writeProvenanceRecord(repoRoot: string, required: readonly RequiredChecklist[], result: ProvenanceResult, evidence: readonly ReviewerEvidence[]): void {
        const featureName = this.aiBranchName.getFeatureName();
        const prDir = prDirFor(repoRoot, featureName);
        const request = new ProvenanceWriteRequest(prDir, featureName, this.gitOut(['rev-parse', 'HEAD']), result.status);
        request.offered = new OfferedContext(
            path.join(prDir, 'diff'), this.reviewerInstructions.instructionsDirFor(repoRoot, featureName));
        request.reviewers = evidence.map((e: ReviewerEvidence): ReviewerTranscript =>
            new ReviewerTranscript(e, this.reviewerPathsFor(repoRoot, featureName, required, e.agentType)));
        const written = this.provenanceRecord.write(request);
        if (written !== '') process.stdout.write(`   transcript provenance → ${written}\n`);
    }

    // Where ONE reviewer's verdict, instructions and checklist doc live. Keyed by agentType, which IS the
    // checklist id: ChecklistDefinition sets `id = subagent`, so the two never diverge.
    // eslint-disable-next-line @typescript-eslint/max-params
    private reviewerPathsFor(repoRoot: string, featureName: string, required: readonly RequiredChecklist[], agentType: string): ReviewerPaths {
        const req = required.find((r: RequiredChecklist): boolean => r.subagent.trim() === agentType);
        const doc = req !== undefined && req.doc.trim() !== '' ? path.resolve(repoRoot, req.doc) : '';
        return new ReviewerPaths(
            this.reviewJsonService.checklistResultPath(reviewJsonPath(repoRoot, featureName), req?.id ?? agentType),
            this.reviewerInstructions.pathFor(repoRoot, featureName, agentType),
            doc,
        );
    }

    /**
     * The reviewers that wrote a verdict without opening the diff — WARNED about (default) or returned for
     * {@link refuse} to block on (opt-in).
     *
     * Default-warn because the signal is derived from undocumented Claude Code transcript internals: if the
     * format shifts, a blocking check wedges every PR in every consumer repo with no self-service recovery.
     * `requireDiffEvidence` lets a repo that has watched the warning promote it deliberately.
     *
     * Returns the agentTypes rather than a finished sentence so the caller can count CHECKLISTS at fault —
     * a name can appear in this list and in `missing`, and it must be one checklist in the total, not two.
     */
    private blindReviewers(evidence: readonly ReviewerEvidence[], config: PrGateConfig): string[] {
        const blind = evidence.filter((e: ReviewerEvidence): boolean => !e.readDiff);
        if (blind.length === 0) return [];
        const names = blind.map((e: ReviewerEvidence): string => e.agentType);
        if (config.requireDiffEvidence) return names;
        process.stderr.write(
            `\n⚠️  ${blind.length} reviewer(s) wrote a verdict with no record of opening the extracted diff: ${names.join(', ')}\n` +
            '   Published on the PR as a note. Not blocking — set pr-gate.requireDiffEvidence:true to make it one.\n');
        return [];
    }
}
