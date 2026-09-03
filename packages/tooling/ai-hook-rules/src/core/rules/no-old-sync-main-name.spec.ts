import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { describe, it, expect } from 'vitest';

/**
 * THE CREEP-BACK GUARD FOR THE `wp-sync-main` RENAME.
 *
 * `wp-sync-main` used to carry a three-verb name that said "checkout", "clean" and "main" in one
 * breath — which reads as a destructive git operation on the trunk, something that throws away your
 * working tree. It is not one. The name overstated the blast radius and misled humans first, so it was
 * renamed HARD: no alias, no deprecation, no delegating shim (CLAUDE.md § "NO webpieces surface is
 * released backwards-compatible", shim shapes #1 and #2).
 *
 * WHY A TEST AND NOT A CODE REVIEW. The dead name lived in 146 places across 37 files, and most of them
 * were GUARD CURE STRINGS — the sentences an agent is handed at the moment every other route is closed.
 * A stale cure is worse than no cure: it names a command that does not exist, on the one path where the
 * reader is already blocked and cannot go exploring. That failure mode is invisible in a diff (a new
 * cure string reads perfectly well on its own) and only surfaces to somebody who is already stuck. So
 * the invariant is asserted mechanically instead: the dead spelling exists NOWHERE in tracked source,
 * docs, templates or specs.
 *
 * WHY THIS FILE NEVER WRITES THE DEAD NAME OUT, not even in a comment. If it did, it would have to
 * exempt itself, and a scan with a hole in it is a scan somebody eventually widens. `DeadSpellings`
 * assembles the tokens from fragments and the assertion message interpolates them, so the guard needs
 * no exemption and is its own proof. Keep it that way when editing: spell the LIVE names.
 *
 * THE TWO EXEMPTED TREES, and why each is a record rather than an instruction:
 *   • `docs/audit/**` — dated audit reports quoting commands agents actually typed on the day.
 *     Rewriting them would falsify the transcript they exist to preserve.
 *   • `backlog/**` — the proposal that asked for this rename, kept together with its own rejected
 *     "keep a deprecated alias" suggestion so the reasoning survives alongside the decision.
 * Nothing reads either tree as a cure, which is the whole test for whether a mention is harmless.
 */

/** One tracked file that still names the dead command, with the token it names and the line it is on. */
class OldNameHit {
    constructor(
        public readonly file: string,
        public readonly token: string,
        public readonly line: number,
        public readonly text: string,
    ) {}

    render(): string {
        return `${this.file}:${this.line}  names "${this.token}"\n    ${this.text.trim()}`;
    }
}

/**
 * The dead spellings, assembled rather than written — see the docblock. Between them they cover the
 * bin and every cure string that named it, the two renamed source files, the command class, and the
 * injected field and the `PrGateApp` method that fronted it.
 */
class DeadSpellings {
    static readonly KEBAB = ['checkout', 'clean', 'main'].join('-');
    static readonly CLASS = ['Checkout', 'Clean', 'Main'].join('');
    static readonly CAMEL = ['checkout', 'Clean', 'Main'].join('');

    static all(): readonly string[] {
        return [DeadSpellings.KEBAB, DeadSpellings.CLASS, DeadSpellings.CAMEL];
    }
}

/** The LIVE spellings, named in the failure message so the fix is the thing you read. */
const LIVE_NAMES = '`wp-sync-main`, `SyncMainCommand`, `syncMainCommand` and `sync-main-command.ts`';

/** Tracked trees whose mentions are HISTORY, not instruction. See the docblock. */
const RECORD_PREFIXES: readonly string[] = ['docs/audit/', 'backlog/'];

class OldNameScan {
    constructor(private readonly repoRoot: string) {}

    /** Every tracked file that still names a dead spelling, outside the two record trees. */
    hits(): readonly OldNameHit[] {
        const found: OldNameHit[] = [];
        for (const file of this.trackedFiles()) {
            if (RECORD_PREFIXES.some((prefix: string): boolean => file.startsWith(prefix))) continue;
            found.push(...this.hitsIn(file));
        }
        return found;
    }

    /**
     * Read as text and scan line by line. A binary blob decodes to mojibake rather than throwing, and
     * mojibake cannot contain these ASCII tokens — so no extension filter is needed to keep it honest.
     */
    private hitsIn(file: string): readonly OldNameHit[] {
        const lines = fs.readFileSync(path.join(this.repoRoot, file), 'utf8').split('\n');
        const found: OldNameHit[] = [];
        for (let index = 0; index < lines.length; index++) {
            for (const token of DeadSpellings.all()) {
                if (lines[index].includes(token)) found.push(new OldNameHit(file, token, index + 1, lines[index]));
            }
        }
        return found;
    }

    /** Every path git tracks, NUL-separated so a path with a space or a quote cannot split wrong. */
    trackedFiles(): readonly string[] {
        const listing = execFileSync('git', ['ls-files', '-z'],
            { cwd: this.repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        return listing.split('\0').filter((entry: string): boolean => entry !== '');
    }

    /** The repo root, from this file's location — vitest's cwd is the project, not the workspace. */
    static resolveRepoRoot(from: string): string {
        return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: from, encoding: 'utf8' }).trim();
    }
}

describe(`the pre-rename spelling of wp-sync-main (wp-${DeadSpellings.KEBAB}) is gone`, () => {
    const scan = new OldNameScan(OldNameScan.resolveRepoRoot(__dirname));

    it('appears in no tracked file outside docs/audit and backlog', () => {
        const report = scan.hits().map((hit: OldNameHit): string => hit.render()).join('\n');
        expect(report, `The command is called \`wp-sync-main\`. Its dead spelling came back in:\n${report}\n\n`
            + 'It was renamed HARD — there is no alias and no deprecation period, so a cure string, doc\n'
            + `or symbol naming the dead one points at a command that does not exist. Use ${LIVE_NAMES}.`)
            .toBe('');
    });

    it('scans a meaningful number of files, so a broken listing cannot pass silently', () => {
        // An empty or failed `git ls-files` would make the assertion above vacuously green. This repo
        // tracks thousands of files; a hundred is a floor no healthy checkout can fall below.
        expect(scan.trackedFiles().length).toBeGreaterThan(100);
    });
});
