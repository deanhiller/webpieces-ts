import { CliResult, OpenApiCli, USAGE } from './OpenApiCli';
import { OpenApiGenerationError } from '../OpenApiGenerationError';

/**
 * The body of the `wp-openapi` bin: argument handling, the SINGLE top-level handler, and the exit
 * code — with nothing that touches the process itself, so the suite runs the whole command.
 *
 * ## The single top-level handler
 *
 * Everything below here THROWS {@link OpenApiGenerationError} and prints nothing, so this is the only
 * renderer of a failure and the only writer of an exit code (`.claude/review/error-output.md`). It
 * renders from the error's FIELDS — the message, the location, the cure, the pointers — rather than
 * from a string somebody baked a cure into, so one audience's formatting never freezes into a thrower.
 *
 * ## Why an unmapped field exits NON-ZERO
 *
 * A field with no schema publishes as "anything", so a document containing one is a green build
 * handing a partner a field with no shape. That is worse than no document, because nobody reads a
 * published contract looking for the field that was quietly left undefined. There is deliberately no
 * flag to downgrade it — the cure is at the contract, by naming the type, and every pointer needed to
 * do that is printed.
 */
export class WpOpenApiMain {
    private readonly cli = new OpenApiCli();

    /** @returns the process exit code. 0 on success, 1 on a stated failure. */
    run(argv: readonly string[], cwd: string, out: NodeJS.WriteStream): number {
        if (this.cli.wantsHelp(argv)) {
            out.write(`${USAGE}\n`);
            return 0;
        }
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- this IS the single top-level handler
        try {
            const result: CliResult = this.cli.run(argv, cwd);
            for (const file of result.written) {
                out.write(`wrote ${file}\n`);
            }
            return 0;
            // webpieces-disable no-any-unknown -- the catch binding, which TypeScript types for us
        } catch (err: unknown) {
            //const error = toError(err);
            out.write(`${this.render(err)}\n`);
            return 1;
        }
    }

    // webpieces-disable no-any-unknown -- a caught value; this method is the audience-facing narrowing of it
    private render(err: unknown): string {
        if (!(err instanceof OpenApiGenerationError)) {
            return `wp-openapi failed: ${err instanceof Error ? err.message : String(err)}`;
        }
        const lines = [`wp-openapi refused: ${err.message}`];
        for (const pointer of err.pointers) {
            lines.push(`  ${pointer}`);
        }
        lines.push(`  ${err.cure}`);
        return lines.join('\n');
    }
}
