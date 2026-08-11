import { CONFIG_FILENAME, LOGS_STATE_DIR, WEBPIECES_TMP_DIR, WORKTREE_STATE_DIR } from '@webpieces/rules-config';

import {
    L0AllowEntry, L0_ALLOWLIST, RESTORE_SHIM_CMD, SHIM_LOG_FIELDS, SHIM_LOG_VERDICTS, ShimLogField,
    ShimLogVerdict, UPGRADE_SHIM_CMD,
} from '../bin/shim';
import {
    ENV_SURFACE, GUARDS_BIN, REGISTRATION_SURFACE, RULES_BIN, SHIM_SURFACE, shimCommand,
} from '../bin/hook-registration';
import {
    L0FaultCode, L0_FAULT_NAMES, L0_JS_FAULT_CODES, L0_LAYER, L0_ROW_ALLOWLISTED, L0_ROW_BLOCKED,
    L0_ROW_HANDED_DOWN, L0_SH_FAULT_CODES,
} from './l0-fault-codes';
import {
    CALLS_STREAM, L0_SHIM_STREAM, L1_LOCATION_STREAM, L2_DECISIONS_STREAM, REJECTIONS_STREAM,
} from './log-streams';
import { L0Cure, L0Fault, L0_FAULTS } from './l0-matrix';

// ---------------------------------------------------------------------------
// THE GENERATED HALF OF guards/L0-tooling.md.
//
// That file is the largest guard doc in the repo and, unlike its two siblings, it was hand-written from
// end to end — so it went stale twice in one session: it described FOUR managed surfaces after there
// were three, and a 7-field audit line after `shim=`/`bin=`/`layer=`/`row=` had joined it.
//
// The split, and WHY it is a split rather than a whole-file renderer:
//
//   GENERATED (here)      anything that is a COORDINATE of the code — the fault codes and their guard
//                         names, the cures, the three matrix rows, the allowlist, the managed surfaces,
//                         the audit-line fields and the verdict vocabulary. Every one of those is
//                         already an array somewhere; a doc that re-types them is a second spelling.
//   HAND-WRITTEN (there)  the incident histories, the config-validation invariant, the known gaps, the
//                         worked example. That is argument, not data, and a renderer would mangle it.
//
// The section is spliced BETWEEN two literal markers, the pattern renderL1Doc() already uses for its
// prose/table interleave, so the prose surrounds the tables instead of being swallowed by them.
// `pnpm guards:generate` rewrites the block and `l0-tooling-doc.spec.ts` locks it byte-for-byte.
//
// EVERY COMMAND PRINTED HERE COMES FROM A CONSTANT, never a retyped literal: the L0 allowlist matches
// WHOLE command strings, so a paraphrased cure in a doc is an unrunnable cure. The spec re-asserts that
// by running isAllowed() over every command this renderer prints.
// ---------------------------------------------------------------------------

/** Opening marker of the generated block, as it appears in guards/L0-tooling.md. */
export const L0_DOC_BEGIN = '<!-- BEGIN GENERATED — L0ToolingDoc.render() in ai-hook-rules/src/core/l0-tooling-doc.ts; run `pnpm guards:generate` -->';

/** Closing marker. Everything between the two is machine-owned; everything outside is prose. */
export const L0_DOC_END = '<!-- END GENERATED — hand-written prose resumes here -->';

/**
 * The generated section of guards/L0-tooling.md, and the splice that puts it there.
 *
 * A class rather than a family of module functions (see l1-doc.ts, which predates the rule): the
 * renderer, the extractor and the splicer are one unit, and the spec drives all three.
 */
export class L0ToolingDoc {
    /** The whole generated block, WITHOUT the markers — those belong to the file, not to the renderer. */
    render(): string {
        return [
            ...this.preamble(),
            ...this.faultTable(),
            ...this.fixTable(),
            ...this.matrixTable(),
            ...this.allowlistTable(),
            ...this.managedSurface(),
            ...this.auditLine(),
        ].join('\n');
    }

    /**
     * The generated text of `doc`, exactly as committed. Throws when a marker is missing or doubled —
     * a silently-unspliced doc is the drift this whole arrangement exists to end.
     */
    extract(doc: string): string {
        const opens = doc.split(L0_DOC_BEGIN).length - 1;
        const closes = doc.split(L0_DOC_END).length - 1;
        if (opens !== 1 || closes !== 1) {
            throw new Error(`guards/L0-tooling.md must carry exactly one BEGIN/END marker pair, found ${String(opens)}/${String(closes)}`);
        }
        const afterBegin = doc.slice(doc.indexOf(L0_DOC_BEGIN) + L0_DOC_BEGIN.length);
        return afterBegin.slice(0, afterBegin.indexOf(L0_DOC_END)).replace(/^\n/, '').replace(/\n$/, '');
    }

