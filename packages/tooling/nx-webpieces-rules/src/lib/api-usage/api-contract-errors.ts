/**
 * The ways `buildApiContracts` refuses to emit a green, wrong api contract table.
 *
 * They share one rule: an entry that is PRESENT but incomplete is worse than an absent one.
 * Every other entry in the table is complete, so a consumer has no reason to suspect the one that
 * lost a field — it just computes a confidently wrong URL, or draws a service with no queues.
 *
 * Each aggregates EVERY offender into one message rather than throwing on the first: an author who
 * moved a constants module broke five decorators at once and wants all five named in one run.
 *
 * Split out of api-scanner.ts, which owns the scan itself and is at its file-size limit.
 */

import {
    EmptiedApiContract,
    UndeclaredEndpointOperation,
    UndeclaredExternalCaller,
    UnresolvedApiCall,
    UnresolvedEndpointPath,
} from './api-relations';
import { RootUnionApiType, RootUnionFindings, ROOT_UNION_RULE } from './root-union-scan';
import {
    ApiContractDefect,
    ApiRuleFindings,
    McpExclusion,
    MCP_RULE,
    OPENAPI_RULE,
} from './api-doc-rules';

/**
 * The endpoints declared PERMANENTLY outside MCP, with their reasons — restated on EVERY run of
 * `api-rules-for-mcp`, green or red (#1014).
 *
 * Not a warning and not a finding. #1014 asked whether adding an `@InvalidEndpointForMcp` should
 * warn, and the answer is that a one-off warning is read by the one person who already knows the
 * decision. A list restated on every run is read by whoever comes next, which is who the reason was
 * written for. Printed by the caller, exactly like `describeUnresolvedApiCalls`.
 */
// webpieces-disable no-function-outside-class -- pure formatter, mirrors describeUnresolvedApiCalls
export function describeMcpExclusions(exclusions: readonly McpExclusion[]): string {
    const lines = [
        `ℹ️  ${exclusions.length} endpoint(s) are PERMANENTLY outside MCP (@InvalidEndpointForMcp):`,
    ];
    for (const one of exclusions) {
        lines.push(`     • ${one.api}.${one.method} at ${one.at}`);
        lines.push(`       ${one.reason === '' ? '<reason could not be read>' : one.reason}`);
    }
    lines.push(
        `   These are DECLARATIONS, not suppressions: each says the endpoint can never be a tool and`,
        `   why. They are restated every run rather than announced once, so the reasons stay readable`,
        `   by whoever comes next. \`grep -rn InvalidEndpointForMcp\` is the same list from a shell.`,
    );
    return lines.join('\n');
}

/** The rule's message with its PERMANENT-exclusion list appended, when there is one. */
// webpieces-disable no-function-outside-class -- pure formatter beside the error that uses it
function appendExclusions(message: string, exclusions: readonly McpExclusion[]): string {
    if (exclusions.length === 0) return message;
    return `${message}\n\n${describeMcpExclusions(exclusions)}`;
}

/**
 * One defect per line, with its cure INDENTED under it rather than collected into a footer.
 *
 * Every other error in this file prints one shared cure because its offenders share one root cause —
 * an unreadable constant, a missing `calledBy`. These two do not: an open enum, an `unknown` value
 * and a `void` RPC are three different edits, and a footer would make the reader work out which of
 * the three applies to which line.
 */
// webpieces-disable no-function-outside-class -- pure formatter, mirrors rootUnionLines
function apiDefectLines(found: readonly ApiContractDefect[]): string {
    return found
        .map((one: ApiContractDefect) => {
            const exposure = one.isExternal() ? ' [PARTNER-FACING]' : '';
            return (
                `     • ${one.where()}${exposure} — ${one.what}\n` +
                `       at ${one.at}\n` +
                `       cure: ${one.cure}`
            );
        })
        .join('\n');
}

/** The two halves every api-doc rule prints, so both refusals say the reasonless part identically. */
// webpieces-disable no-function-outside-class -- pure formatter shared by the two errors below
function apiRuleMessage(
    rule: string,
    headline: string,
    findings: ApiRuleFindings,
    why: string,
): string {
    const parts: string[] = [];
    if (findings.violations.length > 0) {
        parts.push(
            `${findings.violations.length} ${headline}:\n` +
                apiDefectLines(findings.violations) +
                `\n${why}\n` +
                `   This runs on EVERY @ApiPath contract, with or without @ApiType: @ApiType is a\n` +
                `   PUBLISHING decision added later, so a shape that is not expressible must fail on the\n` +
                `   first line rather than on the day somebody annotates it — by which time the type is\n` +
                `   in partners' generated clients and cannot be changed.\n` +
                `   Last resort, per site: // webpieces-disable ${rule} -- <reason>`,
        );
    }
    if (findings.reasonlessDisables.length > 0) {
        parts.push(
            `${findings.reasonlessDisables.length} disable(s) of ${rule} give NO reason:\n` +
                apiDefectLines(findings.reasonlessDisables) +
                `\n   The reason is MANDATORY — a reasonless disable is itself a violation. Write it as\n` +
                `   // webpieces-disable ${rule} -- <why this contract is published like this>\n` +
                `   The hatch is per-site and argued on purpose: the next reader needs the argument,\n` +
                `   not just the suppression.`,
        );
    }
    return parts.join('\n\n');
}

