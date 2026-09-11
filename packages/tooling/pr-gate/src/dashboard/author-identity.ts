import { AI_TYPES, AI_TYPE_UNKNOWN, AiType } from '@webpieces/ai-hook-rules';
import { injectable, bindingScopeValues } from 'inversify';

/** The coding harness observed by the gate, plus the model the author reported in review.json. */
export class AuthorIdentity {
    harness: AiType | typeof AI_TYPE_UNKNOWN;
    model: string;

    constructor(harness: AiType | typeof AI_TYPE_UNKNOWN, model: string) {
        this.harness = harness;
        this.model = model;
    }
}

/**
 * Resolves the authoring harness from session identifiers supplied by the harness itself.
 *
 * This deliberately does not trust review.json's `agent` field: that file is AI-authored, while the
 * session variables are supplied by Claude Code / Codex before the model runs. Both-or-neither is
 * `unknown`; silently picking one in an ambiguous process would turn telemetry into a false claim.
 */
@injectable(bindingScopeValues.Singleton)
export class AuthorIdentityResolver {
    resolve(selfReportedModel: string): AuthorIdentity {
        const claude = this.present('CLAUDE_CODE_SESSION_ID');
        const codex = this.present('CODEX_SESSION_ID') || this.present('CODEX_THREAD_ID');
        let harness: AiType | typeof AI_TYPE_UNKNOWN = AI_TYPE_UNKNOWN;
        if (claude !== codex) harness = claude ? 'claude-code' : 'codex';
        // Keep this tied to ai-hook-rules' canonical vocabulary rather than growing a second spelling.
        if (harness !== AI_TYPE_UNKNOWN && !AI_TYPES.includes(harness)) harness = AI_TYPE_UNKNOWN;
        const model = selfReportedModel.trim() === '' ? 'unknown' : selfReportedModel.trim();
        return new AuthorIdentity(harness, model);
    }

    private present(name: string): boolean {
        return (process.env[name] ?? '').trim() !== '';
    }
}
