import * as path from 'path';

import { ExcludePaths } from '@webpieces/rules-config';

import { CommandScanner } from './command-scan';
import { globMatches } from './load-rules';

/**
 * One path the denied command NAMED that `excludePaths` already exempts, plus how to reach it.
 *
 * Data-only, so a class (per CLAUDE.md).
 *
 * `cdDirectory` is the whole point of the class rather than a bare string: it is a directory that
 * ITSELF satisfies `globMatches` against one of the configured globs, or null when no such directory
 * exists for this reference. Callers must never invent one — see ExcludedPathEscapeScan for why a
 * naive `dirname` is wrong exactly when it looks most obviously right.
 */
export class ExcludedPathReference {
    /** The referenced path, workspace-relative, as it was matched. */
    readonly referencedPath: string;
    /** The `excludePaths` glob that matched it — quoted back so the agent need not re-derive it. */
    readonly matchedGlob: string;
    /** A directory a `cd` may legally land in (matches a glob on its own), or null when none does. */
    readonly cdDirectory: string | null;
    /** `referencedPath` re-expressed relative to `cdDirectory`; '' when there is no `cdDirectory`. */
    readonly pathFromCdDirectory: string;

    constructor(
        referencedPath: string,
        matchedGlob: string,
        cdDirectory: string | null,
        pathFromCdDirectory: string,
    ) {
        this.referencedPath = referencedPath;
        this.matchedGlob = matchedGlob;
        this.cdDirectory = cdDirectory;
        this.pathFromCdDirectory = pathFromCdDirectory;
    }
}

/**
 * Finds the paths a BASH command names that the top-level `excludePaths` already exempts.
 *
 * WHY this exists: the bash guards judge the shell's effective CWD, not the paths in the command, so
 * `cat .webpieces/tasks.md` at the repo root is DENIED even though that exact file is exempt from
 * every guard and was reachable, that instant, through Read/Write. Every remedy the deny body printed
 * was a git state change — strictly more destructive than the one it omitted. This class supplies the
 * missing sentence; it changes no verdict.
 *
 * A token is treated as a candidate path with no filesystem check: whether it exists says nothing
 * about whether it is exempt, and a stat per token on the blocking hook path is exactly the cost these
 * guards avoid. Non-path tokens (a `grep` pattern, a `sed` script) simply match no glob.
 */
export class ExcludedPathEscapeScan {
    private readonly scanner: CommandScanner;
    private readonly workspaceRoot: string;
    private readonly effectiveCwd: string;

    /**
     * `effectiveCwd` is the directory the command really runs in, after its own leading `cd` — the
     * same base ContentReadScan resolves relative operands against. RELATIVE tokens are resolved
     * there and ABSOLUTE ones normalised straight to workspace-relative, which is how
     * `cat /abs/path/to/repo/.webpieces/tasks.md` reaches the same verdict as `cat .webpieces/tasks.md`.
     */
    constructor(scanner: CommandScanner, workspaceRoot: string, effectiveCwd: string) {
        this.scanner = scanner;
        this.workspaceRoot = workspaceRoot;
        this.effectiveCwd = effectiveCwd;
    }

    /**
     * Every excluded path this command references, in command order, de-duplicated.
     *
     * Scans EVERY segment, not just a leading `cd`: `cat x`, `grep -n foo x`, `sed -n '1,5p' x` and a
     * path inside an `&&` compound all count, because the agent's next move depends on the file it
     * wanted, wherever in the line it named it.
     */
    references(command: string, ex: ExcludePaths): readonly ExcludedPathReference[] {
        if (ex.paths.length === 0) return [];

        const found: ExcludedPathReference[] = [];
        const seen = new Set<string>();
        for (const token of this.candidateTokens(command)) {
            const relative = this.workspaceRelative(token);
            if (relative === null || seen.has(relative)) continue;
            seen.add(relative);
            const glob = this.matchingGlob(relative, ex);
            if (glob === null) continue;
            found.push(this.reference(relative, glob, ex));
        }
        return found;
    }

    // Build the reference, including the `cd` target — the ONE subtle part, see cdDirectory below.
    private reference(relative: string, glob: string, ex: ExcludePaths): ExcludedPathReference {
        const dir = this.cdDirectory(relative, ex);
        return new ExcludedPathReference(
            relative, glob, dir, dir === null ? '' : path.relative(dir, relative),
        );
    }

    /**
     * A directory the agent may `cd` into and have the guards actually stand down, or null.
     *
     * THE TRAP: the bash path matches the relative cwd with `globMatches`, which compiles
     * `.webpieces/**` to the anchored `/^\.webpieces\/.*$/` — the `/` is a LITERAL, so the bare
     * directory `.webpieces` does NOT match its own glob. `cd .webpieces && cat tasks.md` is still
     * denied. Emitting that would be worse than emitting nothing: it looks authoritative and costs a
     * turn to disprove. So the directory is only offered when it passes the very same matcher the
     * runner will use, and the renderer says so plainly when nothing does.
     */
    private cdDirectory(relative: string, ex: ExcludePaths): string | null {
        const dir = path.dirname(relative);
        if (dir === '.' || dir === '' || dir === relative) return null;
        return this.matchingGlob(dir, ex) === null ? null : dir;
    }

