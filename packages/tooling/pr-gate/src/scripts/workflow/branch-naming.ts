// Branch-naming for the numbered-generation squash-merge scheme.
//
// A feature branch has a stable *base* identity plus a *generation* marker that bumps every time we
// re-sync from main:  base → basewp2 → basewp3 …  (gen 1 carries no marker). The remote branch — and
// therefore the single PR — always lives on `base`; only the LOCAL branch numbers up, so you can see
// at a glance how many times you've re-merged main. The pre-merge safety snapshot is
// `<currentBranch>PreMerge` (one overwritable slot per generation), replacing the old ever-accumulating
// `<branch>Backup1/Backup2/…`.
//
// The generation marker is `wp<N>` (a literal `wp` prefix, NOT a bare number) so it is unambiguous
// against branch names that naturally end in digits — most importantly version-upgrade branches like
// `deanhiller/upgrade-webpieces-0.3.213`, which an earlier bare-digit scheme mangled by stripping the
// `213`. Parsing keys off the `wp` marker: strip a trailing `Squash` (the internal temp-branch suffix),
// then a trailing `wp<digits>`. The branch-creation-guard rejects human branches ending in `wp<digits>`
// so the marker stays reserved for this tool.

const GENERATION_RE = /^(.*)wp(\d+)$/;

class Generation {
    base: string;
    gen: number;

    constructor(base: string, gen: number) {
        this.base = base;
        this.gen = gen;
    }
}

function parseGeneration(branch: string): Generation {
    const withoutSquash = branch.replace(/Squash$/, '');
    const match = withoutSquash.match(GENERATION_RE);
    if (match && match[1] !== '') {
        return new Generation(match[1], parseInt(match[2], 10));
    }
    return new Generation(withoutSquash, 1);
}

/** Stable base identity (remote / PR / feature-name slug source): trailing `Squash` and the
 *  generation marker stripped. `base` → `base`, `basewp2` → `base`, `basewp2Squash` → `base`. */
export function baseBranchName(branch: string): string {
    return parseGeneration(branch).base;
}

/** The local branch you land on after this merge: base + `wp` + (gen + 1). `base` → `basewp2`,
 *  `basewp2` → `basewp3`. */
export function nextBranchName(branch: string): string {
    const generation = parseGeneration(branch);
    return `${generation.base}wp${generation.gen + 1}`;
}

/** Pre-merge safety snapshot of the given (current) branch. One overwritable slot per branch. */
export function preMergeBackupName(branch: string): string {
    return `${branch}PreMerge`;
}
