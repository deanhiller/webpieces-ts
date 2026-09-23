/**
 * The DATA and the SWITCHES of `api-rules-for-openapi` and `api-rules-for-mcp` (#1011).
 *
 * The scan itself is in `api-doc-rules-scan.ts`; this file holds what a caller reads back and the
 * per-rule config, so a unit test can construct either without touching a config file and so the
 * config is read exactly once per executor run.
 */

import * as fs from 'fs';
import { loadAndValidate, RULE_NAMES, WEBPIECES_DISABLE } from '@webpieces/rules-config';
import { RuleGate } from '../rule-gate';

/** As written in a disable comment and as a config key. */
export const OPENAPI_RULE = RULE_NAMES.API_RULES_FOR_OPENAPI;
export const MCP_RULE = RULE_NAMES.API_RULES_FOR_MCP;

/** The `@ApiType` value that means "a partner reads this document". */
export const EXTERNAL_CUSTOMER_API_TYPE = 'external-customer';

/**
 * `// webpieces-disable <rule>[, <rule2>] -- <reason>`, with the reason CAPTURED so a reasonless
 * disable can be told apart from an absent one. Identical to the spelling `root-union-scan` reads.
 */
const DISABLE_RE = new RegExp(
    `//\\s*${WEBPIECES_DISABLE}\\s+([\\w-]+(?:\\s*,\\s*[\\w-]+)*)(?:\\s*--\\s*(.*))?$`,
);

/** How far above a declaration a disable comment may sit before it is somebody else's comment. */
const DISABLE_LOOKBACK_LINES = 40;

/**
 * ONE defect on ONE contract.
 *
 * `exposure` is the contract's `@ApiType` list, and it is carried rather than derived because the
 * SAME defect is louder on a contract that reaches `external-customer`: an unshaped field on a
 * partner document costs a partner something, where the same field on a service-to-service contract
 * costs a colleague a question. The refusal sorts and labels on it.
 */
export class ApiContractDefect {
    constructor(
        /** The `@ApiPath` contract class. */
        public readonly api: string,
        /** The `@Endpoint` method, or `''` for a contract-level or DTO-level defect. */
        public readonly method: string,
        /** What is wrong, in one line, naming the declaration. */
        public readonly what: string,
        /** `path/to/File.ts:LINE`, workspace-relative. */
        public readonly at: string,
        /** What to do instead, in one sentence. */
        public readonly cure: string,
        /** The contract's `@ApiType` list — `svc-to-svc` when it declares none. */
        public readonly exposure: readonly string[],
    ) {}

    /** True when this contract feeds the PARTNER-facing document. */
    isExternal(): boolean {
        return this.exposure.includes(EXTERNAL_CUSTOMER_API_TYPE);
    }

    /** `Api.method` or `Api` — what a reader opens. */
    where(): string {
        return this.method === '' ? this.api : `${this.api}.${this.method}`;
    }
}

/** What ONE rule found: real defects, and disables of it that gave no reason. */
export class ApiRuleFindings {
    constructor(
        public readonly violations: readonly ApiContractDefect[],
        /**
         * Sites that named this rule in a disable and wrote no reason. A reasonless disable is
         * itself a violation: the point of the per-site hatch is the ARGUMENT, which is the only
         * part the next reader can weigh.
         */
        public readonly reasonlessDisables: readonly ApiContractDefect[],
    ) {}

    isEmpty(): boolean {
        return this.violations.length === 0 && this.reasonlessDisables.length === 0;
    }
}

/**
 * ONE endpoint declared PERMANENTLY outside MCP by `@InvalidEndpointForMcp('<reason>')` (#1014).
 *
 * Not a violation and not a suppression — a DECLARATION, which is why it is carried beside the
 * findings rather than in them. `api-rules-for-mcp` restates the whole list, with reasons, on every
 * run: an exclusion announced once at the moment somebody added it is an exclusion nobody will read
 * again, and a build-time warning at add time would be read exactly as little.
 */
export class McpExclusion {
    constructor(
        public readonly api: string,
        public readonly method: string,
        /** The decorator's reason, verbatim. Empty only when the argument could not be folded. */
        public readonly reason: string,
        /** `path/to/File.ts:LINE`, workspace-relative. */
        public readonly at: string,
    ) {}
}

/** Both rules' findings from ONE scan — one program build, two verdicts. */
export class ApiDocRulesFindings {
    constructor(
        public readonly openApi: ApiRuleFindings,
        public readonly mcp: ApiRuleFindings,
        /** Every `@InvalidEndpointForMcp` endpoint the MCP rule looked at, in declaration order. */
        public readonly mcpExclusions: readonly McpExclusion[] = [],
    ) {}

