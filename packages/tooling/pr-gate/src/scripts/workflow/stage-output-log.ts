import * as fs from 'fs';
import { injectable, bindingScopeValues } from 'inversify';

import { GateLogFile } from './gate-log-file';

// ─── Why ───────────────────────────────────────────────────────────────────────────────────────────────
// `wp-build` already solved this for the BUILD: its output goes to a FILE and the console gets a heartbeat
// plus a pointer. Stage ② and stage ③ had not been given the same treatment, so they printed everything —
// merge validation, the active-hatch report, the checklist scan, the diff extraction, the dashboard, the
// gh round trips — straight down the terminal.
//
// The consequence was measured, and it is not "a long transcript". An agent that expects a wall of output
// bounds it by reflex: `pnpm wp-review-upsert-pr 2>&1 | tail -50`. A PIPE WITHHOLDS EVERY BYTE UNTIL THE
// COMMAND EXITS, so the harness sees a command that has printed nothing for 600 seconds and kills it — a
// full build's worth of work thrown away, and then usually re-run the same way. In this repo's primary
// tree alone the call log holds 85 piped `wp-*` invocations, 42 of them on a command that runs a build
// (`wp-review-upsert-pr` 22, `wp-finish-upsert-pr` 17, `wp-build` 3).
//
// Shrinking the output is therefore the FIRST half of the fix and the guard against the pipe is the
// second, in that order. Blocking the pipe while the command still printed a thousand lines would only
// have traded a watchdog kill for a flooded context, and an agent would have routed around it with `>`.
//
// ─── Why it INTERCEPTS stdout instead of every writer calling it ───────────────────────────────────────
// There are ~160 `process.stdout.write` sites across this package, in classes shared by six other bins.
// Threading a logger through all of them would be a far larger diff with far more ways to miss one — and
// a MISSED one is the whole failure, because a single verbose writer that still reaches the console keeps
// the output big enough to be piped. Interception inverts the default: everything a stage prints is
// captured unless it says out loud that it must be seen NOW, and the "say it out loud" list is short
// enough to read (`say()` — the build heartbeat, the build result, the review instructions, the PR link).
//
// The interception is installed and removed by `withCapture`, in a `finally`, so a throw cannot leave a
// process with a patched stdout. Child processes that inherit fd 1 write straight past it, which is why
// the build gate redirects its child to a file of its own rather than relying on this.
//
// Also deliberately NOT intercepted: stderr. Failures must stay on the terminal — `runMain` renders every
// thrown CliExitError / RuleFailError there, and a refusal an agent cannot see is worse than a long one.

/** Stage ②'s console log. Named for the command, because that is what a reader is looking for. */
export const REVIEW_CONSOLE_LOG = 'wp-review-upsert-pr.log';

/** Stage ③'s console log. */
export const FINISH_CONSOLE_LOG = 'wp-finish-upsert-pr.log';

/** The write function this class swaps out and restores — Node's own `process.stdout.write`. */
type StdoutWrite = typeof process.stdout.write;

/** The optional completion callback Node's `write` accepts, in either of its two argument positions. */
type StdoutCallback = (err?: Error) => void;

/**
 * Captures a stage's verbose console output to a file, keeps the handful of lines the caller must act on
 * immediately on the terminal, and hands back the one-line pointer at the file.
 *
 * Singleton, and stateful FOR THE DURATION OF ONE `withCapture` call: a bin runs exactly one stage.
 * Re-entering it is a programming error, not a supported mode, and it throws rather than silently
 * capturing into the inner file and restoring the outer one.
 */
@injectable(bindingScopeValues.Singleton)
export class StageOutputLog {
    constructor(private readonly files: GateLogFile) {}

    // The open log, or '' when nothing is being captured. `say` works either way — outside a capture it
    // is a plain write to the terminal, which is what every other bin wants.
    private logPath = '';
    private fd = -1;
    private original: StdoutWrite | null = null;

    /**
     * Run `body` with this process's stdout captured to `<logs>/<fileName>`, then restore stdout and
     * print the pointer at the file.
     *
     * The pointer is printed in a `finally`, so it is there on the FAILURE path too — which is the path
     * where a reader most needs it, and the one where an uncaptured stage would have scrolled the cause
     * off the top of the terminal.
     */
    async withCapture<T>(repoRoot: string, fileName: string, body: () => Promise<T>): Promise<T> {
        if (this.original !== null) throw new Error(`StageOutputLog is already capturing to ${this.logPath}`);
        this.logPath = this.files.logsPath(repoRoot, fileName);
        this.files.rotate(this.logPath);
        this.fd = fs.openSync(this.logPath, 'w');
        // The REFERENCE, not a bound copy: `release` puts this exact function back, so a caller that
        // installed its own stdout before us (a spec, a wrapping bin) gets ITS function back rather than
        // a wrapper around it, and repeated captures cannot stack bound layers.
        this.original = process.stdout.write;
        process.stdout.write = this.intercept.bind(this) as StdoutWrite;
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: stdout MUST be restored and the fd
        // closed whatever `body` does; the throw is re-raised untouched.
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return await body();
        } finally {
            this.release();
        }
    }

    /**
     * Print `text` to the TERMINAL as well as the log — for the few things a caller must act on before it
     * can do anything else: the build heartbeat (a silent command is a killed command), the build result,
     * the review instructions, the PR link, and anything naming a file to read.
     *
     * Outside a capture this is an ordinary write, so a class that calls it is not coupled to the stage.
     */
    say(text: string): void {
        this.appendToLog(text);
        // `.call`, because `original` is the raw reference rather than a bound copy — see withCapture.
        (this.original ?? process.stdout.write).call(process.stdout, text);
    }

    // The stdout replacement. Node calls this with (chunk), (chunk, encoding), (chunk, callback) or
    // (chunk, encoding, callback); a callback that is never invoked can stall a writer, so it is always
    // called. Returning true means "not backpressured", which is honest for a synchronous file write.
    private intercept(
        chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | StdoutCallback, callback?: StdoutCallback,
    ): boolean {
        this.appendToLog(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
        if (done !== undefined) done();
        return true;
    }

    // Restore stdout, close the log, and print the pointer at it. Idempotent: a second call after the
    // `finally` has already run is a no-op rather than a double pointer.
    private release(): void {
        if (this.original === null) return;
        const restore = this.original;
        this.original = null;
        process.stdout.write = restore;
        fs.closeSync(this.fd);
        this.fd = -1;
        restore.call(process.stdout, `\n${this.files.pointer(this.logPath)}`);
        this.logPath = '';
    }

    // Nothing is captured when no capture is open — `say` still reaches the terminal, which is the point.
    private appendToLog(text: string): void {
        if (this.fd === -1) return;
        fs.writeSync(this.fd, text);
    }
}
