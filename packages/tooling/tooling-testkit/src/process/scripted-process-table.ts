/** One call a program made through a mocked process edge. Data only. */
export class ProcessCallDto {
    constructor(
        readonly program: string,
        readonly args: readonly string[],
        readonly cwd: string | undefined,
        /** 'run' (captured), 'passThrough' (terminal), or 'shellToFile'. */
        readonly mode: string,
    ) {}

    /** `git -C /repo checkout main` — the call as a person would type it, for readable assertions. */
    get commandLine(): string {
        return [this.program, ...this.args].join(' ');
    }
}

/** The answer a scripted call produces: a fixed value, or one computed from the call (for a side effect). */
export type ScriptedAnswer<R> = R | ((call: ProcessCallDto) => R);

class ScriptedEntry<R> {
    constructor(
        readonly program: string,
        readonly args: readonly string[],
        readonly prefix: boolean,
        readonly answers: ScriptedAnswer<R>[],
    ) {}

    matches(call: ProcessCallDto): boolean {
        if (call.program !== this.program) return false;
        if (!this.prefix && call.args.length !== this.args.length) return false;
        if (call.args.length < this.args.length) return false;
        return this.args.every((arg: string, i: number): boolean => call.args[i] === arg);
    }
}

/**
 * The scripting table behind every mocked process edge.
 *
 * - An EXACT argv beats a PREFIX; among prefixes the longest wins.
 * - Answers scripted for one argv are returned in order; the LAST one keeps answering, so a command the
 *   program asks repeatedly needs scripting once, and a retry is scripted as two answers.
 * - An UNSCRIPTED call throws, naming the full command line: a feature test must say what the outside
 *   world answers, never inherit an accidental default.
 */
export class ScriptedProcessTable<R> {
    readonly calls: ProcessCallDto[] = [];
    private readonly entries: ScriptedEntry<R>[] = [];

    constructor(private readonly mockName: string) {}

    script(program: string, args: readonly string[], prefix: boolean, answer: ScriptedAnswer<R>): void {
        const existing = this.entries.find((entry: ScriptedEntry<R>): boolean =>
            entry.program === program && entry.prefix === prefix
            && entry.args.length === args.length
            && entry.args.every((arg: string, i: number): boolean => args[i] === arg));
        if (existing !== undefined) {
            existing.answers.push(answer);
            return;
        }
        this.entries.push(new ScriptedEntry<R>(program, [...args], prefix, [answer]));
    }

    answer(call: ProcessCallDto): R {
        this.calls.push(call);
        const entry = this.best(call);
        if (entry === undefined) {
            throw new Error(`${this.mockName}: nothing scripted for \`${call.commandLine}\` (cwd ${call.cwd ?? '<inherited>'}). `
                + 'Script what the outside world answers before running the program.');
        }
        const next = entry.answers.length > 1 ? entry.answers.shift() : entry.answers[0];
        const scripted = next as ScriptedAnswer<R>;
        return typeof scripted === 'function' ? (scripted as (c: ProcessCallDto) => R)(call) : scripted;
    }

    /** Every call whose argv starts with `prefix` (and, when given, whose program is `program`). */
    callsStartingWith(program: string, prefix: readonly string[]): ProcessCallDto[] {
        return this.calls.filter((call: ProcessCallDto): boolean =>
            call.program === program && prefix.every((arg: string, i: number): boolean => call.args[i] === arg));
    }

    private best(call: ProcessCallDto): ScriptedEntry<R> | undefined {
        const exact = this.entries.find((entry: ScriptedEntry<R>): boolean => !entry.prefix && entry.matches(call));
        if (exact !== undefined) return exact;
        return this.entries
            .filter((entry: ScriptedEntry<R>): boolean => entry.prefix && entry.matches(call))
            .sort((a: ScriptedEntry<R>, b: ScriptedEntry<R>): number => b.args.length - a.args.length)[0];
    }
}
