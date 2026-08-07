import { spawnSync } from 'child_process';
import * as path from 'path';
import {
    prDirFor, reviewJsonPath, RequiredChecklist, PrGateConfig, ReviewJsonService,
    SubagentProvenanceService, PROVENANCE_OK, PROVENANCE_MISSING, PROVENANCE_SKIPPED,
    ProvenanceResult, ReviewerEvidence, EvidenceRequest,
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
        const errors: string[] = [];
        const report = new ProvenanceReport(true, []); // no reviewers to verify ⇒ vacuously verified
        const subagents = required.map((r: RequiredChecklist): string => r.subagent.trim()).filter((s: string): boolean => s !== '');
        // verifyDistinct short-circuits to OK on an empty set, so this runs unconditionally: a repo with no
        // checklists still gets a provenance record naming the session and the main agent's own transcript.
        const result = this.provenance.verifyDistinct(subagents, branch);
        report.verified = result.status === PROVENANCE_OK;
        if (result.status === PROVENANCE_MISSING) {
            errors.push(result.detail);
        } else if (result.status === PROVENANCE_SKIPPED) {
            process.stderr.write(`⚠️  ${result.detail}\n`);
        }
        report.evidence = this.gatherEvidence(repoRoot, required, result, branch);
        errors.push(...this.evidenceErrors(report.evidence, config));
        // BEFORE the throw below, deliberately. A refused round is the one most worth auditing, and a record
        // that only ever appeared on success could not answer what the reviewers did the time it was refused.
        this.writeProvenanceRecord(repoRoot, required, result, report.evidence);
        if (errors.length > 0) {
            throw new InformAiError(
                `${errors.length} checklist(s) require an independent reviewer subagent that did not run — fix, then re-run pnpm wp-finish-upsert-pr:\n\n` +
                errors.map((e: string): string => `  • ${e}`).join('\n') +
                `\n\nSpawn the named reviewer subagent to review the checklist on THIS branch, then re-run.`,
            );
        }
        return report;
    }

    /**
     * What each credited reviewer actually read. Purely observational here — {@link evidenceErrors} decides
     * whether any of it blocks, and by default none of it does.
     */
    // eslint-disable-next-line @typescript-eslint/max-params
    private gatherEvidence(repoRoot: string, required: readonly RequiredChecklist[], result: ProvenanceResult, branch: string): ReviewerEvidence[] {
        const docPaths: Record<string, string> = {};
        for (const req of required) {
            if (req.subagent.trim() !== '') docPaths[req.subagent] = req.doc.trim() === '' ? '' : path.resolve(repoRoot, req.doc);
        }
        const diffDir = path.join(prDirFor(repoRoot, this.aiBranchName.getFeatureName()), 'diff');
        return this.provenance.evidenceFor(new EvidenceRequest(branch, result.agentIds, diffDir, docPaths));
    }

    /**
     * Write this round's audit record: `.webpieces/pr-review/<branch>/provenance.json`, linking each verdict
     * to the transcript of the subagent that produced it.
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
     * WARN (default) or REFUSE (opt-in) on a reviewer that wrote a verdict without opening the diff.
     *
     * Default-warn because the signal is derived from undocumented Claude Code transcript internals: if the
     * format shifts, a blocking check wedges every PR in every consumer repo with no self-service recovery.
     * `requireDiffEvidence` lets a repo that has watched the warning promote it deliberately.
     */
    private evidenceErrors(evidence: readonly ReviewerEvidence[], config: PrGateConfig): string[] {
        const blind = evidence.filter((e: ReviewerEvidence): boolean => !e.readDiff);
        if (blind.length === 0) return [];
        const names = blind.map((e: ReviewerEvidence): string => e.agentType).join(', ');
        if (!config.requireDiffEvidence) {
            process.stderr.write(
                `\n⚠️  ${blind.length} reviewer(s) wrote a verdict with no record of opening the extracted diff: ${names}\n` +
                '   Published on the PR as a note. Not blocking — set pr-gate.requireDiffEvidence:true to make it one.\n');
            return [];
        }
        return [`these reviewers wrote a verdict without opening the diff (pr-gate.requireDiffEvidence is on): ${names}`];
    }
}
