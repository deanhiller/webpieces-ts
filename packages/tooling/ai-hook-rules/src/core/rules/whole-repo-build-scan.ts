import { CommandScanner } from '../command-scan';

/**
 * Decides the one question whole-repo-build-guard asks of a command: would this segment build (or
 * test) the ENTIRE monorepo rather than the part the change touches?
 *
 * ─── Why this is a SHAPE test and not a string match ───────────────────────────────────────────────
 * The command that motivated the guard is `pnpm run build-all`, but matching that literal buys about a
 * day: `npm run build-all`, `pnpm nx run-many -t ci`, `pnpm exec vitest run` and `time pnpm build-all`
 * are the same build with a different spelling, and an agent that is blocked reaches for the next
 * spelling rather than the smaller build. So the classifier normalizes away the package-manager
 * wrapper first, then judges the PROGRAM and its narrowing arguments:
 *
 *   BLOCKED  a whole-repo script name — `build-all`, `webpieces:ci`, `wp-ci`, … — under any runner
 *   BLOCKED  `nx run-many` of a BUILD target with no `-p`/`--projects`, or with `--all`
 *   BLOCKED  `nx affected` of a BUILD target with no `--base` (a far wider base than the fork point)
 *   BLOCKED  `nx <target>` with no project argument (`nx test`)
 *   BLOCKED  `vitest`/`vitest run` with no path, `--project` or `--dir` to narrow it
 *   BLOCKED  a bare `pnpm test` AT THE WORKSPACE ROOT — the root `test` script is the whole suite.
 *            Only under a RUNNER: a naked `test` word is POSIX test(1), and classifying it as the
 *            script blocked a polling loop whose jq filter merely contained `test(`.
 *
 *   ALLOWED  `nx affected --target=ci --base=<anything>` — the gate's own command
 *   ALLOWED  `nx run <project>:<target>`, `nx run-many -t test -p a b`, `nx test core-util`
 *   ALLOWED  `vitest run packages/core/core-util`, `vitest run --project core-util`
 *   ALLOWED  anything carrying `--filter` (pnpm's own narrowing), and every non-build command
 *   ALLOWED  a workspace-wide REGENERATION — `nx run-many --target=di-graph-generate` — which is
 *            supposed to cover every project and which this repo's own docs prescribe
 *
 * Narrowing is judged POSITIVELY: a command is blocked only when the shape is whole-repo AND nothing
 * in it narrows the scope. A flag this file has never heard of therefore fails toward ALLOW, which is
 * the right direction for a guard whose false positive costs an agent its next legitimate command.
 */

// Package-manager wrappers that precede the real program (`pnpm exec vitest`, `npx nx`, `yarn build-all`).
const RUNNERS: ReadonlySet<string> = new Set(['pnpm', 'npm', 'yarn', 'npx', 'pnpx', 'bun', 'bunx']);

// The runner's own verb, consumed with it: `pnpm run build-all` and `pnpm build-all` are one command.
const RUNNER_VERBS: ReadonlySet<string> = new Set(['run', 'run-script', 'exec', 'dlx', 'x']);

// Any of these ANYWHERE in the segment means the human/agent already scoped the work, so nothing here
// applies. `--filter` is pnpm's project selector; the nx selectors are checked again per-subcommand.
const NARROWING_FLAGS: readonly string[] = ['--filter', '-p', '--projects', '--project', '--dir', '--projectPath'];

// Script/bin names that ARE "build the world" in every repo that defines them. `wp-ci` is webpieces'
// own whole-repo validator and is listed as a PROGRAM as well as a script: blocking `build-all` while
// leaving the thing it delegates to open would be a guard with a labelled side door.
const WHOLE_REPO_SCRIPTS: ReadonlySet<string> = new Set([
    'build-all', 'build:all', 'buildall',
    'test-all', 'test:all', 'lint-all', 'ci-all', 'ci:all',
    'webpieces:ci', 'wp-ci',
]);

