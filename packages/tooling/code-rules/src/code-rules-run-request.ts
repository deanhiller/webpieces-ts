import { InformAiError } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

/** The three debug flags, spelled once for the parser and the usage text. */
const RULE_FLAG = '--rule=';
const MODE_FLAG = '--mode=';
const PROJECTS_FLAG = '--projects=';
const USAGE = `${RULE_FLAG}<rule> [${MODE_FLAG}<MODE>] [${PROJECTS_FLAG}<project>,<project>]`;

/**
 * What one code-rules run was asked to do (#1027). Data-only, bound at the composition root.
 *
 * {@link GATE} is the build: every configured rule, at its COMMITTED mode, over the diff. Anything with a
 * `rule` is a DEBUG run — that one rule, optionally at another mode (`mode`, no config edit), optionally
 * restricted to named projects (`projects`). A debug run changes nothing in webpieces.config.json,
 * labels itself as not the gate, prints the rule's own failure text plus a site count per project, and
 * exits non-zero when there are sites. Build one with {@link CodeRulesRunRequestParser}, which refuses
 * a `mode` or `projects` without a `rule`.
 */
export class CodeRulesRunRequest {
    static readonly GATE = new CodeRulesRunRequest(null, null, null);

    constructor(
        /** The one rule a debug run judges; null = the gate (every rule, `mode`/`projects` unused). */
        readonly rule: string | null,
        /** A mode to judge `rule` at INSTEAD of its committed one; null = the committed mode. */
        readonly mode: string | null,
        /** nx project names to restrict the run to; null = every project. */
        readonly projects: readonly string[] | null,
    ) {}

    isDebug(): boolean {
        return this.rule !== null;
    }
}

/** Parses the debug flags from the `wp-validate-code` argv or the nx `validate-code` executor options. */
@injectable(bindingScopeValues.Singleton)
export class CodeRulesRunRequestParser {
    /** From the bin's argv (process.argv.slice(2)). Unknown flags are refused. */
    fromArgv(argv: readonly string[]): CodeRulesRunRequest {
        let rule: string | null = null;
        let mode: string | null = null;
        let projects: string[] | null = null;
        for (const arg of argv) {
            if (arg.startsWith(RULE_FLAG)) rule = this.value(arg, RULE_FLAG);
            else if (arg.startsWith(MODE_FLAG)) mode = this.value(arg, MODE_FLAG);
            else if (arg.startsWith(PROJECTS_FLAG)) projects = this.split(this.value(arg, PROJECTS_FLAG));
            else throw new InformAiError(`Unknown argument '${arg}'. Usage: wp-validate-code ${USAGE}`);
        }
        return this.request(rule, mode, projects);
    }

    /**
     * From the nx `validate-code` executor's options, which is where
     * `nx run architecture:validate-code --rule=… --mode=… --projects=…` lands. nx hands `projects` over
     * as a string or, when it split the commas itself, as an array.
     */
    // webpieces-disable no-any-unknown -- nx executor options arrive as an untyped record
    fromExecutorOptions(options: Record<string, unknown>): CodeRulesRunRequest {
        const rule = typeof options['rule'] === 'string' ? options['rule'] : null;
        const mode = typeof options['mode'] === 'string' ? options['mode'] : null;
        const raw = options['projects'];
        let projects: string[] | null = null;
        if (typeof raw === 'string') projects = this.split(raw);
        else if (Array.isArray(raw)) projects = this.split(raw.map(String).join(','));
        return this.request(rule, mode, projects);
    }

    private request(rule: string | null, mode: string | null, projects: string[] | null): CodeRulesRunRequest {
        if (rule !== null) return new CodeRulesRunRequest(rule, mode, projects);
        if (mode === null && projects === null) return CodeRulesRunRequest.GATE;
        throw new InformAiError(
            `${MODE_FLAG} and ${PROJECTS_FLAG} debug ONE rule, so they need ${RULE_FLAG}<rule> beside them. Usage: ${USAGE}`,
        );
    }

    private value(arg: string, flag: string): string {
        const value = arg.slice(flag.length).trim();
        if (value.length === 0) throw new InformAiError(`${flag}<value> needs a value. Usage: ${USAGE}`);
        return value;
    }

    private split(list: string): string[] {
        const names = list.split(',').map((n: string) => n.trim()).filter((n: string) => n.length > 0);
        if (names.length === 0) throw new InformAiError(`${PROJECTS_FLAG} names no project. Usage: ${USAGE}`);
        return names;
    }
}
