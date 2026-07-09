import { BaseRuleConfig, ModifiedCodeMode } from './rule-configs';
import { WEBPIECES_DISABLE } from './constants';

// ---------------------------------------------------------------------------
// match-rules — a generic, client-configurable content-guard engine.
//
// Unlike the keyed `rules` (each a framework class with a fixed regex + message),
// a match-rule is authored ENTIRELY in webpieces.config.json: a `name`, a list of
// raw-regex `patterns` to flag, a `mainMessage` + `options[]` shown to the AI, and
// per-entry scoping (`mode`, `allowedPaths`, `disableAllowed`, `ignoreModifiedUntilEpoch`).
// The framework ships ONE default example — the `no-fetch` guard (see DEFAULT_MATCH_RULES)
// — and clients add more (no-moment, no-lodash-chain, …) without a framework release.
//
// Lives in a NEW top-level `match-rules` ARRAY section (shaped like `pr-gate`/`excludePaths`),
// NOT a keyed entry under `rules`. Both engines (ai-hook-rules edit-time, code-rules build-time)
// instantiate one guard per array entry and share the pure matching engine below.
// ---------------------------------------------------------------------------

/**
 * One entry of the `match-rules` array. Extends BaseRuleConfig so AbstractRule.shouldRun()
 * (OFF / epoch / branch escape hatches) works per entry. `name` doubles as the
 * `// webpieces-disable <name> -- <reason>` token and the report label.
 */
export class MatchRuleConfig extends BaseRuleConfig {
    declare mode?: ModifiedCodeMode;
    name: string;
    patterns: string[];
    mainMessage: string;
    options: string[];
    disableAllowed?: boolean;
    allowedPaths?: string[];

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        name: string,
        patterns: string[],
        mainMessage: string,
        mode: ModifiedCodeMode,
        ignoreModifiedUntilEpoch: number,
        options: string[] = [],
        disableAllowed: boolean = true,
        allowedPaths: string[] = [],
    ) {
        super();
        this.name = name;
        this.patterns = patterns;
        this.mainMessage = mainMessage;
        this.mode = mode;
        this.ignoreModifiedUntilEpoch = ignoreModifiedUntilEpoch;
        this.options = options;
        this.disableAllowed = disableAllowed;
        this.allowedPaths = allowedPaths;
    }
}

/** One flagged line. Raw hit — callers apply their own disable filtering. */
export class MatchRuleViolation {
    readonly line: number;
    readonly context: string;
    readonly patternIndex: number;

    constructor(line: number, context: string, patternIndex: number) {
        this.line = line;
        this.context = context;
        this.patternIndex = patternIndex;
    }
}

