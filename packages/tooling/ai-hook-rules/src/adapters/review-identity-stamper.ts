import { ReviewIdentityStamp, ReviewIdentityStampService, reviewIdentityStamps } from '@webpieces/rules-config';

import { AgentHookEvent } from '../core/agent-event';

/**
 * Tells `pnpm wp-write-review` WHO invoked it (issue #863).
 *
 * The bin runs inside the Bash call, and a Bash child sees only its environment — which in neither harness
 * distinguishes a reviewer subagent from its coordinator (see ReviewIdentityStamp for the detail). This
 * hook, by contrast, is handed the harness's own `agent_id` for the very call that is about to run the bin.
 * So for every checklist a command submits, it writes one stamp the bin consumes a moment later. The bin
 * then REFUSES a stamp that names the coordinating agent — closing the forgery path a Codex coordinator
 * took on two merged PRs — and records the subagent's identity in the verdict's provenance.
 *
 * Called ONLY for a Bash call the guards have already ALLOWED: a denied command never runs the bin, and a
 * stamp it left behind would be an identity waiting to be borrowed.
 */
export class ReviewIdentityStamper {
    constructor(private readonly stamps: ReviewIdentityStampService = reviewIdentityStamps) {}

    stamp(event: AgentHookEvent, command: string, cwd: string): void {
        const checklists = this.stamps.invokedChecklists(command);
        if (checklists.length === 0) return;
        const now = new Date().toISOString();
        for (const checklistId of checklists) {
            this.stamps.write(cwd, new ReviewIdentityStamp(
                checklistId, event.aiType, event.sessionId, event.agentId, event.agentType, cwd, now));
        }
    }
}
