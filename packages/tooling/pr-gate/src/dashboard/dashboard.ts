import { GateDefinition, WEBPIECES_DISABLE, RULE_NAMES, ReviewJson } from '@webpieces/rules-config';

// Self-contained glob matcher (** , * , ?) so pr-gate needs no extra runtime dependency.
function globToRegex(pattern: string): RegExp {
    let re = '';
    let i = 0;
    while (i < pattern.length) {
        const ch = pattern[i];
        if (ch === '*' && pattern[i + 1] === '*') {
            re += '.*';
            i += 2;
            if (pattern[i] === '/') i += 1;
            continue;
        }
        if (ch === '*') { re += '[^/]*'; i += 1; continue; }
        if (ch === '?') { re += '[^/]'; i += 1; continue; }
        if ('.+^$(){}|[]\\'.includes(ch)) { re += '\\' + ch; i += 1; continue; }
        re += ch;
        i += 1;
    }
    return new RegExp('^' + re + '$');
}

function matchesAny(patterns: string[], file: string): boolean {
    for (const pattern of patterns) {
        if (globToRegex(pattern).test(file)) return true;
    }
    return false;
}

export class GateResult {
    name: string;
    warningColor: string; // 'yellow' | 'red' — the color shown WHEN files matched (green is implicit)
    matchedFiles: string[];

    constructor(name: string, warningColor: string, matchedFiles: string[]) {
        this.name = name;
        this.warningColor = warningColor;
        this.matchedFiles = matchedFiles;
    }
}

// Disabled gates are in-file examples (JSON has no comments) — skip them entirely.
export function computeGateResults(gates: GateDefinition[], changedFiles: string[]): GateResult[] {
    return gates
        .filter((gate: GateDefinition): boolean => !gate.disabled)
        .map((gate: GateDefinition): GateResult => {
            const matched = changedFiles.filter((file: string): boolean => matchesAny(gate.patterns, file));
            return new GateResult(gate.name, gate.warningColor, matched);
        });
}

export class DisableCounts {
    webpiecesCount: number;
    eslintCount: number;
    webpiecesRules: string[];

    constructor(webpiecesCount: number, eslintCount: number, webpiecesRules: string[]) {
        this.webpiecesCount = webpiecesCount;
        this.eslintCount = eslintCount;
        this.webpiecesRules = webpiecesRules;
    }
}

// Count disables ADDED in this PR by scanning added (`+`) lines of the diff patch. Rule-aware:
// reports which webpieces rules were disabled, using the canonical RULE_NAMES vocabulary.
export function countAddedDisables(patch: string): DisableCounts {
    let webpiecesCount = 0;
    let eslintCount = 0;
    const rules = new Set<string>();
    const allRuleTokens = Object.keys(RULE_NAMES).map((key: string): string => (RULE_NAMES as Record<string, string>)[key]);

    for (const line of patch.split('\n')) {
        if (!line.startsWith('+') || line.startsWith('+++')) continue;
        if (line.includes(WEBPIECES_DISABLE)) {
            webpiecesCount += 1;
            for (const token of allRuleTokens) {
                if (line.includes(token)) rules.add(token);
            }
        }
        if (line.includes('eslint-disable')) eslintCount += 1;
    }
    return new DisableCounts(webpiecesCount, eslintCount, Array.from(rules).sort());
}

export class DashboardInput {
    title: string;
    gateResults: GateResult[];
    disables: DisableCounts;
    buildPassed: boolean;
    forkPoint: string;
    featureHead: string;
    mainHead: string;
    review: ReviewJson; // AI-authored risk/violations/summary (from review.json)

    constructor(
        title: string, gateResults: GateResult[], disables: DisableCounts,
        buildPassed: boolean, forkPoint: string, featureHead: string, mainHead: string, review: ReviewJson,
    ) {
        this.title = title;
        this.gateResults = gateResults;
        this.disables = disables;
        this.buildPassed = buildPassed;
        this.forkPoint = forkPoint;
        this.featureHead = featureHead;
        this.mainHead = mainHead;
        this.review = review;
    }
}

function gateLine(result: GateResult): string {
    if (result.matchedFiles.length === 0) return `**${result.name}:** 🟢 No`;
    const emoji = result.warningColor === 'red' ? '🔴' : '🟡';
    return `**${result.name}:** ${emoji} Yes (${result.matchedFiles.length} file(s))`;
}

// 10-cell risk bar colored by band (🟩 ≤25, 🟨 ≤50, 🟧 ≤75, 🟥 >75), at least one filled cell —
// ported from trytami's github_risk_bar (git-display-utils.sh).
function riskBar(score: number): string {
    const clamped = Math.max(0, Math.min(100, score));
    const cell = clamped <= 25 ? '🟩' : clamped <= 50 ? '🟨' : clamped <= 75 ? '🟧' : '🟥';
    const filled = Math.max(1, Math.min(10, Math.round(clamped / 10)));
    return cell.repeat(filled) + '⬜'.repeat(10 - filled);
}

// RISK section (trytami's AI half): Risk Score bar, Risk Level, Pattern Violations.
function riskLines(review: ReviewJson): string[] {
    const violations = review.violations.length;
    const violationLine = violations === 0 ? '🟢 No' : `🟡 Yes (${violations} violation(s))`;
    return [
        `**Risk Score:** ${riskBar(review.riskScore)} **${review.riskScore}/100** ${review.riskEmoji}`,
        `**Risk Level:** ${review.riskEmoji} **${review.riskLevel}**`,
        `**Pattern Violations:** ${violationLine}`,
    ];
}

function disableLine(disables: DisableCounts): string {
    if (disables.webpiecesCount === 0) return '**Webpieces Disables Added:** 🟢 No';
    const which = disables.webpiecesRules.length > 0 ? ` — ${disables.webpiecesRules.join(', ')}` : '';
    return `**Webpieces Disables Added:** 🟡 ${disables.webpiecesCount} line(s)${which}`;
}

export function renderDashboard(input: DashboardInput): string {
    const lines: string[] = [];
    lines.push('## 🚦 PR Gate Dashboard');
    lines.push('');
    for (const line of riskLines(input.review)) lines.push(line);
    lines.push(`**Build (nx affected):** ${input.buildPassed ? '🟢 Passed' : '🔴 Failed'}`);
    for (const result of input.gateResults) lines.push(gateLine(result));
    lines.push(disableLine(input.disables));
    const eslintEmoji = input.disables.eslintCount === 0 ? '🟢 No' : `🟡 ${input.disables.eslintCount} line(s)`;
    lines.push(`**ESLint Disables Added:** ${eslintEmoji}`);
    lines.push('');
    if (input.review.summary.trim() !== '') {
        lines.push('### Summary');
        lines.push(input.review.summary.trim());
        lines.push('');
    }
    lines.push('### 🔍 3-Point Hash Points');
    lines.push(`- Fork point (A): \`${input.forkPoint.slice(0, 12)}\``);
    lines.push(`- Feature HEAD (B): \`${input.featureHead.slice(0, 12)}\``);
    lines.push(`- Main HEAD (C): \`${input.mainHead.slice(0, 12)}\``);
    lines.push('');
    lines.push('<sub>🤖 Generated by `pnpm wp-finish-upsert-pr` (build ran via nx affected — not self-attested).</sub>');
    return lines.join('\n');
}
