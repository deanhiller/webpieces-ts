import {
    GateDefinition,
    WEBPIECES_DISABLE,
    RULE_NAMES,
    ReviewJson,
    formatFileList,
    CK_PASS,
    CK_WARN,
    CK_OVERRIDDEN,
    CK_FAIL,
    CK_MISSING,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

// Hidden marker on the checklist review COMMENT, so wp-finish can find + PATCH its own comment on every
// push instead of appending a new one. Versioned so the format can evolve without matching an old shape.
// v2 = the full roster (every DEFINED checklist, matched or not) + tri-state verdicts.
export const CHECKLIST_COMMENT_MARKER = '<!-- webpieces-checklists v2 -->';
const COMMENT_LIMIT = 65000; // under GitHub's 65536-char cap, with headroom for the marker + roll-up.

// One checklist section for the combined comment (heading + verbatim reviewer output), so oversize
// truncation can shrink the longest BODY without ever dropping a verdict heading.
class CommentSection {
    heading: string;
    body: string;

    constructor(heading: string, body: string) {
        this.heading = heading;
        this.body = body;
    }
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

// One row for a consumer review checklist the branch triggered. `status` is the resolved verdict (one of
// CK_PASS | CK_WARN | CK_OVERRIDDEN | CK_FAIL | CK_MISSING | CK_BAD_FORMAT); `detail` is the reviewer
// output / override justification. A row is always PASS/WARN/OVERRIDDEN by the time it renders — a failed,
// missing or unreadable verdict throws before the dashboard is built. Rendered into the PR body so the
// verdict reaches the server — the PR body is the artifact of the local flow that leaves the checkout
// (alongside the HMAC gate token that proves the flow ran).
export class ChecklistRow {
    title: string; // the checklist id (= reviewer subagent name)
    status: string; // CK_* verdict
    detail: string; // reviewer output / override justification (surfaced for OVERRIDDEN)

    constructor(title: string, status: string, detail = '') {
        this.title = title;
        this.status = status;
        this.detail = detail;
    }
}

/**
 * One roster line of the checklist COMMENT: a defined checklist, whether its reviewer ran, and the evidence
 * for WHY. Deliberately separate from {@link ChecklistRow} rather than five more fields on it — ChecklistRow
 * also feeds the PR body and the squash-commit body, and roster evidence has no business travelling into
 * main's git history or through every DashboardInput construction site.
 *
 * Kept in pr-gate, not rules-config: the shape of a GitHub comment is this package's concern, and
 * rules-config is the dependency, not the dependent.
 */
export class ChecklistCommentRow {
    subagent: string; // the reviewer / checklist id
    status: string; // CK_* verdict; '' when it did not run
    detail: string; // verbatim reviewer output
    ran: boolean; // false = skipped, which is a NORMAL, healthy outcome
    // The checklist's CONFIGURED globs. The only safe signal for "always runs": a patternless checklist and
    // a skipped one both have an empty `firedPatterns`, and they mean opposite things.
    configuredPatterns: string[];
    firedPatterns: string[]; // which configured globs actually hit a changed file
    matchedFiles: string[];
    changedFileCount: number; // how many files were considered at all — "0 of N" needs the N
    /**
     * Whether this reviewer's own transcript shows it OPENING the extracted diff.
     *
     * '' = not assessed (no Claude Code session, or nothing was materialized) and prints nothing — "no
     * evidence recorded" and "evidence says it never looked" are different claims, and conflating them
     * would accuse a reviewer that ran perfectly well in CI. 'yes' | 'no' otherwise. Defaulted, so every
     * existing construction site is unchanged.
     */
    diffRead: string = '';

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        subagent: string,
        status: string,
        detail: string,
        ran: boolean,
        configuredPatterns: string[],
        firedPatterns: string[],
        matchedFiles: string[],
        changedFileCount: number,
    ) {
        this.subagent = subagent;
        this.status = status;
        this.detail = detail;
        this.ran = ran;
        this.configuredPatterns = configuredPatterns;
        this.firedPatterns = firedPatterns;
        this.matchedFiles = matchedFiles;
        this.changedFileCount = changedFileCount;
    }
}

/**
 * One severity bucket of the rolled-up **Checklists** dashboard row: its emoji, the words that describe it,
 * and which checklists landed in it. Data-only.
 *
 * A bucket knows whether it should NAME its members: the non-green ones do (a reader has to know WHICH
 * reviewer to go read), the passed bucket does not (a list of what went fine is noise on a one-line row).
 */
class RollupBucket {
    label: string; // 'blocking' | 'overridden' | 'with concerns' | 'passed'
    emoji: string;
    named: boolean; // list the checklist ids on the row, or report a bare count
    titles: string[];

    constructor(label: string, emoji: string, named: boolean) {
        this.label = label;
        this.emoji = emoji;
        this.named = named;
        this.titles = [];
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
        title: string,
        gateResults: GateResult[],
        disables: DisableCounts,
        buildPassed: boolean,
        forkPoint: string,
        featureHead: string,
        mainHead: string,
        review: ReviewJson,
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
                const matched = changedFiles.filter((file: string): boolean =>
                    this.matchesAny(gate.patterns, file),
                );
                return new GateResult(gate.name, gate.warningColor, matched);
            });
    }

    // Count disables ADDED in this PR by scanning added (`+`) lines of the diff patch. Rule-aware:
    // reports which webpieces rules were disabled, using the canonical RULE_NAMES vocabulary.
    countAddedDisables(patch: string): DisableCounts {
        let webpiecesCount = 0;
        let eslintCount = 0;
        const rules = new Set<string>();
        const allRuleTokens = Object.keys(RULE_NAMES).map(
            (key: string): string => (RULE_NAMES as Record<string, string>)[key],
        );

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
        const eslintEmoji =
            input.disables.eslintCount === 0 ? '🟢 No' : `🟡 ${input.disables.eslintCount} line(s)`;
        lines.push(`**ESLint Disables Added:** ${eslintEmoji}`);
        // ONE rolled-up row for ALL triggered consumer checklists — a worst-of colour and a count, sitting
        // with the other status rows. It used to be one row PER checklist, each inlining that checklist's
        // whole verdict/override paragraph: on a six-checklist PR that was the same ~90-word override
        // repeated six times, burying the signal rows above it — and every word of it was already in the
        // checklist COMMENT, per reviewer, in full. ALWAYS emitted, including the zero case: "no reviewer
        // looked at this PR" is a fact a reader must be told, and an absent row silently reads as a green
        // all-clear (see checklistRollupLine).
        lines.push(this.checklistRollupLine(input.checklists));
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
        lines.push(
            '<sub>🤖 Generated by `pnpm wp-finish-upsert-pr` (build ran via nx affected — not self-attested).</sub>',
        );
        return lines.join('\n');
    }

    /**
     * The ONE combined PR comment. Two halves, in this order:
     *
     *   1. A roll-up plus the FULL ROSTER — every DEFINED checklist as a checkbox, each with a sub-bullet
     *      stating exactly which globs fired against which files, or which did not and out of how many.
     *      Skipped checklists are listed on purpose: skipping is the normal, healthy outcome, and a comment
     *      that names only the reviewers that fired cannot distinguish "evaluated and irrelevant" from
     *      "never wired up" — nor answer "why did the DB reviewer run on my frontend PR?".
     *   2. One section per reviewer that RAN, carrying its full `output` — the depth a verdict line throws
     *      away. Overridden first, then warned, then passed: a reader should meet the exceptions first.
     *
     * Idempotent: keyed by the hidden marker so wp-finish PATCHes this same comment on every push.
     */
    renderChecklistComment(
        rows: readonly ChecklistCommentRow[],
        provenanceVerified: boolean,
        baseResolved: boolean,
    ): string {
        const ran = this.ranOrdered(rows);
        const prov = provenanceVerified
            ? '_Each reviewer ran as its own independent subagent, verified from the Claude Code harness._'
            : '_⚠️ Reviewer provenance was NOT verified (no Claude Code session) — treat these as unverified._';
        // The roster lives in the HEADER, never in a section: fitComment only ever shrinks section bodies,
        // so a roster line can never be the thing an oversize comment silently drops.
        const lines: string[] = [CHECKLIST_COMMENT_MARKER, this.rollupHeader(rows, baseResolved)];
        // No reviewer ran ⇒ no provenance claim to make. Printing one either way would attest to nothing.
        if (ran.length > 0) lines.push(prov);
        lines.push('', `### Checklists (all ${rows.length})`);
        for (const row of rows) lines.push(this.rosterBullet(row));
        const header = lines.join('\n');
        if (ran.length === 0) {
            return (
                `${header}\n\n_No reviewer had to run on this diff — every configured checklist was ` +
                `evaluated and none of them applied._`
            );
        }
        return this.fitComment(
            `${header}\n\n### Reviews that ran`,
            ran.map((r: ChecklistCommentRow): CommentSection => this.commentSection(r)),
        );
    }

    // The roll-up line. `baseResolved:false` replaces it entirely: with no fork point the changed-file set is
    // EMPTY, so nothing matched — including patternless ALWAYS-RUNS checklists — and reporting that as
    // "all skipped ✅" would post a green all-clear for a PR where nothing was actually evaluated.
    private rollupHeader(rows: readonly ChecklistCommentRow[], baseResolved: boolean): string {
        if (!baseResolved) {
            return (
                `## 🔍 Company review checklists — ⚠️ NOT EVALUATED (${rows.length} defined)\n` +
                `_No diff base (fork point of main) could be resolved, so no checklist was matched against ` +
                `anything. This is **not** an all-clear._`
            );
        }
        const ran = rows.filter((r: ChecklistCommentRow): boolean => r.ran);
        const skipped = rows.length - ran.length;
        const parts: string[] = [];
        for (const pair of this.rollupCounts(ran)) parts.push(pair);
        const breakdown = parts.length > 0 ? ` (${parts.join(' · ')})` : '';
        const skip = skipped > 0 ? ` · ${skipped} skipped ✅` : '';
        return `## 🔍 Company review checklists — ${rows.length} defined · ${ran.length} ran${breakdown}${skip}`;
    }

    // `🟢 2 · 🟡 1` — only the non-zero buckets, so a clean run reads as one number rather than four.
    private rollupCounts(ran: readonly ChecklistCommentRow[]): string[] {
        const counts: string[] = [];
        const emojiFor: string[] = ['🟢', '🟡', '🟠'];
        const statusFor: string[] = [CK_PASS, CK_WARN, CK_OVERRIDDEN];
        statusFor.forEach((status: string, i: number): void => {
            const n = ran.filter((r: ChecklistCommentRow): boolean => r.status === status).length;
            if (n > 0) counts.push(`${emojiFor[i]} ${n}`);
        });
        return counts;
    }

    // One roster line + its why sub-bullet. A checked box means a reviewer ran; an unchecked one means the
    // checklist was evaluated and did not apply, which the words state as the good news it is.
    private rosterBullet(row: ChecklistCommentRow): string {
        const box = row.ran ? '- [x]' : '- [ ]';
        return (
            `${box} ${this.verdictEmoji(row)} **${row.subagent}** — ${this.verdictWords(row)}${this.evidenceSuffix(row)}\n` +
            `  - ${this.whyLine(row)}`
        );
    }

    /**
     * Whether the reviewer demonstrably opened the diff, read from its own transcript. A QUALITY signal and
     * never a blocker (see SubagentProvenanceService.evidenceFor) — but published, because "wrote a verdict
     * without reading the change" is exactly what a reader of this comment would want to weigh.
     */
    private evidenceSuffix(row: ChecklistCommentRow): string {
        if (!row.ran || row.diffRead === '') return '';
        return row.diffRead === 'yes' ? ' _(diff read ✓)_' : ' _(⚠️ no diff read recorded)_';
    }

    private verdictEmoji(row: ChecklistCommentRow): string {
        if (!row.ran) return '⚪';
        if (row.status === CK_PASS) return '🟢';
        if (row.status === CK_WARN) return '🟡';
        if (row.status === CK_OVERRIDDEN) return '🟠';
        if (row.status === CK_FAIL) return '🔴';
        return '⚪';
    }

    // SHORT words for a roster line / section heading. Short on purpose: the reviewer's own output and any
    // override justification get their own section below, and a roster exists to be scanned.
    private verdictWords(row: ChecklistCommentRow): string {
        if (!row.ran) return 'skipped, not applicable to this diff (expected ✅)';
        if (row.status === CK_PASS) return 'passed';
        if (row.status === CK_WARN) return 'passed with concerns';
        if (row.status === CK_OVERRIDDEN) return 'OVERRIDDEN — shipped with a stated justification';
        if (row.status === CK_FAIL) return 'FAILED review';
        if (row.status === CK_MISSING) return 'no verdict written';
        return `unknown verdict (${row.status})`;
    }

    /**
     * WHY this checklist ran or did not — the line that answers "why was this reviewer involved?". Branches
     * on `configuredPatterns`, NEVER on `firedPatterns.length`: a patternless checklist and a skipped one
     * both fired zero globs and they mean opposite things, so keying off the fired list would tell every
     * skipped checklist's reader that the whole diff had been in its scope.
     */
    private whyLine(row: ChecklistCommentRow): string {
        const total = row.changedFileCount;
        if (row.configuredPatterns.length === 0) {
            // State the fact, not a suspicion. Patternless is a deliberate configuration — an always-runs
            // gate (every PR names a ticket, every PR has an owner) is exactly what it is FOR — so telling
            // every such row to "add `patterns` if that is not intended" nags the repos that meant it, on
            // every PR, forever. A reader who wants to know whether it was intended can read the config.
            return (
                `ALWAYS RUNS (no patterns) — whole diff in scope, ${total} changed file(s): ` +
                `${formatFileList(row.matchedFiles)}`
            );
        }
        const configured = this.asCode(row.configuredPatterns);
        if (row.firedPatterns.length === 0) {
            return `${configured} matched 0 of ${total} changed file(s)`;
        }
        return (
            `matched ${this.asCode(row.firedPatterns)} → ${row.matchedFiles.length} of ${total} ` +
            `changed file(s): ${formatFileList(row.matchedFiles)}`
        );
    }

    private asCode(patterns: readonly string[]): string {
        return patterns.map((p: string): string => `\`${p}\``).join(', ');
    }

    // Reviewers that ran, exceptions first (overridden → warned → passed) so a reader meets what needs
    // attention before a wall of green.
    private ranOrdered(rows: readonly ChecklistCommentRow[]): ChecklistCommentRow[] {
        const rank: string[] = [CK_OVERRIDDEN, CK_WARN, CK_PASS];
        return rows
            .filter((r: ChecklistCommentRow): boolean => r.ran)
            .slice()
            .sort(
                (a: ChecklistCommentRow, b: ChecklistCommentRow): number =>
                    this.rankOf(rank, a.status) - this.rankOf(rank, b.status),
            );
    }

    private rankOf(rank: readonly string[], status: string): number {
        const idx = rank.indexOf(status);
        return idx < 0 ? rank.length : idx;
    }

    private commentSection(row: ChecklistCommentRow): CommentSection {
        const heading = `#### ${this.verdictEmoji(row)} ${row.subagent} — ${this.verdictWords(row)}`;
        const body =
            row.detail.trim() !== '' ? row.detail.trim() : '_(reviewer recorded no output)_';
        return new CommentSection(heading, body);
    }

    // Keep the comment under GitHub's size cap by shrinking the LONGEST section body first (so a short
    // overridden note is never cut to make room for a long passing one), never dropping a verdict heading.
    private fitComment(header: string, sections: CommentSection[]): string {
        const assemble = (): string =>
            `${header}\n\n${sections.map((s: CommentSection): string => `${s.heading}\n\n${s.body}`).join('\n\n')}`;
        const trunc = '\n\n…_[truncated to fit the GitHub comment size limit]_';
        let out = assemble();
        while (out.length > COMMENT_LIMIT) {
            const idx = this.longestBodyIndex(sections);
            if (idx < 0 || sections[idx].body.length <= trunc.length + 1) break;
            const over = out.length - COMMENT_LIMIT;
            const keep = Math.max(0, sections[idx].body.length - over - trunc.length - 8);
            sections[idx].body = sections[idx].body.slice(0, keep).trimEnd() + trunc;
            out = assemble();
        }
        return out;
    }

    private longestBodyIndex(sections: readonly CommentSection[]): number {
        let idx = -1;
        let max = -1;
        sections.forEach((s: CommentSection, i: number): void => {
            if (s.body.length > max) {
                max = s.body.length;
                idx = i;
            }
        });
        return idx;
    }

    // The squash-merge COMMIT body that lands in main's history (subject is the PR title, passed to
    // `gh pr merge --subject`). Deliberately compact — unlike the full PR-body dashboard: the risk score
    // (always), every NON-green flag (green rows omitted — a commit log should surface only what stands
    // out), the summary capped at 4 sentences, and a quick link back to the PR for the full dashboard.
    renderCommitBody(input: DashboardInput, prUrl: string): string {
        const lines: string[] = [];
        lines.push(
            `Risk: ${this.riskBar(input.review.riskScore)} ${input.review.riskScore}/100 ${input.review.riskEmoji} (${input.review.riskLevel})`,
        );
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
        if (input.review.violations.length > 0)
            flags.push(`Pattern Violations: 🟡 ${input.review.violations.length} violation(s)`);
        for (const result of input.gateResults) {
            if (result.matchedFiles.length === 0) continue;
            const emoji = result.warningColor === 'red' ? '🔴' : '🟡';
            flags.push(`${result.name}: ${emoji} ${result.matchedFiles.length} file(s)`);
        }
        if (input.disables.webpiecesCount > 0) {
            const which =
                input.disables.webpiecesRules.length > 0
                    ? ` — ${input.disables.webpiecesRules.join(', ')}`
                    : '';
            flags.push(
                `Webpieces Disables Added: 🟡 ${input.disables.webpiecesCount} line(s)${which}`,
            );
        }
        if (input.disables.eslintCount > 0)
            flags.push(`ESLint Disables Added: 🟡 ${input.disables.eslintCount} line(s)`);
        // A triggered checklist is noteworthy in main's history — carry each into the commit body.
        for (const row of input.checklists) {
            flags.push(`Checklist — ${row.title}: ${this.checklistStatusText(row)}`);
        }
        return flags;
    }

    // Emoji + words for a checklist verdict, shared by the dashboard row and the commit-body flag.
    // Every state is matched EXPLICITLY and the fallthrough names the status it did not recognize. The
    // previous `return '🟢 passed'` fallthrough meant any newly-added verdict rendered as a clean pass on
    // both the PR body and main's commit history until someone noticed — exactly the wrong default.
    private checklistStatusText(row: ChecklistRow): string {
        if (row.status === CK_OVERRIDDEN) {
            const why = row.detail.trim() !== '' ? ` — override: ${row.detail.trim()}` : '';
            return `🟠 OVERRIDDEN${why}`;
        }
        if (row.status === CK_WARN) return '🟡 passed with concerns';
        if (row.status === CK_FAIL) return '🔴 FAILED review';
        if (row.status === CK_MISSING) return '⚪ not reviewed';
        if (row.status === CK_PASS) return '🟢 passed';
        return `⚪ unknown verdict (${row.status})`;
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
            if (ch === '*') {
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

    /**
     * The ONE rolled-up **Checklists:** row, coloured worst-of across every checklist that ran, in the same
     * shape as its neighbours (`**Build (nx affected):** 🟢 Passed`). Counts and names only — never a line
     * of reviewer output or override justification, which is the whole reason this row exists.
     */
    private checklistRollupLine(rows: readonly ChecklistRow[]): string {
        const buckets = this.rollupBuckets(rows);
        const filled = buckets.filter((b: RollupBucket): boolean => b.titles.length > 0);
        // NO reviewer ran ⇒ the SKIPPED icon, never green. Green claims something was checked and came back
        // clean; ⚪ says nobody looked, which is what a reader has to be able to tell apart at a glance.
        if (filled.length === 0) {
            return '**Checklists:** ⚪ 0 ran — no review checklist matched this PR · see the checklist comment';
        }
        const allPassed = filled.length === 1 && !filled[0].named;
        const detail = allPassed
            ? 'all passed'
            : filled.map((b: RollupBucket): string => this.bucketPhrase(b)).join(', ');
        return `**Checklists:** ${filled[0].emoji} ${rows.length} ran — ${detail} · per-checklist detail in the checklist comment`;
    }

    /**
     * The four severity buckets, WORST FIRST, so `filled[0]` is the roll-up colour: red beats orange beats
     * yellow beats green. The colours are the same vocabulary the comment already uses (see verdictEmoji).
     *
     * OVERRIDDEN is deliberately NOT folded into passed: an override is a human knowingly accepting a red
     * verdict, and a dashboard that painted that green would hide the single most review-worthy thing on
     * the PR. The blocking bucket is the FALLTHROUGH — CK_FAIL, CK_MISSING, CK_BAD_FORMAT and any verdict
     * added later all land there, matching review.json's own "not pass|warn|overridden ⇒ refuse" rule
     * rather than a second list that could silently drift green.
     */
    private rollupBuckets(rows: readonly ChecklistRow[]): RollupBucket[] {
        const blocking = new RollupBucket('blocking', '🔴', true);
        const overridden = new RollupBucket('overridden', '🟠', true);
        const warned = new RollupBucket('with concerns', '🟡', true);
        const passed = new RollupBucket('passed', '🟢', false);
        for (const row of rows) {
            if (row.status === CK_PASS) passed.titles.push(row.title);
            else if (row.status === CK_WARN) warned.titles.push(row.title);
            else if (row.status === CK_OVERRIDDEN) overridden.titles.push(row.title);
            else blocking.titles.push(row.title);
        }
        return [blocking, overridden, warned, passed];
    }

    // `2 overridden (a, b)` for the buckets a reviewer must act on; a bare `3 passed` for the one they need
    // no list of. Names are capped so a many-checklist repo still gets a ONE-LINE row.
    private bucketPhrase(bucket: RollupBucket): string {
        if (!bucket.named) return `${bucket.titles.length} ${bucket.label}`;
        return `${bucket.titles.length} ${bucket.label} (${this.compactNames(bucket.titles)})`;
    }

    private compactNames(titles: readonly string[]): string {
        const max = 4;
        if (titles.length <= max) return titles.join(', ');
        return `${titles.slice(0, max).join(', ')} +${titles.length - max} more`;
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
        const which =
            disables.webpiecesRules.length > 0 ? ` — ${disables.webpiecesRules.join(', ')}` : '';
        return `**Webpieces Disables Added:** 🟡 ${disables.webpiecesCount} line(s)${which}`;
    }
}
