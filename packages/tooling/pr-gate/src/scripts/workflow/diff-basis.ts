import { spawnSync } from 'child_process';
import { injectable, bindingScopeValues } from 'inversify';
import { ForkPoint } from './git-findForkPoint';

/**
 * The ONE resolved answer to "what exactly is this branch's diff, and what command reproduces it?"
 *
 * It exists because the two halves of the review flow used to disagree. `ChecklistScanner` computes the
 * changed-FILE set by calling `getChangedFiles` with NO head — base→WORKING TREE, unioning in untracked
 * files — while `ChecklistInstructionsService` printed `git diff <base> HEAD -- <file>` to every
 * reviewer. On a dirty tree those are different ranges, and the printed command returns NOTHING: a reviewer
 * is handed a file list and a command that shows it nothing. That is not hypothetical — a reviewer subagent
 * on monorepo-nx2 ran the printed command, got empty output, and had to guess its way to `git diff HEAD`.
 *
 * So the command is DERIVED from the same basis the file set is, and no caller writes one by hand.
 *
 * Data-only (per CLAUDE.md).
 */
export class DiffBasis {
    // The 3-point fork point of main. '' when neither origin/main nor main resolves.
    // Alias of {@link hashForkPoint} — see the hash-point trio below.
    base: string;
    // The REAL sha, never the literal string 'HEAD'. A recorded 'HEAD' is worthless the moment a commit
    // lands on top of it, and the stage receipt has to compare shas to know the tree moved under a review.
    // Alias of {@link hashFeatureHead}.
    headSha: string;
    /**
     * The SAME three hash points the 3-point merge records, under the SAME names
     * (`merge-info/<branch>/updatemain-hashes.json` → hashForkPoint / hashFeatureHead / hashMainHead).
     *
     * Two reasons this matters. First, vocabulary: the merge half of the system said "hashForkPoint"
     * while the review half said "base" for the identical sha, so nothing could be grepped across both.
     * Second, and the real gap: the review side recorded only TWO of the three. Without `hashMainHead`
     * nothing downstream can answer "did main move while this branch was under review?" — which is
     * exactly what you want to know when a review looks stale or a merge is about to surprise you.
     *
     * `hashMainHead` is '' when origin/main cannot be resolved offline; it is a REPORT, never a gate.
     */
    hashForkPoint: string;
    hashFeatureHead: string;
    hashMainHead: string;
    // True when the diff includes staged/unstaged/untracked work, i.e. the range is base→working tree.
    dirty: boolean;
    // Exactly WHICH paths make it dirty, so a message can name them instead of asserting dirtiness.
    dirtyFiles: string[];
    // The command that reproduces the WHOLE diff. Correct for both clean and dirty; see DiffBasisResolver.
    diffCommand: string;
    // The same command with a `-- <file>` tail — what every reviewer instruction prints.
    fileDiffCommand: string;

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(base = '', headSha = '', dirty = false, dirtyFiles: string[] = [], diffCommand = '', fileDiffCommand = '', hashMainHead = '') {
        this.base = base;
        this.headSha = headSha;
        this.dirty = dirty;
        this.dirtyFiles = dirtyFiles;
        this.diffCommand = diffCommand;
        this.fileDiffCommand = fileDiffCommand;
        // The trio is DERIVED from base/headSha rather than passed separately, so the two names for one
        // sha cannot drift apart into disagreeing values.
        this.hashForkPoint = base;
        this.hashFeatureHead = headSha;
        this.hashMainHead = hashMainHead;
    }

    // True when there is no usable base — callers must SAY so rather than print a command that cannot work.
    get unresolved(): boolean {
        return this.base.trim() === '';
    }
}

/**
 * Resolves {@link DiffBasis} for a repo. Injects {@link ForkPoint} so the base is the SAME fork-point
 * computation the checklist matching uses — never `DiffScope.resolveBase`, which overlays NX_BASE/NX_HEAD
 * from the environment and would make review coverage depend on an env var.
 *
 * `@injectable(bindingScopeValues.Singleton)` so it is injected by type and drawn in the DI design.
 */
@injectable(bindingScopeValues.Singleton)
export class DiffBasisResolver {
    constructor(private readonly forkPoint: ForkPoint) {}

    /**
     * Resolve the basis. The command shape is the whole point:
     *
     *   clean tree → `git diff <base> <headSha>`   (commit-to-commit; reproducible later, unlike 'HEAD')
     *   dirty tree → `git diff <base>`             (NO head — this is what includes the working tree)
     *
     * Omitting the head on a dirty tree is not a shortcut, it is the only form that shows uncommitted work,
     * and supplying `HEAD` there is precisely the bug this class exists to make unrepresentable.
     */
    resolve(repoRoot: string): DiffBasis {
        const base = this.forkPoint.resolveForkPoint(repoRoot);
        const headSha = this.gitOut(repoRoot, ['rev-parse', 'HEAD']);
        // Point C. Deliberately does NOT fetch — this must work offline, like resolveForkPoint. So it is
        // main as this clone last saw it, which is the honest answer to "has main moved under me?" that a
        // local command can give. '' when origin/main is unknown (no remote yet).
        const mainHead = this.gitOut(repoRoot, ['rev-parse', 'origin/main']);
        const dirtyFiles = this.dirtyPaths(repoRoot);
        const dirty = dirtyFiles.length > 0;
        if (base === '') return new DiffBasis('', headSha, dirty, dirtyFiles, '', '', mainHead);
        const whole = dirty ? `git diff ${base}` : `git diff ${base} ${headSha}`;
        return new DiffBasis(base, headSha, dirty, dirtyFiles, whole, `${whole} -- <file>`, mainHead);
    }

    /**
     * Every path that makes the tree dirty: tracked modifications/staged changes PLUS untracked files.
     * Untracked must be included — `git status --porcelain` reports them as `??`, and they are exactly the
     * files a brand-new migration or terraform rule arrives as, which is when a checklist most wants to fire.
     */
    private dirtyPaths(repoRoot: string): string[] {
        const out = this.gitOut(repoRoot, ['status', '--porcelain', '--untracked-files=all']);
        if (out === '') return [];
        const paths: string[] = [];
        for (const line of out.split('\n')) {
            // Porcelain v1: 2 status chars, a space, then the path. A rename reads `R  old -> new`; the new
            // name is the one that exists on disk, so it is the one a reviewer can open.
            const raw = line.slice(3).trim();
            if (raw === '') continue;
            const arrow = raw.indexOf(' -> ');
            paths.push(arrow === -1 ? raw : raw.slice(arrow + 4));
        }
        return paths;
    }

    private gitOut(repoRoot: string, args: string[]): string {
        const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
        return result.status === 0 ? (result.stdout ?? '').trim() : '';
    }
}
