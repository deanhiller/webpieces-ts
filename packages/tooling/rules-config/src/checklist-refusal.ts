import { injectable, bindingScopeValues } from 'inversify';
import { CK_UNAUTHORIZED, ChecklistVerdict, RequiredChecklist, VERDICT_RED } from './review-json-data';

/**
 * THE renderer for "this reviewer said no" — one wording for every refusal, wherever it surfaces.
 *
 * It is its own class for the reason {@link ReviewerVerdictGate} is: this is the text an AI ACTS ON, so it
 * is the piece most worth asserting on directly, and `review-json.ts` was already at its file-size limit.
 * The behaviour is unchanged by the move — `ReviewJsonService.refusalError` delegates here, so there is
 * still exactly ONE implementation and no call site has two spellings to choose between.
 *
 * The text was previously inlined inside review.json validation, reachable only through that path, while
 * the command layer refused earlier with its own generic message. Two messages for one event is how the
 * useful one became unreachable.
 *
 * It always quotes the reviewer's own words verbatim: the finding is the whole point, and an error that
 * names a checklist without saying what it objected to gives the reader nothing to act on.
 *
 * `@injectable(bindingScopeValues.Singleton)` so it is injected by type and drawn in the DI design.
 */
@injectable(bindingScopeValues.Singleton)
export class ChecklistRefusalRenderer {
    /**
     * One refusal, in the terms its own verdict demands.
     *
     * `archivedPath` non-empty ⇒ the verdict has just been RETIRED (moved) there, which changes the message
     * in two ways: it says where the record went, so the move does not read as data loss, and it asks for a
     * FRESH verdict file rather than pointing at a path that no longer exists.
     */
    render(req: RequiredChecklist, verdict: ChecklistVerdict, archivedPath = ''): string {
        if (verdict.status === CK_UNAUTHORIZED) return this.unauthorizedOverride(req, verdict, archivedPath);
        const finding = `${verdict.detail.split('\n').join('\n      ')}\n`;
        const head = `Checklist "${req.id}" FAILED review (status:"${VERDICT_RED}"). The reviewer (${req.subagent}) wrote:\n      ` + finding;
        if (archivedPath === '') {
            return head +
                `      Fix it, then re-run. To ship it UNFIXED instead, a HUMAN must authorize it — see ` +
                `${this.authorizeHint(req.id)}`;
        }
        // Re-spawning is the LAST thing said, and only after the finding, because an instruction to spawn a
        // subagent is the one line an AI acts on first — see refusedChecklists for what that cost.
        return head +
            `      That verdict has been RETIRED to ${archivedPath} (audit only — it is not a live verdict).\n` +
            `      A FRESH ${this.checklistFileName(req.id)} is now required. Fix the finding first, then have the ` +
            `"${req.subagent}" subagent review again and write a new verdict.\n` +
            `      To ship it UNFIXED instead: ${this.authorizeHint(req.id)}`;
    }

    /**
     * The refusal for an override NOBODY AUTHORIZED — a reviewer went red and then wrote its own
     * ship-anyway justification, with no signed human approval on the branch behind it.
     *
     * Worded as a completely different event from a plain refusal, because it asks for a different action.
     * A refusal says FIX THE FINDING. This says: the decision to accept the finding is not yours to make, so
     * STOP and ask a person — and it names the command that person runs. Telling this reader to fix the code
     * would send them to re-do work somebody may already have decided to accept, and telling them to "get an
     * override" is what they already, wrongly, did.
     */
    private unauthorizedOverride(req: RequiredChecklist, verdict: ChecklistVerdict, archivedPath: string): string {
        const claimed = `${verdict.detail.split('\n').join('\n      ')}\n`;
        const retired = archivedPath === '' ? ''
            : `      That verdict has been RETIRED to ${archivedPath} (audit only — it is not a live verdict).\n`;
        return (
            `Checklist "${req.id}" is RED and carries an override that NO HUMAN AUTHORIZED. The override written ` +
            `into ${this.checklistFileName(req.id)} was:\n      ` + claimed + retired +
            `      An override is only honoured while a signed human approval for "${req.id}" verifies on this ` +
            `branch. Writing the field yourself is an agent authorizing itself, which is exactly what this gate ` +
            `stops — and no message, ticket comment or relayed quote counts either.\n` +
            `      ${this.authorizeHint(req.id)}`
        );
    }

    /**
     * The ONE sentence that names the human-authorization channel, so every refusal says it identically.
     *
     * Deliberately addressed to the AGENT about what to ASK FOR, not about what to run: `wp-authorize` reads
     * from `/dev/tty` and an agent has none, so an agent that tries it hangs or is denied. `wp-check-auth` is
     * the half an agent runs, and it is named second so there is something to do once the human is done.
     */
    private authorizeHint(checklistId: string): string {
        return (
            `ASK THE HUMAN to run, in their own terminal:  pnpm wp-authorize --checklist ${checklistId}\n` +
            `      (it prompts THEM, at a tty, for what they are approving and why — you cannot run it and must ` +
            `not try). Then verify it yourself with:  pnpm wp-check-auth --checklist ${checklistId}`
        );
    }

    /** The verdict file a checklist id maps to. Duplicated nowhere — ReviewJsonService asks this class. */
    checklistFileName(checklistId: string): string {
        return `review-${checklistId}.json`;
    }
}
