import { VERDICT_GREEN, VERDICT_RED, VERDICT_YELLOW } from './review-json-data';
import { WRITE_REVIEW_BIN } from './review-identity-stamp';

/**
 * Pure renderer for ONE reviewer's verdict schema and the command that submits it. Reached only through
 * ReviewJsonService.verdictSchemaFor / submitCommand — the single renderer every printed copy comes from.
 */
export class VerdictSchemaRenderer {
    /**
     * THE command that submits one checklist's verdict (issue #863). The only route: `wp-write-review`
     * validates the verdict and records WHO submitted it, and `wp-finish-upsert-pr` rejects a verdict file
     * that did not come through it — so every message that tells anyone how a verdict gets written names
     * this, and none of them names the file as something to write.
     */
    submitCommand(id: string): string {
        return `pnpm ${WRITE_REVIEW_BIN} --checklist ${id} <<'EOF' … EOF`;
    }

    render(id: string, indent: string): string {
        return [
            `${indent}{ "id": "${id}", "status": "${VERDICT_GREEN} | ${VERDICT_YELLOW} | ${VERDICT_RED}", ` +
            `"agent": "claude | codex | unknown", "model": "opus | sonnet | actual readable model name | unknown", ` +
            `"output": "what you checked / found" }`,
            `${indent}Identity fields are REQUIRED non-empty strings. Use your own harness and model, never the parent's.`,
            `${indent}Use the literal "unknown" when unavailable; never guess. These are self-reported, not provenance.`,
            `${indent}  ${VERDICT_GREEN}  → passes, nothing to flag`,
            `${indent}  ${VERDICT_YELLOW} → passes WITH CONCERNS; nothing is blocked and the concern is published on the PR`,
            `${indent}  ${VERDICT_RED}    → REFUSES the PR; your "output" is printed verbatim`,
            `${indent}Prefer "${VERDICT_YELLOW}" over red when the change is acceptable but worth a human's attention —`,
            `${indent}a red a human then authorizes reads as a deliberately-accepted defect, a yellow reads as a note.`,
            // The one sentence that stops a reviewer doing what a reviewer did once: telling the human to run
            // a command, on its own authority, to get past its own finding.
            `${indent}THERE IS NO "override" FIELD HERE, and you NEVER write one. A reviewer does not authorize`,
            `${indent}shipping past its own finding: if this needs a human's decision, SAY SO in "output" and STOP.`,
            `${indent}The coordinating agent is the one with the human, and records that decision in override-${id}.json.`,
            `${indent}SUBMIT it — the reviewer itself, never the coordinating agent — with the JSON on stdin:`,
            `${indent}  ${this.submitCommand(id)}`,
            `${indent}(or --file <path> naming a scratch file). A review-${id}.json written any other way is REJECTED.`,
        ].join('\n');
    }
}
