import { OpenApiImportCli, USAGE } from './OpenApiImportCli';
import { OpenApiImportError } from '../OpenApiImportError';
import { toError } from '../toError';

/**
 * The body of the `wp-openapi-import` bin: the SINGLE top-level handler and the exit code, with
 * nothing that touches the process itself, so the suite runs the whole command. Everything below
 * THROWS {@link OpenApiImportError}; this renders it from its fields.
 */
export class WpOpenApiImportMain {
    private readonly cli = new OpenApiImportCli();

    /** @returns the process exit code. 0 on success, 1 on a stated failure. */
    run(argv: readonly string[], cwd: string, out: NodeJS.WriteStream): number {
        if (this.cli.wantsHelp(argv)) {
            out.write(`${USAGE}\n`);
            return 0;
        }
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- this IS the single top-level handler
        try {
            out.write(`wrote ${this.cli.run(argv, cwd)}\n`);
            return 0;
            // webpieces-disable catch-must-propagate -- this is the bin's ONE top-level handler: it renders the whole error (stack included for an unexpected one) and turns it into the exit code
        } catch (err: unknown) {
            const error = toError(err);
            out.write(`${this.render(error)}\n`);
            return 1;
        }
    }

    private render(error: Error): string {
        if (!(error instanceof OpenApiImportError)) {
            return `wp-openapi-import failed: ${error.stack ?? error.message}`;
        }
        return `wp-openapi-import refused: ${error.message}\n  ${error.cure}`;
    }
}
