import { InformAiError, MIGRATE_DIRS_COMMAND, POLICY_DIR } from '@webpieces/tooling-common';
import { toError } from '@webpieces/tooling-common/to-error';
import { Option, formatFixOptions } from './fix-option';

/**
 * ONE way out of a config problem: edit a named file, or run a named command.
 *
 * Exactly one of `editFile` / `command` is set. The hooks PERMIT every cure while the config is invalid —
 * the file through ConfigRepairAccess, the command through the L0 allowlist — and
 * `config-repair-cures.spec.ts` (agent-workflow-rules) asserts that against every cure a config problem
 * can name. A cure the hook would refuse is a deadlock, which is how #1273 happened.
 */
export class ConfigRepairCure {
    protected constructor(
        readonly editFile: string | null,
        readonly command: string | null,
        readonly text: string,
    ) {}

    option(preferred: boolean): Option {
        return new Option(this.text, preferred);
    }
}

/** Edit `file` (absolute). `text` says exactly what to paste or delete there. */
export class EditFileCure extends ConfigRepairCure {
    constructor(file: string, text: string) {
        super(file, null, text);
    }
}

/** Run `command`, verbatim. `text` says why. */
export class RunCommandCure extends ConfigRepairCure {
    constructor(command: string, text: string) {
        super(null, command, text);
    }
}

/**
 * A config / policy-file problem, carrying its cures as data (#1273).
 *
 * It IS an `InformAiError`, so every handler that already renders those (the hook adapters, the CLIs)
 * renders this one as a normal deny, never as a crash. The message is the problem text followed by the
 * cures, numbered by `formatFixOptions` — the framework owns the numbering, the throw site owns the words.
 */
export class ConfigRepairError extends InformAiError {
    readonly cures: readonly ConfigRepairCure[];

    constructor(problem: string, cures: readonly ConfigRepairCure[], options?: { cause?: Error }) {
        super(
            [
                problem,
                ...formatFixOptions(cures.map((cure: ConfigRepairCure, index: number) => cure.option(index === 0))),
            ].join('\n'),
            options,
        );
        this.name = 'ConfigRepairError';
        this.cures = cures;
    }
}

/**
 * `RepositoryLayout` (tooling-common, below this package) refuses policy left in `.webpieces/` with a plain
 * InformAiError naming `wp-migrate-dirs`. This carries that same cure as data, so the layout refusal is a
 * ConfigRepairError like every other config problem.
 */
export class RepositoryLayoutRepair {
    run(check: () => void): void {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- converts the layout refusal into the structured repair; everything else is rethrown
        try {
            check();
            // webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
        } catch (err: unknown) {
            const error = toError(err);
            if (!(error instanceof InformAiError)) throw error;
            throw new ConfigRepairError(
                error.message,
                [new RunCommandCure(MIGRATE_DIRS_COMMAND, `${MIGRATE_DIRS_COMMAND} — moves the policy files into ${POLICY_DIR}/.`)],
                { cause: error },
            );
        }
    }
}