    // The first configured glob this workspace-relative path satisfies, under the runner's OWN matcher
    // (globMatches, load-rules.ts) — never a looser one, or the stanza would promise an exemption the
    // guards do not grant.
    private matchingGlob(relative: string, ex: ExcludePaths): string | null {
        for (const pattern of ex.paths) {
            if (globMatches(pattern, relative)) return pattern;
        }
        return null;
    }

    /**
     * Workspace-relative form of a token, or null when it is not a path inside this workspace.
     *
     * `~`-rooted and out-of-tree paths are nothing to do with this repo's exclusions, and the
     * workspace root itself ('') matches no glob by construction.
     */
    private workspaceRelative(token: string): string | null {
        const cleaned = token.replace(REDIRECT_PREFIX, '');
        if (cleaned === '' || cleaned.startsWith('~')) return null;
        const absolute = path.isAbsolute(cleaned) ? cleaned : path.resolve(this.effectiveCwd, cleaned);
        const relative = path.relative(this.workspaceRoot, absolute);
        if (relative === '' || relative.startsWith('..')) return null;
        return relative;
    }

    /**
     * Every token that could name a file: each segment's words minus the command word itself and
     * minus flags. Deliberately generous — a token that is not a path matches no glob, while a token
     * dropped by a cleverer filter is a file the agent is never told it can read.
     */
    private candidateTokens(command: string): readonly string[] {
        const tokens: string[] = [];
        for (const segment of this.scanner.commandSegments(command)) {
            const words = this.scanner.words(segment);
            for (let i = 1; i < words.length; i++) {
                if (words[i].startsWith('-')) continue;
                tokens.push(words[i]);
            }
        }
        return tokens;
    }
}

// A redirection glued to its target (`>out.log`, `2>>err.log`, `<in.txt`) — strip the operator so the
// target is scanned as the path it is.
const REDIRECT_PREFIX = /^\d*(?:>>?|<)/;

/**
 * Renders the leading stanza of a bash deny body: the Read/Write escape the agent already has, and —
 * when one genuinely exists — the `cd` that makes bash itself work.
 *
 * It goes at the TOP of the report, above the git remedies, because the agent acts on the first
 * actionable thing it reads. The live incident this fixes had the agent create a branch in a human's
 * working tree to record a row in a gitignored scratch file; the cheap, side-effect-free path was one
 * sentence away and never printed. Returns '' when the command names no excluded path, so a repo
 * without exemptions — and every command that names nothing exempt — sees no extra noise.
 */
export class ExcludedPathEscapeHint {
    private readonly scan: ExcludedPathEscapeScan;

    /** `effectiveCwd` is the directory the command really runs in — see ExcludedPathEscapeScan. */
    constructor(workspaceRoot: string, effectiveCwd: string) {
        this.scan = new ExcludedPathEscapeScan(new CommandScanner(), workspaceRoot, effectiveCwd);
    }

    render(command: string, ex: ExcludePaths): string {
        const references = this.scan.references(command, ex);
        if (references.length === 0) return '';

        const lines: string[] = [];
        lines.push('✅ YOU CAN USE THE READ/WRITE TOOLS RIGHT NOW — no git operation needed.');
        lines.push('   These paths are in excludePaths and are exempt from every guard:');
        for (const glob of ex.paths) lines.push(`     ${glob}`);
        lines.push(`   Your command referenced: ${references.map((r: ExcludedPathReference): string => r.referencedPath).join(', ')}`);
        lines.push('   Use Read/Write/Edit on it instead of bash. The remedies below are only');
        lines.push('   needed for files OUTSIDE those directories.');
        lines.push('');
        for (const line of this.bashLines(references)) lines.push(line);
        lines.push('');
        return lines.join('\n');
    }

    // The bash half: the `cd` when one matches, and the honest refusal to invent one when none does.
    private bashLines(references: readonly ExcludedPathReference[]): readonly string[] {
        const withCd = references.find((r: ExcludedPathReference): boolean => r.cdDirectory !== null);
        if (withCd === undefined) return this.noCdLines(references[0]);

        return [
            '✅ OR KEEP USING BASH — put a `cd` into the excluded tree FIRST:',
            `     cd ${String(withCd.cdDirectory)} && <your command, writing \`${withCd.referencedPath}\` as \`${withCd.pathFromCdDirectory}\`>`,
            '   The guard resolves a LEADING `cd` and judges that directory, so this runs.',
            '   It must be the first thing in the command: no leading VAR= assignment,',
            '   no subshell wrapper — those defeat the resolution.',
        ];
    }

    // No directory on the way to the file matches a glob on its own, so there is no `cd` to offer.
    // Say WHY and give the one-line config edit that would create one, rather than printing a `cd`
    // that would be denied.
    private noCdLines(first: ExcludedPathReference): readonly string[] {
        const dir = path.dirname(first.referencedPath);
        return [
            '⚠️  A `cd` CANNOT rescue bash here, so do not try one.',
            `   \`${dir}\` (the directory itself) matches no excludePaths glob: \`${first.matchedGlob}\` compiles to`,
            '   an anchored regex whose `/` is literal, so the bare directory fails it and a `cd` into',
            '   it is STILL denied. That form is deliberately not printed here — it looks right and is not.',
            '   Use Read/Write/Edit above — or, to make bash work here too, list the bare directory',
            `   alongside the glob in webpieces.config.json → excludePaths: ["${dir}", "${first.matchedGlob}"]`,
        ];
    }
}