// nx verbs that are NOT "run this target across the workspace". Anything else in the first position is
// read as a TARGET name (`nx test`, `nx build`), which is whole-repo unless a project follows.
const NX_COMMANDS: ReadonlySet<string> = new Set([
    'run', 'run-many', 'affected', 'affected:graph', 'print-affected',
    'show', 'graph', 'dep-graph', 'reset', 'daemon', 'list', 'report', 'migrate',
    'generate', 'g', 'new', 'format', 'repair', 'connect', 'add', 'init', 'release',
    'sync', 'watch', 'exec', 'login', 'logout', 'record', 'view-logs', 'import',
]);

/**
 * The targets this guard is about. A workspace-wide `nx run-many -t di-graph-generate` or
 * `-t architecture:generate` is a REGENERATION and is supposed to cover every project — the repo's own
 * docs prescribe exactly that, and blocking it would make the guard wrong about a command an agent has
 * to run. Only the compile/test/lint family is a "build of the world".
 */
const BUILD_TARGETS: ReadonlySet<string> = new Set([
    'ci', 'build', 'test', 'lint', 'e2e', 'typecheck', 'check', 'compile', 'verify',
]);

// vitest's leading verb, dropped before looking for a path filter.
const VITEST_VERBS: ReadonlySet<string> = new Set(['run', 'watch', 'dev', 'related', 'bench', 'list', 'typecheck', 'init']);

// vitest flags whose VALUE is the next token, so the value is never mistaken for a path filter.
const VITEST_VALUE_FLAGS: ReadonlySet<string> = new Set([
    '--reporter', '--config', '-c', '--mode', '-m', '--shard', '--pool', '--environment',
    '--outputFile', '--maxWorkers', '--minWorkers', '--testNamePattern', '-t', '--retry',
    '--testTimeout', '--hookTimeout', '--exclude', '--include', '--coverage.reporter',
]);

/** One whole-repo build found in a command: the segment, and the SHAPE that made it one. Data-only. */
export class WholeRepoBuildHit {
    segment: string;
    shape: string;

    constructor(segment: string, shape: string) {
        this.segment = segment;
        this.shape = shape;
    }
}

export class WholeRepoBuildScan {
    constructor(
        private readonly scanner: CommandScanner,
        // True when the command runs at the workspace ROOT, where a bare `pnpm test` is the whole suite.
        private readonly atWorkspaceRoot: boolean,
    ) {}

    /** The first segment of `command` that builds the whole repo, or null when none does. */
    firstHit(command: string): WholeRepoBuildHit | null {
        for (const segment of this.scanner.commandSegments(command)) {
            const shape = this.shapeOf(segment);
            if (shape !== null) return new WholeRepoBuildHit(segment, shape);
        }
        return null;
    }

    // The whole-repo shape this segment is, or null. One dispatch per program family.
    private shapeOf(segment: string): string | null {
        // Narrowing is judged on the RAW words, BEFORE the runner is stripped: `pnpm --filter core-util
        // test` carries its selector on the RUNNER, and stripping first throws that fact away — which is
        // exactly how a scoped command ends up blocked.
        if (this.isNarrowed(this.scanner.words(segment))) return null;

        const raw = this.scanner.words(segment);
        const words = this.effectiveWords(segment);
        if (words.length === 0) return null;

        const program = this.programName(words[0]);
        const args = words.slice(1);

        if (WHOLE_REPO_SCRIPTS.has(program)) return `${program} builds every project`;
        if (program === 'nx') return this.nxShape(args);
        if (program === 'vitest') return this.vitestShape(args);
        // `test` ONLY as a package-manager script — `pnpm test`, `npm test`, `yarn test`. A NAKED `test`
        // is POSIX test(1) (the `[` builtin), never a build, and treating the bare word as the script
        // is how a fragment of somebody's data ends up classified as a workspace-wide test run.
        if (program === 'test' && args.length === 0 && this.atWorkspaceRoot && this.viaRunner(raw)) {
            return 'the root `test` script runs every spec in the repo';
        }
        return null;
    }

    // Did a package-manager runner precede the program (`pnpm …`, `npx …`)? Read off the RAW words,
    // before effectiveWords strips it, which is the only place that fact still exists.
    private viaRunner(raw: readonly string[]): boolean {
        return raw.length > 0 && RUNNERS.has(this.programName(raw[0]));
    }