/**
 * `api-rules-for-openapi`: a contract that cannot produce an OpenAPI document.
 *
 * Fatal because the failure it prevents is DOCUMENT-WIDE and arrives late. One field with no shape
 * fails the whole document, so no partner can generate a client for ANY operation of that API — six
 * of 98 endpoints in a measured upstream repo, from exactly two root causes, and five of those six
 * were one field. The author who wrote that field had no way to know, because nothing looked at the
 * contract until somebody added `@ApiType` months later.
 *
 * Its verdict is the GENERATOR'S: the scan drives `ApiDocExtractor` rather than restating what is
 * expressible, so a contract that passes this is one where adding `@ApiType` then generates.
 */
export class ApiRulesForOpenApiError extends Error {
    constructor(public readonly findings: ApiRuleFindings) {
        super(
            apiRuleMessage(
                OPENAPI_RULE,
                '@ApiPath contract defect(s) would block the OpenAPI document',
                findings,
                `   An OpenAPI failure is DOCUMENT-WIDE: one field with no shape blocks client generation\n` +
                    `   for every operation of that API, not just the one that declares it.`,
            ),
        );
        this.name = 'ApiRulesForOpenApiError';
    }
}

/**
 * `api-rules-for-mcp`: a `@WpMcpTool` that could not be served.
 *
 * Every one of these is something `McpToolRegistry` refuses to BOOT on — a tool it cannot find a
 * schema for is a tool whose schema nobody checked — so the choice is only WHERE it is discovered.
 * Here it names the method; at boot it names a process that will not start, in an environment where
 * nobody is editing the contract.
 *
 * Separate from the OpenAPI error because the blast radii are different: this blocks ONE tool, where
 * an OpenAPI defect blocks a whole document. A team publishing a partner API and no tools runs the
 * first rule and not this one, which is only possible if they are two rules.
 */
export class ApiRulesForMcpError extends Error {
    constructor(
        public readonly findings: ApiRuleFindings,
        /**
         * The `@InvalidEndpointForMcp` endpoints, appended to the message.
         *
         * A red run is exactly when somebody is looking at this output, so it is also when the
         * PERMANENT exclusions are most worth restating: the next question after "why is this tool
         * blocked" is "which endpoints did we already decide can never be tools, and why".
         */
        public readonly exclusions: readonly McpExclusion[] = [],
    ) {
        super(
            appendExclusions(
            apiRuleMessage(
                MCP_RULE,
                '@WpMcpTool declaration(s) could not be served as MCP tools',
                findings,
                `   Each of these makes McpToolRegistry REFUSE TO BOOT: a registered tool the build never\n` +
                    `   published is a tool whose schema nobody checked. Caught here, it names the method;\n` +
                    `   caught at boot, it names a process that will not start.`,
            ),
                exclusions,
            ),
        );
        this.name = 'ApiRulesForMcpError';
    }
}

/**
 * Loud, actionable report for contracts the scan could not map to source. Callers print this
 * instead of emitting a green graph that is quietly missing relations. Not fatal: a contract
 * from a genuinely EXTERNAL (published, non-workspace) api-lib legitimately has no source here.
 */
// webpieces-disable no-function-outside-class -- pure formatter, mirrors describeUnclassifiedApiDep
export function describeUnresolvedApiCalls(calls: UnresolvedApiCall[]): string {
    const lines = [
        `⚠️  ${calls.length} API contract(s) resolved to a declaration file with no matching workspace source.`,
        `   Decorators (@ApiPath) are ERASED in .d.ts output, so these relations are MISSING from the graph:`,
    ];
    for (const call of calls) {
        lines.push(
            `     • ${call.api} at ${call.at} (${call.project}) → resolved to ${call.declaredIn}`,
        );
    }
    lines.push(
        `   If the api-lib IS in this workspace, add a tsconfig.base.json 'paths' entry mapping it to its`,
        `   src/index.ts, or confirm its project root is registered. If it is a published external package,`,
        `   this relation cannot be derived and the graph edge will not appear.`,
    );
    return lines.join('\n');
}

/** One line per offender, in the shape every error in this file uses. */
// webpieces-disable no-function-outside-class -- pure formatter shared by the one error below
function rootUnionLines(found: readonly RootUnionApiType[]): string {
    return found
        .map(
            (one: RootUnionApiType) =>
                `     • ${one.api}.${one.method} — ${one.side} type '${one.typeName}' at ${one.at}`,
        )
        .join('\n');
}

/**
 * `no-root-union-api-type`: a request or response type that IS a union, on ANY `@ApiPath` contract.
 *
 * Fatal, and fatal EARLY, because the failure it prevents is discovered by somebody else at runtime
 * and does not look like this contract's fault: a top-level `oneOf` is rejected by both the OpenAI
 * and the Anthropic function-calling APIs, a server sends its whole tool list on every request, and
 * so ONE such tool makes EVERY request 400. The user's report is "all the other tools broke".
 *
 * The second list is reasonless disables. A disable for this rule must carry an argument somebody
 * wrote down: the escape hatch is deliberately per-site and never a blanket switch, because the
 * blast radius is a whole session rather than one call.
 */
