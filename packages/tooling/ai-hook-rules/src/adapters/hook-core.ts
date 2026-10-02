import { AgentPayloadParser, AgentAdapters, AgentHookEvent, HookMode, HookOutcome, denyJson } from '@webpieces/hook-runtime';
import { InformAiError } from '@webpieces/tooling-common';
import { toError } from '@webpieces/tooling-common/to-error';
import { RuleFailError, renderRuleFailForAi } from '@webpieces/rules-config';
import { run } from '../core/runner';

// webpieces-disable no-function-outside-class -- callable source pipeline consumed by the injected HookApp evaluator
export function runPipeline(raw: string, mode: HookMode): HookOutcome {
    let event: AgentHookEvent | null = null;
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const payload = new AgentPayloadParser().parse(raw);
        if (!payload) return new HookOutcome('', 0);
        const adapters = new AgentAdapters();
        event = adapters.envelope(payload);
        const cwd = payload.cwd ?? process.cwd();
        event = adapters.toEvent(payload, cwd);
        if (mode === 'guards' || event.kind === 'Bash' || event.kind === 'Read') return new HookOutcome('', 0);
        for (const file of event.files) {
            const result = run(file.toolKind, file.input, cwd, 'rules');
            if (result) return new HookOutcome(denyJson(event, result.report) + '\n', 0);
        }
        return new HookOutcome('', 0);
    } catch (err: unknown) {
        const error = toError(err);
        const reason = error instanceof RuleFailError ? renderRuleFailForAi(error)
            : error instanceof InformAiError ? error.message
            : `[ai-hooks] hook crashed unexpectedly — failing closed: ${error.message}`;
        return new HookOutcome(denyJson(event, reason) + '\n', 0);
    }
}
