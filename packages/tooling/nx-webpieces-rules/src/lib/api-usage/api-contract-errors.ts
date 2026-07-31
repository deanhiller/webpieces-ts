/**
 * The three ways `buildApiContracts` refuses to emit a green, wrong `apiContracts` table.
 *
 * All three share one rule: an entry that is PRESENT but incomplete is worse than an absent one.
 * Every other entry in the table is complete, so a consumer has no reason to suspect the one that
 * lost a field — it just computes a confidently wrong URL, or draws a service with no queues.
 *
 * Each aggregates EVERY offender into one message rather than throwing on the first: an author who
 * moved a constants module broke five decorators at once and wants all five named in one run.
 *
 * Split out of api-scanner.ts, which owns the scan itself and is at its file-size limit.
 */

import { EmptiedApiContract, UndeclaredExternalCaller, UnresolvedEndpointPath } from './api-relations';

/**
 * A routed contract whose `@ApiPath` argument the scan could not read. Fatal on purpose: shipping the
 * entry without its basePath is what made `/whatsapp/test` render as `/test` in a downstream runbook.
 */
export class MissingBasePathError extends Error {
    constructor(public readonly contracts: readonly string[]) {
        super(
            `${contracts.length} API contract(s) have @Endpoint methods but no readable @ApiPath basePath:\n` +
                contracts.map((c: string) => `     • ${c}`).join('\n') +
                `\n   basePath is REQUIRED in apiContracts — an entry without it makes every consumer\n` +
                `   compute basePath + path as just path, silently. Inline the @ApiPath string literal,\n` +
                `   or move the constant into the same module as the contract class.`,
        );
        this.name = 'MissingBasePathError';
    }
}

/**
 * `@Endpoint` paths the scan could not read. Fatal for the same reason MissingBasePathError is: the
 * two arguments are the two halves of ONE url. An http client builds its request as
 * `basePath + path`, so a contract shipped without a method's path is missing routing information,
 * and the consumer computes a confidently wrong URL. Skipping the method instead was worse still —
 * a class whose every path was an unreadable constant lost every method and vanished from the graph.
 */
export class UnresolvedEndpointPathError extends Error {
    constructor(public readonly paths: readonly UnresolvedEndpointPath[]) {
        super(
            `${paths.length} @Endpoint path(s) could not be read as a string:\n` +
                paths
                    .map(
                        (p: UnresolvedEndpointPath) =>
                            `     • ${p.api}.${p.method} — @Endpoint(${p.argument}, ...) at ${p.at}`,
                    )
                    .join('\n') +
                `\n   path is REQUIRED in apiContracts — every consumer builds its request URL as\n` +
                `   basePath + path, so an unreadable path is MISSING ROUTING, not cosmetic metadata,\n` +
                `   and a class whose every path is unreadable drops out of the graph entirely.\n` +
                `   Inline the @Endpoint string literal, or move the constant into the SAME module as\n` +
                `   the contract class — a same-module const IS resolved, one imported from another\n` +
                `   module is NOT (this scan is parser-only by design: module resolution can land on a\n` +
                `   decorator-erased .d.ts).`,
        );
        this.name = 'UnresolvedEndpointPathError';
    }
}

/**
 * `external` endpoints whose CALLER the scan could not read. Fatal, like the two above, because the
 * alternative is a diagram that lies by omission: the inbound box exists solely to name the system
 * calling us from outside, and with nothing to name it falls back to restating our own contract
 * name — which the reader already sees on the service box the arrow points at.
 *
 * `@Endpoint`'s TS overloads make `calledBy` a compile error to omit, so a scan reaching here saw a
 * JS caller, an `as any`, a cross-module constant this parser-only pass cannot fold, or a
 * `callerKind` that is not one of the declared kinds.
 */
export class UndeclaredExternalCallerError extends Error {
    constructor(public readonly callers: readonly UndeclaredExternalCaller[]) {
        super(
            `${callers.length} 'external' @Endpoint(s) do not declare WHO calls them:\n` +
                callers
                    .map(
                        (c: UndeclaredExternalCaller) =>
                            `     • ${c.api}.${c.method} — ${c.argument} at ${c.at}`,
                    )
                    .join('\n') +
                `\n   An 'external' endpoint is driven by a system OUTSIDE this repo, and the runtime\n` +
                `   architecture graph draws that system as an inbound box. Name it:\n` +
                `     @Endpoint('/hook', 'external', { calledBy: 'twilio' })\n` +
                `   Add callerKind for anything that is not a vendor SaaS — database | cache | queue |\n` +
                `   storage | saas | system — e.g. a GCP Pub/Sub push subscription:\n` +
                `     @Endpoint('/push', 'external', { calledBy: 'pubsub-push', callerKind: 'system' })\n` +
                `   Use a string LITERAL or a SAME-module const: this scan is parser-only by design.`,
        );
        this.name = 'UndeclaredExternalCallerError';
    }
}

/**
 * Contract classes that declared `@Endpoint` methods and kept none of them. Fatal because the
 * alternative is the silent drop the api scan exists to close: buildApiContracts legitimately skips
 * a zero-method class (a vendor seam has no routes), and a class gutted by unreadable decorator
 * arguments used the very same exit — which is how a service lost two real Cloud Tasks queues and an
 * inbound webhook without a single line of output.
 */
export class EmptiedApiContractError extends Error {
    constructor(public readonly contracts: readonly EmptiedApiContract[]) {
        super(
            `${contracts.length} API contract class(es) declare @Endpoint methods but kept NONE of them:\n` +
                contracts
                    .map(
                        (c: EmptiedApiContract) =>
                            `     • ${c.api} — ${c.declared} @Endpoint method(s) declared, 0 usable, at ${c.at}`,
                    )
                    .join('\n') +
                `\n   A contract with zero usable methods is DROPPED from apiContracts, so the class,\n` +
                `   its queues and its triggers disappear from the architecture graph with no error.\n` +
                `   Both @Endpoint arguments must be readable: the path as a string literal or a\n` +
                `   SAME-module const, and the kind as a literal 'rpc' | 'cloudtasks' | 'cron' |\n` +
                `   'external'. Fix the arguments above, or remove the @Endpoint decorators if the\n` +
                `   class is genuinely not routed.`,
        );
        this.name = 'EmptiedApiContractError';
    }
}