    /** `doc` with the generated block replaced by today's render. Preserves every byte outside it. */
    splice(doc: string): string {
        const head = doc.slice(0, doc.indexOf(L0_DOC_BEGIN) + L0_DOC_BEGIN.length);
        const tail = doc.slice(doc.indexOf(L0_DOC_END));
        // extract() is called for its VALIDATION — one marker pair — before anything is rewritten.
        this.extract(doc);
        return `${head}\n${this.render()}\n${tail}`;
    }

    /** A markdown cell: a literal `|` inside a value would end the column. */
    private cell(value: string): string {
        return value.split('|').join('\\|');
    }

    private preamble(): string[] {
        return [
            '> **GENERATED — do not hand-edit between the markers.** Rendered by `L0ToolingDoc.render()`',
            '> (`ai-hook-rules/src/core/l0-tooling-doc.ts`) from `L0_FAULTS`, `L0_ALLOWLIST`, the managed-surface',
            '> constants and `SHIM_LOG_FIELDS` — the same arrays the guard consults. `pnpm guards:generate`',
            '> rewrites it; `l0-tooling-doc.spec.ts` locks it byte-for-byte. The prose outside the markers is',
            '> hand-written and stays that way.',
            '',
        ];
    }

    private faultTable(): string[] {
        return [
            '### The faults',
            '',
            '| code | guard name | fault | detected by | enforced in |',
            '|---|---|---|---|---|',
            ...L0_FAULTS.map((f: L0Fault): string =>
                `| \`${f.code}\` | \`${L0_FAULT_NAMES[f.code as L0FaultCode]}\` | ${this.cell(f.name)} | ${f.detectedBy} | ${f.enforcedIn} |`),
            '',
            `First match wins. \`${L0_SH_FAULT_CODES.join('`/`')}\` are decided in POSIX \`sh\` inside the committed shim, BEFORE`,
            `the guard bin runs — a stale, missing or broken validator cannot be trusted to validate itself.`,
            `\`${L0_JS_FAULT_CODES.join('`/`')}\` are decided inside the bin, in JS.`,
            '',
        ];
    }

    /**
     * The cures, one row per option. LITERAL commands only, rendered from `L0_FAULTS[].cures` — the same
     * array `webpieces.guard-matrix.md` renders its Fix sections from, so the two can never prescribe
     * different commands for one fault.
     */
    private fixTable(): string[] {
        const rows: string[] = [];
        for (const fault of L0_FAULTS) {
            fault.cures.forEach((cure: L0Cure, i: number): void => {
                const literal = cure.isCommand() ? `\`${cure.call.command}\`` : `edit \`${cure.mention}\` yourself`;
                const option = `${String(i + 1)}${cure.preferred ? ' (preferred)' : ''}`;
                rows.push(`| \`${fault.code}\` | ${option} | ${this.cell(literal)} | ${this.cell(cure.discriminator)} |`);
            });
        }
        return [
            '### The fix, per fault — type the option EXACTLY as written, and run nothing else on that line',
            '',
            '| fault | option | run EXACTLY | pick this when |',
            '|---|---|---|---|',
            ...rows,
            '',
        ];
    }

    private matrixTable(): string[] {
        return [
            '### The matrix — three rows, and the fault only picks the MESSAGE',
            '',
            `| row | fault | on the allowlist? | outcome | logged as |`,
            '|---|---|---|---|---|',
            `| ${L0_ROW_HANDED_DOWN} | none | — | hand down to the next guard layer | \`layer=${L0_LAYER} row=${L0_ROW_HANDED_DOWN}\` |`,
            `| ${L0_ROW_ALLOWLISTED} | any | yes | PASS or ALLOW (see the entry) | \`layer=${L0_LAYER} row=${L0_ROW_ALLOWLISTED}\` |`,
            `| ${L0_ROW_BLOCKED} | any | no | BLOCK — **only the message varies by fault** | \`layer=${L0_LAYER} row=${L0_ROW_BLOCKED}\` |`,
            '',
            'The tool is not a dimension either: "any Read" is an allowlist ENTRY, not a tool check. Those are',
            'the same coordinates every L0 deny opens with, so a deny, a log line and this table join by eye.',
            '',
        ];
    }