const TEST_PATHS: readonly RegExp[] = [/\.test\.ts$/, /\.spec\.ts$/, /__tests__\//];

// Glob → RegExp, matching the convention used by no-symbol-di-tokens (`**` spans path
// separators, `*` stays within a segment). Kept local so rules-config owns no shared glob util.
function globToRegex(pattern: string): RegExp {
    let re = '';
    let i = 0;
    while (i < pattern.length) {
        const ch = pattern[i];
        if (ch === '*') {
            if (pattern[i + 1] === '*') {
                re += '.*';
                i += 2;
                if (pattern[i] === '/') i += 1;
                continue;
            }
            re += '[^/]*';
            i += 1;
            continue;
        }
        if (ch === '?') {
            re += '[^/]';
            i += 1;
            continue;
        }
        if ('.+^$(){}|[]\\'.includes(ch)) {
            re += '\\' + ch;
            i += 1;
            continue;
        }
        re += ch;
        i += 1;
    }
    return new RegExp('^' + re + '$');
}

/** A file is exempt if it's a test file or matches one of the rule's allowedPaths globs. */
export function isMatchRuleAllowedPath(relativePath: string, allowedPaths: readonly string[]): boolean {
    if (TEST_PATHS.some((re: RegExp) => re.test(relativePath))) return true;
    return allowedPaths.some((pattern: string) => globToRegex(pattern).test(relativePath));
}

function stripLineComment(line: string): string {
    const idx = line.indexOf('//');
    if (idx === -1) return line;
    return line.substring(0, idx);
}

/**
 * Compile a match-rule's raw-regex patterns. Patterns are trusted here — validateMatchRulesSection
 * (run in loadAndValidate, before any engine consumes a match-rule) compile-checks every pattern and
 * rejects the config on the first bad one, so an invalid pattern can never reach this function.
 */
export function compileMatchRulePatterns(config: MatchRuleConfig): RegExp[] {
    return (config.patterns ?? []).map((pattern: string) => new RegExp(pattern));
}

/**
 * Pure matching engine shared by BOTH engines. Takes the ORIGINAL lines (each is stripped of its
 * `//` comment before matching, mirroring the code-rules validators), returns raw hits — NO disable
 * filtering (ai-hook applies its line-mapped isLineDisabled; code-rules applies hasDisable). Returns
 * [] for exempt paths (test files / allowedPaths). At most one violation per line (first pattern wins).
 */
export function findMatchRuleViolations(
    lines: readonly string[],
    relativePath: string,
    config: MatchRuleConfig,
): MatchRuleViolation[] {
    if (isMatchRuleAllowedPath(relativePath, config.allowedPaths ?? [])) return [];

    const compiled = compileMatchRulePatterns(config);
    if (compiled.length === 0) return [];

    const violations: MatchRuleViolation[] = [];
    for (let i = 0; i < lines.length; i += 1) {
        const stripped = stripLineComment(lines[i] ?? '');
        for (let p = 0; p < compiled.length; p += 1) {
            if (compiled[p].test(stripped)) {
                violations.push(new MatchRuleViolation(i + 1, (lines[i] ?? '').trim(), p));
                break;
            }
        }
    }
    return violations;
}

/**
 * Render a match-rule's message as a single string for the code-rules console report. Mirrors the
 * ai-hook FixHint layout (mainMessage, "Fix Option N:", disable escape) so both engines read alike.
 * ai-hook builds a real FixHint instead (see MatchRule) to reuse report.ts numbering.
 */
export function renderMatchRuleMessage(config: MatchRuleConfig): string {
    const lines: string[] = [config.mainMessage];
    (config.options ?? []).forEach((opt: string, i: number) => {
        lines.push(`  Fix Option ${String(i + 1)}: ${opt}`);
    });
    if (config.disableAllowed ?? true) {
        lines.push(`  Escape (if truly needed): // ${WEBPIECES_DISABLE} ${config.name} -- <reason>`);
    }
    return lines.join('\n');
}

// The ONE guard the framework seeds. Printed verbatim (as JSON) by validateMatchRulesSection when the
// `match-rules` section is missing, and written into a fresh config by the installer. Clients edit it
// and add more entries. `packages/http/http-client/**` MUST stay allowlisted — ClientFactory.ts is the
// single sanctioned fetch (the generated proxy); the apis-external dirs host external-service impls.
export const DEFAULT_MATCH_RULES: readonly MatchRuleConfig[] = [
    new MatchRuleConfig(
        'no-fetch',
        [
            '(?<![.\\w])fetch\\s*\\(',
            '\\baxios\\b',
            '\\bXMLHttpRequest\\b',
            '\\bnew\\s+Request\\s*\\(',
            "from\\s+['\"](node-fetch|got|undici)['\"]",
        ],
        'Raw HTTP (fetch/axios/XMLHttpRequest/…) bypasses contract-first development — the client and server stop sharing the same API contract/types. Generate a type-safe client from the contract instead:',
        'NEW_AND_MODIFIED_CODE',
        0,
        [
            "PREFERRED: generate a client from the API you want to call — import { ClientHttpFactory, ClientConfig } from '@webpieces/http-client'; const client = factory.createClient(SomeApi, new ClientConfig('https://host')); await client.someMethod(req);",
            'Reuse an existing API contract already defined in your repo (under libraries/apis/**) and generate its client the same way.',
            'For a truly external service, create a NEW API contract (a decorated abstract class) AND a NEW implementation that calls fetch behind that contract, under an allowlisted dir (libraries/apis-external/**). The contract stays the shared surface; fetch is an impl detail.',
        ],
        true,
        ['packages/http/http-client/**', 'libraries/apis-external/**', 'libraries/apis/external/**'],
    ),
];