    /**
     * The segment's words with wrappers stripped: shell prefixes (`time`, `sudo`, env assignments) by
     * CommandScanner, then the package-manager runner and its verb. `pnpm exec vitest run` and
     * `vitest run` reduce to the same words, which is the whole point.
     */
    private effectiveWords(segment: string): readonly string[] {
        let words = this.scanner.words(segment);
        while (words.length > 0 && RUNNERS.has(this.programName(words[0]))) {
            words = words.slice(1);
            // The runner's own flags (`--silent`, `-r`) sit between it and the program.
            while (words.length > 0 && words[0].startsWith('-')) words = words.slice(1);
            if (words.length > 0 && RUNNER_VERBS.has(words[0])) words = words.slice(1);
        }
        return words;
    }

    // `./node_modules/.bin/nx` and `/usr/local/bin/pnpm` are the same programs as `nx` and `pnpm`.
    private programName(token: string): string {
        const base = token.split('/').pop() ?? token;
        return base.endsWith('.cmd') ? base.slice(0, -'.cmd'.length) : base;
    }

    // Did the caller already scope this command? Judged over the WHOLE segment, so a selector attached
    // to the runner (`pnpm --filter core-util test`) counts just as much as one attached to nx.
    private isNarrowed(words: readonly string[]): boolean {
        return words.some((w: string): boolean =>
            NARROWING_FLAGS.some((flag: string): boolean => w === flag || w.startsWith(`${flag}=`)));
    }

    private nxShape(args: readonly string[]): string | null {
        const positional = args.filter((a: string): boolean => !a.startsWith('-'));
        const subcommand = positional[0] ?? '';

        if (subcommand === 'run-many') {
            if (!this.buildsAnything(args, positional)) return null;
            if (this.hasFlag(args, '--all')) return 'nx run-many --all builds every project';
            return 'nx run-many with no --projects builds every project';
        }
        if (subcommand === 'affected') {
            if (this.hasFlag(args, '--base')) return null;
            if (!this.buildsAnything(args, positional)) return null;
            return 'nx affected with no --base compares against a far wider base than the fork point';
        }
        if (subcommand === '' || NX_COMMANDS.has(subcommand)) return null;
        // `nx <target>` — whole-workspace unless a project name follows it.
        if (positional.length > 1) return null;
        if (!BUILD_TARGETS.has(subcommand)) return null;
        return `nx ${subcommand} with no project runs that target everywhere`;
    }

    private vitestShape(args: readonly string[]): string | null {
        let rest = args;
        if (rest.length > 0 && VITEST_VERBS.has(rest[0])) rest = rest.slice(1);
        for (let i = 0; i < rest.length; i++) {
            const word = rest[i];
            if (!word.startsWith('-')) return null;                 // a path filter — narrowed
            if (VITEST_VALUE_FLAGS.has(word)) i++;                  // skip the flag's value
        }
        return 'vitest with no path filter runs every spec in the repo';
    }

    /**
     * Does this nx invocation run a COMPILE/TEST target? Targets come from `-t`/`--target`/`--targets`
     * in either spelling, comma-separated, plus (for `run-many <target>`) a second positional.
     *
     * An invocation naming NO target is not judged a build: nx errors on it, and guessing would block a
     * typo with a message about build scope. An invocation naming only regeneration targets
     * (`di-graph-generate`, `generate`) is deliberately allowed workspace-wide — see BUILD_TARGETS.
     */
    private buildsAnything(args: readonly string[], positional: readonly string[]): boolean {
        const targets: string[] = positional.slice(1);
        for (let i = 0; i < args.length; i++) {
            const word = args[i];
            const flag = ['-t', '--target', '--targets'].find(
                (f: string): boolean => word === f || word.startsWith(`${f}=`));
            if (flag === undefined) continue;
            const value = word === flag ? (args[i + 1] ?? '') : word.slice(flag.length + 1);
            targets.push(...value.split(','));
        }
        return targets.some((t: string): boolean => BUILD_TARGETS.has(t.trim()));
    }

    // `--base` / `--base=<x>` / `--base <x>` — the attached and detached spellings of one flag.
    private hasFlag(args: readonly string[], flag: string): boolean {
        return args.some((a: string): boolean => a === flag || a.startsWith(`${flag}=`));
    }
}
