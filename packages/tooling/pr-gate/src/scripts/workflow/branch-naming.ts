// Branch-naming for the numbered-generation squash-merge scheme.
//
// A feature branch has a stable *base* identity plus a visible *generation* number that bumps
// every time we re-sync from main:  base → base2 → base3 …  (gen 1 carries no suffix). The
// remote branch — and therefore the single PR — always lives on `base`; only the LOCAL branch
// numbers up, so you can see at a glance how many times you've re-merged main. The pre-merge
// safety snapshot is `<currentBranch>PreMerge` (one overwritable slot per generation), replacing
// the old ever-accumulating `<branch>Backup1/Backup2/…`.
//
// Parsing rule: strip a trailing `Squash` (the internal temp-branch suffix), then a trailing
// run of digits (the generation). KNOWN LIMITATION: a branch whose name naturally ends in
// digits (e.g. `feature/ONE-1917`) is misparsed — its trailing number is read as a generation.
// The team's convention ends branch names in a word (`feature/ONE-1917-dual-mode-migration`),
// so this is safe in practice; if that ever changes, switch the appended suffix to a separated
// form (e.g. `X.v2`) so the boundary is unambiguous.

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
    const match = withoutSquash.match(/^(.*?)(\d+)$/);
    if (match && match[1] !== '') {
        return new Generation(match[1], parseInt(match[2], 10));
    }
    return new Generation(withoutSquash, 1);
}

/** Stable base identity (remote / PR / feature-name slug source): trailing `Squash` and the
 *  generation number stripped. `base` → `base`, `base2` → `base`, `base2Squash` → `base`. */
export function baseBranchName(branch: string): string {
    return parseGeneration(branch).base;
}

/** The local branch you land on after this merge: base + (gen + 1). `base` → `base2`,
 *  `base2` → `base3`. */
export function nextBranchName(branch: string): string {
    const generation = parseGeneration(branch);
    return `${generation.base}${generation.gen + 1}`;
}

/** Pre-merge safety snapshot of the given (current) branch. One overwritable slot per branch. */
export function preMergeBackupName(branch: string): string {
    return `${branch}PreMerge`;
}
