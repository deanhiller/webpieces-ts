import {
    GateDefinition, WEBPIECES_DISABLE, RULE_NAMES, ReviewJson,
    CK_PASS, CK_OVERRIDDEN, CK_FAIL, CK_MISSING, CK_ACKED,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

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

// One row for a consumer review checklist the branch triggered. `status` is the resolved verdict (one of
// CK_PASS | CK_OVERRIDDEN | CK_FAIL | CK_MISSING | CK_ACKED); `detail` is the reviewer output / override
// justification. A BLOCK row is always PASS/OVERRIDDEN/ACKED by the time it renders — a failed or missing
// BLOCK throws before the dashboard is built; a WARN row may render in any state. Rendered into the PR
// body so the verdict reaches the server — the PR body is the artifact of the local flow that leaves the
// checkout (alongside the HMAC gate token that proves the flow ran).
export class ChecklistRow {
    title: string;
    severity: string; // 'BLOCK' | 'WARN'
    status: string;   // CK_* verdict
    detail: string;   // reviewer output / override justification (surfaced for OVERRIDDEN + WARN-FAIL)

    constructor(title: string, severity: string, status: string, detail = '') {
        this.title = title;
        this.severity = severity;
        this.status = status;
        this.detail = detail;
    }
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

export class DashboardInput {
    title: string;
    gateResults: GateResult[];
    disables: DisableCounts;
    buildPassed: boolean;
    forkPoint: string;
    featureHead: string;
    mainHead: string;
    review: ReviewJson; // AI-authored risk/violations/summary (from review.json)
    checklists: ChecklistRow[]; // consumer checklists this branch triggered; [] for non-adopting repos

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        title: string, gateResults: GateResult[], disables: DisableCounts,
        buildPassed: boolean, forkPoint: string, featureHead: string, mainHead: string, review: ReviewJson,
        checklists: ChecklistRow[] = [],
    ) {
        this.title = title;
        this.gateResults = gateResults;
        this.disables = disables;
        this.buildPassed = buildPassed;
        this.forkPoint = forkPoint;
        this.featureHead = featureHead;
        this.mainHead = mainHead;
        this.review = review;
        this.checklists = checklists;
    }
}

/** Renders the PR-gate dashboard markdown (gates × changed files, disables, risk, 3-point hashes). */
@injectable(bindingScopeValues.Singleton)
export class Dashboard {
    // Disabled gates are in-file examples (JSON has no comments) — skip them entirely.
    computeGateResults(gates: GateDefinition[], changedFiles: string[]): GateResult[] {
        return gates
            .filter((gate: GateDefinition): boolean => !gate.disabled)
            .map((gate: GateDefinition): GateResult => {
                const matched = changedFiles.filter((file: string): boolean => this.matchesAny(gate.patterns, file));
                return new GateResult(gate.name, gate.warningColor, matched);
            });
    }

    // Count disables ADDED in this PR by scanning added (`+`) lines of the diff patch. Rule-aware:
    // reports which webpieces rules were disabled, using the canonical RULE_NAMES vocabulary.
    countAddedDisables(patch: string): DisableCounts {
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

    renderDashboard(input: DashboardInput): string {
        const lines: string[] = [];
        lines.push('## 🚦 PR Gate Dashboard');
        lines.push('');
        for (const line of this.riskLines(input.review)) lines.push(line);
        lines.push(`**Build (nx affected):** ${input.buildPassed ? '🟢 Passed' : '🔴 Failed'}`);
        for (const result of input.gateResults) lines.push(this.gateLine(result));
        lines.push(this.disableLine(input.disables));
        const eslintEmoji = input.disables.eslintCount === 0 ? '🟢 No' : `🟡 ${input.disables.eslintCount} line(s)`;
        lines.push(`**ESLint Disables Added:** ${eslintEmoji}`);
        // One row per triggered consumer checklist — only when some fired, so non-adopting repos see no
        // change to the dashboard at all.
        for (const row of input.checklists) lines.push(this.checklistLine(row));
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

    // The squash-merge COMMIT body that lands in main's history (subject is the PR title, passed to
    // `gh pr merge --subject`). Deliberately compact — unlike the full PR-body dashboard: the risk score
    // (always), every NON-green flag (green rows omitted — a commit log should surface only what stands
    // out), the summary capped at 4 sentences, and a quick link back to the PR for the full dashboard.
    renderCommitBody(input: DashboardInput, prUrl: string): string {
        const lines: string[] = [];
        lines.push(`Risk: ${this.riskBar(input.review.riskScore)} ${input.review.riskScore}/100 ${input.review.riskEmoji} (${input.review.riskLevel})`);
        lines.push('');
        const flags = this.nonGreenFlags(input);
        if (flags.length === 0) {
            lines.push('Flags: 🟢 all green');
        } else {
            lines.push('Flags (non-green):');
            for (const flag of flags) lines.push(`- ${flag}`);
        }
        const summary = this.firstSentences(input.review.summary.trim(), 4);
        if (summary !== '') {
            lines.push('');
            lines.push(summary);
        }
        if (prUrl !== '') {
            lines.push('');
            lines.push(`PR: ${prUrl}`);
        }
        return lines.join('\n');
    }

    // Every dashboard row that is NOT green, as a flat bullet list for the commit body. Green rows
    // (build passed, gate did not match, zero disables/violations) are intentionally omitted.
    private nonGreenFlags(input: DashboardInput): string[] {
        const flags: string[] = [];
        if (!input.buildPassed) flags.push('Build (nx affected): 🔴 Failed');
        if (input.review.violations.length > 0) flags.push(`Pattern Violations: 🟡 ${input.review.violations.length} violation(s)`);
        for (const result of input.gateResults) {
            if (result.matchedFiles.length === 0) continue;
            const emoji = result.warningColor === 'red' ? '🔴' : '🟡';
            flags.push(`${result.name}: ${emoji} ${result.matchedFiles.length} file(s)`);
        }
        if (input.disables.webpiecesCount > 0) {
            const which = input.disables.webpiecesRules.length > 0 ? ` — ${input.disables.webpiecesRules.join(', ')}` : '';
            flags.push(`Webpieces Disables Added: 🟡 ${input.disables.webpiecesCount} line(s)${which}`);
        }
        if (input.disables.eslintCount > 0) flags.push(`ESLint Disables Added: 🟡 ${input.disables.eslintCount} line(s)`);
        // A triggered checklist is noteworthy in main's history — carry each into the commit body.
        for (const row of input.checklists) {
            flags.push(`Checklist — ${row.title}: ${this.checklistStatusText(row)}`);
        }
        return flags;
    }

    // Emoji + words for a checklist verdict, shared by the dashboard row and the commit-body flag.
    private checklistStatusText(row: ChecklistRow): string {
        const sev = row.severity;
        if (row.status === CK_OVERRIDDEN) {
            const why = row.detail.trim() !== '' ? ` — override: ${row.detail.trim()}` : '';
            return `🟡 ${sev} — OVERRIDDEN${why}`;
        }
        if (row.status === CK_FAIL) return `🔴 ${sev} — FAILED review`;
        if (row.status === CK_MISSING) return `⚪ ${sev} — not reviewed`;
        if (row.status === CK_ACKED) return `🟢 ${sev} — acknowledged`;
        return `🟢 ${sev} — passed`; // CK_PASS
    }

    // First `max` sentences of `text`. A sentence ends at `. ! ?` ONLY when followed by whitespace or
    // end-of-string, so interior dots in filenames/paths/versions (dependencies.json, runtime-graph.ts,
    // 0.4.447) do NOT split — and, unlike a greedy `[^.!?]+` regex, no text is ever dropped when such a
    // dot appears (that footgun silently deleted the run of prose up to the next real boundary). Keeps
    // the commit body scannable; the full summary still lives in the PR-body dashboard.
    private firstSentences(text: string, max: number): string {
        if (text === '') return '';
        const sentences: string[] = [];
        let start = 0;
        for (let i = 0; i < text.length && sentences.length < max; i++) {
            const ch = text[i];
            const isTerminator = ch === '.' || ch === '!' || ch === '?';
            const next = text[i + 1];
            if (isTerminator && (next === undefined || /\s/.test(next))) {
                sentences.push(text.slice(start, i + 1).trim());
                start = i + 1;
            }
        }
        // Trailing text with no terminator still counts as a sentence (up to the cap).
        if (sentences.length < max && start < text.length) {
            const tail = text.slice(start).trim();
            if (tail !== '') sentences.push(tail);
        }
        return sentences.join(' ').trim();
    }

    // Self-contained glob matcher (** , * , ?) so pr-gate needs no extra runtime dependency.
    private globToRegex(pattern: string): RegExp {
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

    private matchesAny(patterns: string[], file: string): boolean {
        for (const pattern of patterns) {
            if (this.globToRegex(pattern).test(file)) return true;
        }
        return false;
    }

    private gateLine(result: GateResult): string {
        if (result.matchedFiles.length === 0) return `**${result.name}:** 🟢 No`;
        const emoji = result.warningColor === 'red' ? '🔴' : '🟡';
        return `**${result.name}:** ${emoji} Yes (${result.matchedFiles.length} file(s))`;
    }

    // A triggered consumer checklist row: the resolved verdict (passed / overridden / failed / …).
    private checklistLine(row: ChecklistRow): string {
        return `**Checklist — ${row.title}:** ${this.checklistStatusText(row)}`;
    }

    // 10-cell risk bar colored by band (🟩 ≤25, 🟨 ≤50, 🟧 ≤75, 🟥 >75), at least one filled cell.
    private riskBar(score: number): string {
        const clamped = Math.max(0, Math.min(100, score));
        const cell = clamped <= 25 ? '🟩' : clamped <= 50 ? '🟨' : clamped <= 75 ? '🟧' : '🟥';
        const filled = Math.max(1, Math.min(10, Math.round(clamped / 10)));
        return cell.repeat(filled) + '⬜'.repeat(10 - filled);
    }

    // RISK section (the AI half): Risk Score bar, Risk Level, Pattern Violations.
    private riskLines(review: ReviewJson): string[] {
        const violations = review.violations.length;
        const violationLine = violations === 0 ? '🟢 No' : `🟡 Yes (${violations} violation(s))`;
        return [
            `**Risk Score:** ${this.riskBar(review.riskScore)} **${review.riskScore}/100** ${review.riskEmoji}`,
            `**Risk Level:** ${review.riskEmoji} **${review.riskLevel}**`,
            `**Pattern Violations:** ${violationLine}`,
        ];
    }

    private disableLine(disables: DisableCounts): string {
        if (disables.webpiecesCount === 0) return '**Webpieces Disables Added:** 🟢 No';
        const which = disables.webpiecesRules.length > 0 ? ` — ${disables.webpiecesRules.join(', ')}` : '';
        return `**Webpieces Disables Added:** 🟡 ${disables.webpiecesCount} line(s)${which}`;
    }
}