export class RootUnionApiTypeError extends Error {
    constructor(public readonly findings: RootUnionFindings) {
        super(RootUnionApiTypeError.render(findings));
        this.name = 'RootUnionApiTypeError';
    }

    // webpieces-disable no-function-outside-class, max-lines-new-methods -- private static renderer of this class, and splitting one message hides what a reader actually sees
    private static render(findings: RootUnionFindings): string {
        const parts: string[] = [];
        if (findings.violations.length > 0) {
            parts.push(
                `${findings.violations.length} @ApiPath method(s) declare a request or response type that IS a union:\n` +
                    rootUnionLines(findings.violations) +
                    `\n   A union at the TOP LEVEL of a tool's parameter schema is rejected by BOTH the OpenAI and\n` +
                    `   the Anthropic function-calling APIs. A server sends its WHOLE tool list on every request, so\n` +
                    `   ONE of these makes EVERY request 400 and the entire client session unusable — not just that\n` +
                    `   tool. Nested composition, INSIDE a property, is fine and publishes as oneOf.\n` +
                    `   Fix it by wrapping the union in a property of an object:\n` +
                    `     export interface MoveWindowRequest { window: ScheduledWindow | AsapWindow }\n` +
                    `   This runs on EVERY @ApiPath contract, with or without @ApiType: @ApiType is a publishing\n` +
                    `   decision added later, so a shape that is not expressible must fail on the first line rather\n` +
                    `   than on the day somebody annotates it.\n` +
                    `   Last resort, per site: // webpieces-disable ${ROOT_UNION_RULE} -- <reason>`,
            );
        }
        if (findings.reasonlessDisables.length > 0) {
            parts.push(
                `${findings.reasonlessDisables.length} disable(s) of ${ROOT_UNION_RULE} give NO reason:\n` +
                    rootUnionLines(findings.reasonlessDisables) +
                    `\n   The reason is MANDATORY — a reasonless disable is itself a violation. Write it as\n` +
                    `   // webpieces-disable ${ROOT_UNION_RULE} -- <why this root union is deliberate>\n` +
                    `   The hatch is per-site and argued on purpose: this defect costs a whole client session, so\n` +
                    `   the next reader needs the argument, not just the suppression.`,
            );
        }
        return parts.join('\n\n');
    }
}

/** Endpoints missing the operation declaration that drives retry safety and MCP annotations. */
export class UndeclaredEndpointOperationError extends Error {
    constructor(public readonly endpoints: readonly UndeclaredEndpointOperation[]) {
        super(
            `${endpoints.length} @Endpoint(s) do not declare a readable operation:\n` +
                endpoints
                    .map(
                        (e: UndeclaredEndpointOperation) =>
                            `     • ${e.api}.${e.method} — ${e.argument} at ${e.at}`,
                    )
                    .join('\n') +
                `\n   operation is REQUIRED because it controls retry safety and generated MCP hints.\n` +
                `   Pass exactly one of READ, WRITE_IDEMPOTENT, or WRITE as the third argument.\n` +
                `   Do not infer operation semantics from the HTTP verb.`,
        );
        this.name = 'UndeclaredEndpointOperationError';
    }
}

/**
 * A routed contract whose `@ApiPath` argument the scan could not read. Fatal on purpose: shipping the
 * entry without its basePath is what made `/whatsapp/test` render as `/test` in a downstream runbook.
 */
export class MissingBasePathError extends Error {
    constructor(public readonly contracts: readonly string[]) {
        super(
            `${contracts.length} API contract(s) have @Endpoint methods but no readable @ApiPath basePath:\n` +
                contracts.map((c: string) => `     • ${c}`).join('\n') +
                `\n   basePath is REQUIRED in every api contract — an entry without it makes every consumer\n` +
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
                `\n   path is REQUIRED in every api contract — every consumer builds its request URL as\n` +
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
                `     @Endpoint(POST, '/hook', WRITE, EXTERNAL, { calledBy: 'twilio' })\n` +
                `   Add callerKind for anything that is not a vendor SaaS — database | cache | queue |\n` +
                `   storage | saas | system — e.g. a GCP Pub/Sub push subscription:\n` +
                `     @Endpoint(POST, '/push', WRITE, EXTERNAL, { calledBy: 'pubsub-push', callerKind: 'system' })\n` +
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
                `\n   A contract with zero usable methods is DROPPED from the api contracts, so the class,\n` +
                `   its queues and its triggers disappear from the architecture graph with no error.\n` +
                `   Every @Endpoint argument must be readable: the path as a string literal or a\n` +
                `   SAME-module const, the kind as 'rpc' | 'cloudtasks' | 'cron' | 'external', and\n` +
                `   the options must declare operation. Fix the arguments above, or remove the decorators if the\n` +
                `   class is genuinely not routed.`,
        );
        this.name = 'EmptiedApiContractError';
    }
}
