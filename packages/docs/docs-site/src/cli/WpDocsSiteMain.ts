import { CliResult, DocsSiteCli, USAGE } from './DocsSiteCli';
import { DevServer } from '../serve/DevServer';
import { DocsSiteError } from '../DocsSiteError';

/**
 * The body of the `wp-docs-site` bin: argument handling, the SINGLE top-level handler, and the exit
 * code — with nothing that touches the process itself, so the suite runs the whole command.
 *
 * Everything below here THROWS {@link DocsSiteError} and prints nothing, so this is the only
 * renderer of a failure and the only writer of an exit code (`.claude/review/error-output.md`). It
 * renders from the error's FIELDS — the message, the location, the cure — rather than from a string
 * somebody baked a cure into, so one audience's formatting never freezes into a thrower.
 */
export class WpDocsSiteMain {
    private readonly cli = new DocsSiteCli();

    /** @returns the process exit code. 0 on success, 1 on a stated failure. */
    async run(argv: readonly string[], cwd: string, out: NodeJS.WritableStream): Promise<number> {
        if (this.cli.wantsHelp(argv)) {
            out.write(`${USAGE}\n`);
            return 0;
        }
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- this IS the single top-level handler
        try {
            const result: CliResult = this.cli.run(argv, cwd);
            out.write(`wrote ${result.written.length} files to ${result.outDir}\n`);
            await this.preview(result, out);
            return 0;
            // webpieces-disable no-any-unknown -- the catch binding, which TypeScript types for us
        } catch (err: unknown) {
            //const error = toError(err);
            out.write(`${this.render(err)}\n`);
            return 1;
        }
    }

    /**
     * `--serve` starts the localhost preview and RESOLVES when it is listening, rather than blocking
     * forever. The bin keeps the process alive because the socket is open, and the suite can start
     * one, read a page and stop it — a run method that never returned would be untestable.
     */
    private async preview(result: CliResult, out: NodeJS.WritableStream): Promise<void> {
        if (!result.serve) {
            return;
        }
        const server = new DevServer(result.outDir);
        await server.start(result.port);
        out.write(`preview (not a host, loopback only) at ${server.url()}\n`);
    }

    // webpieces-disable no-any-unknown -- a caught value; this method is the audience-facing narrowing of it
    private render(err: unknown): string {
        if (!(err instanceof DocsSiteError)) {
            return `wp-docs-site failed: ${err instanceof Error ? err.message : String(err)}`;
        }
        return [`wp-docs-site refused: ${err.message}`, `  ${err.cure}`].join('\n');
    }
}