    private allowlistTable(): string[] {
        return [
            '### The allowlist — ONE list, consulted identically by every fault',
            '',
            '| # | allowed | outcome | bypasses L1 on a HEALTHY tree? |',
            '|---|---|---|---|',
            ...L0_ALLOWLIST.map((e: L0AllowEntry, i: number): string =>
                `| ${String(i + 1)} | ${this.cell(e.label)} | ${e.kind.toUpperCase()} | ${e.cure ? 'yes — it REPAIRS the tooling' : 'no — it repairs nothing, so L1 still judges it'} |`),
            '',
            '- **PASS** — L0 has no objection; the call falls THROUGH so downstream guards still judge it.',
            '- **ALLOW** — terminal; bypasses everything, because a cure must stay reachable even when a',
            '  downstream guard would block it.',
            '',
            'Every Bash entry is anchored to the WHOLE command. A leading `cd <dir> &&`, a trailing `2>&1` and a',
            'pipe into `tail`/`head` are tolerated; nothing else. Appending `&& git status` makes it a DIFFERENT',
            'command and it is rejected again — that is not the guard refusing its own cure.',
            '',
            '`git merge` and a **bare** `git pull` are both deliberately absent — see "The git-sync split"',
            'below for why the one safe pull spelling is on the list and the bare one is not. Main is merged',
            'ONLY through the 3-point fork merge (`pnpm wp-start-update`, or `pnpm wp-start-upsert-pr` when a',
            'PR is already open).',
            '',
        ];
    }

    /**
     * Fault `S`'s subject: the THREE managed things, and the two registrations rendered from
     * `shimCommand()` — which is what makes "they are ABSOLUTE" a fact this doc cannot get wrong.
     */
    private managedSurface(): string[] {
        return [
            '### The managed hook surface — what fault `S` compares (THREE things, one set)',
            '',
            '| # | surface |',
            '|---|---|',
            `| 1 | \`${SHIM_SURFACE}\` |`,
            `| 2 | ${this.cell(REGISTRATION_SURFACE)} |`,
            `| 3 | ${this.cell(ENV_SURFACE)} |`,
            '',
            'The registration is TWO PreToolUse entries, and both are ABSOLUTE — they resolve from any cwd:',
            '',
            '```',
            shimCommand(GUARDS_BIN),
            shimCommand(RULES_BIN),
            '```',
            '',
            `\`${UPGRADE_SHIM_CMD}\` repairs all three. \`${RESTORE_SHIM_CMD}\``,
            `repairs \`${SHIM_SURFACE}\` and nothing else, so it is the fallback for an installed release too old`,
            'to carry the first.',
            '',
        ];
    }

    /**
     * The audit line, rendered from `SHIM_LOG_FIELDS` + `SHIM_LOG_VERDICTS`. The optional field prints
     * in brackets because that is exactly what it is: `bin=` appears only when it differs from `shim=`.
     */
    private auditLine(): string[] {
        const shape = SHIM_LOG_FIELDS.map((f: ShimLogField): string => (f.optional ? `[${f.label}]` : f.label)).join('  ');
        return [
            '### The L0 audit line — one tab-separated line per tool call',
            '',
            '```',
            shape,
            '```',
            '',
            '| # | field | means |',
            '|---|---|---|',
            ...SHIM_LOG_FIELDS.map((f: ShimLogField, i: number): string =>
                `| ${String(i + 1)} | \`${this.cell(f.label)}\` | ${this.cell(f.means)} |`),
            '',
            '| verdict | means |',
            '|---|---|',
            ...SHIM_LOG_VERDICTS.map((v: ShimLogVerdict): string => `| \`${v.label}\` | ${this.cell(v.means)} |`),
            '',
            ...this.logPaths(),
        ];
    }

    private logPaths(): string[] {
        const stream = `${LOGS_STATE_DIR}/${L0_SHIM_STREAM}/<session>-<agent|coordinator>-<binName>.log`;
        return [
            'It lands in the log directory of the tree the CALL was made in, centralized under the primary clone',
            'so that removing a worktree does not take its audit trail with it:',
            '',
            '```',
            `<primary>/${WEBPIECES_TMP_DIR}/${WORKTREE_STATE_DIR}/<tree>/${stream}`,
            `<primary>/${WEBPIECES_TMP_DIR}/${stream}   # from the primary clone itself`,
            '```',
            '',
            `The binary stamps the same \`layer=\`/\`row=\`/\`fault=\` fields onto its OWN streams —`,
            `\`${L1_LOCATION_STREAM}/\`, \`${L2_DECISIONS_STREAM}/\`, \`${CALLS_STREAM}/\` and \`${REJECTIONS_STREAM}/\` under the same`,
            `\`${LOGS_STATE_DIR}/\` — so one grep spans the whole trail. A \`${CONFIG_FILENAME}\` fault (\`C\`/\`Y\`) is`,
            'therefore visible there and never on an `L0-shim` line, which only ever carries the `sh`-side codes.',
            '',
        ];
    }
}