    // webpieces-disable no-function-outside-class -- static factory of this class
    static empty(): ApiDocRulesFindings {
        return new ApiDocRulesFindings(
            new ApiRuleFindings([], []),
            new ApiRuleFindings([], []),
            [],
        );
    }
}

/**
 * ONE rule's switches, resolved from webpieces.config.json once per scan.
 *
 * The DEFAULT is OFF, and unlike an absent entry elsewhere that is deliberate: `defaultRules` in
 * `@webpieces/rules-config` carries `mode: 'OFF'` for both, and the argument for it is written
 * there rather than here so there is one place to read it.
 */
export class ApiDocRule {
    constructor(
        public readonly name: string,
        public readonly enabled: boolean,
        /** Project roots this rule does not apply to — `allowedPaths` in the config. */
        public readonly allowedPaths: readonly string[],
    ) {}

    /** ARMED, everywhere — what a unit test constructs, and what an opted-in repo resolves to. */
    // webpieces-disable no-function-outside-class -- static factory of this class
    static armed(name: string): ApiDocRule {
        return new ApiDocRule(name, true, []);
    }

    // webpieces-disable no-function-outside-class -- static factory of this class
    static off(name: string): ApiDocRule {
        return new ApiDocRule(name, false, []);
    }

    /** `mode: OFF` and the time-box/branch hatches come from RuleGate, so there is ONE reading. */
    // webpieces-disable no-function-outside-class -- static factory of this class
    static fromConfig(workspaceRoot: string, name: string): ApiDocRule {
        if (new RuleGate().isDisabled(workspaceRoot, name, true)) {
            return ApiDocRule.off(name);
        }
        const rule = loadAndValidate(workspaceRoot).resolved.rules.get(name);
        const allowed = rule?.options['allowedPaths'];
        return new ApiDocRule(name, true, Array.isArray(allowed) ? (allowed as string[]) : []);
    }
}

/** ONE `webpieces-disable` naming a rule, and whether it gave a reason. */
export class DisableComment {
    constructor(public readonly hasReason: boolean) {}

    /**
     * The disable naming `rule` on the declaration at `line` (1-based) of `file`, or undefined.
     *
     * It walks UPWARD over the declaration's own leading trivia — blank lines, `//` comments, a
     * JSDoc block, and the decorators between them — because that is where an author writes one, and
     * it stops at the first line that is none of those, so a directive belonging to the PREVIOUS
     * declaration can never be read as covering this one.
     *
     * Only a directive NAMING this rule counts. An existing `// webpieces-disable no-any-unknown`
     * therefore does not silence these rules, which is the point: that rule answers "is this
     * type-safe?" and these answer "is this field PUBLISHED with no shape?" — different questions
     * with different right answers, so the second one wants its own, separately argued line.
     *
     * A file that cannot be read yields "no disable": a defect is still a defect, and inventing a
     * suppression out of an I/O failure is the one wrong answer.
     */
    // webpieces-disable no-function-outside-class -- static factory of this class
    static readAt(file: string, line: number, rule: string): DisableComment | undefined {
        const lines = DisableComment.linesOf(file);
        if (lines === undefined) return undefined;
        const start = Math.max(0, line - 1);
        const onDeclaration = DisableComment.match(lines[start] ?? '', rule);
        if (onDeclaration !== undefined) return onDeclaration;
        for (let i = start - 1; i >= 0 && i >= start - DISABLE_LOOKBACK_LINES; i--) {
            const text = (lines[i] ?? '').trim();
            const above = DisableComment.match(text, rule);
            if (above !== undefined) return above;
            if (!DisableComment.isTrivia(text)) return undefined;
        }
        return undefined;
    }

    /** Leading trivia a disable comment is allowed to sit above: blanks, comments and decorators. */
    // webpieces-disable no-function-outside-class -- private static predicate of this class
    private static isTrivia(text: string): boolean {
        return (
            text === '' ||
            text.startsWith('//') ||
            text.startsWith('*') ||
            text.startsWith('/*') ||
            text.startsWith('@')
        );
    }

    // webpieces-disable no-function-outside-class -- private static reader of this class
    private static match(text: string, rule: string): DisableComment | undefined {
        const found = text.trim().match(DISABLE_RE);
        if (found === null) return undefined;
        const named = found[1].split(',').map((each: string): string => each.trim());
        if (!named.includes(rule)) return undefined;
        return new DisableComment((found[2] ?? '').trim() !== '');
    }

    /** The file's lines, or undefined when it cannot be read. */
    // webpieces-disable no-function-outside-class -- private static reader of this class
    private static linesOf(file: string): string[] | undefined {
        if (!fs.existsSync(file)) return undefined;
        return fs.readFileSync(file, 'utf8').split('\n');
    }
}
