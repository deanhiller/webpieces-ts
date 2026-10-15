import { AsyncLocalStorage } from 'node:async_hooks';

import { globMatches } from './glob-matches';

/**
 * The two path exclusions one rule run honours (#1253), as data: the repo's top-level `excludePaths`
 * (no rule judges these) and the rule's OWN `excludePaths` (this rule does not). Both are globs over the
 * workspace-relative path, matched by {@link globMatches} — the same matcher the hooks use, so a list
 * means one thing in the build and in a hook.
 */
export class RuleFileExclusions {
    constructor(
        readonly ruleName: string,
        readonly globalPaths: readonly string[],
        readonly rulePaths: readonly string[],
    ) {}

    excludes(relativePath: string): boolean {
        const norm = relativePath.replace(/\\/g, '/');
        return (
            this.globalPaths.some((glob: string) => globMatches(glob, norm)) ||
            this.rulePaths.some((glob: string) => globMatches(glob, norm))
        );
    }
}

// The ONE store of the exclusions in force for the rule run on this async call chain. Module-scoped on
// purpose: the dispatcher enters it and the file listing (DiffScope) reads it, and the rule in between
// carries no code for it — which is the whole point. AsyncLocalStorage, not a mutable field, so two
// rules run concurrently can never see each other's exclusions.
const activeExclusions = new AsyncLocalStorage<RuleFileExclusions>();

/**
 * Where the framework APPLIES path exclusions to a code rule (#1253) — at DISPATCH, not in the rule.
 *
 * The code-rules runtime runs every rule inside {@link runWithin}; every file listing a rule asks for
 * (`DiffScope.getChangedFiles` / `getAllFiles`, and so `ScanScope.files`) passes through {@link filter}.
 * A rule added later is therefore covered with no code of its own. The one exception is a rule that
 * walks the filesystem itself instead of asking git — it must ask {@link isExcluded} per file.
 *
 * Outside a rule run (the PR gate's checklist matching, the project catalog) there is no store, and
 * nothing is filtered.
 */
export class RuleFileScope {
    async runWithin<T>(exclusions: RuleFileExclusions, run: () => Promise<T>): Promise<T> {
        return activeExclusions.run(exclusions, run);
    }

    /** Run `work` with NO exclusions in force — for a listing that is not a rule judging files. */
    outside<T>(work: () => T): T {
        return activeExclusions.exit(work);
    }

    /** The exclusions of the rule running on this call chain, or undefined outside a rule run. */
    current(): RuleFileExclusions | undefined {
        return activeExclusions.getStore();
    }

    isExcluded(relativePath: string): boolean {
        return this.current()?.excludes(relativePath) ?? false;
    }

    filter(relativePaths: readonly string[]): string[] {
        const exclusions = this.current();
        if (exclusions === undefined) return [...relativePaths];
        return relativePaths.filter((file: string) => !exclusions.excludes(file));
    }
}
