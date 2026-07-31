import * as fs from 'fs';
import * as path from 'path';
import { injectable, bindingScopeValues } from 'inversify';

import { toError } from './to-error';

/**
 * Crash-safe / concurrency-safe file writes for the SHARED `.webpieces/` state dir.
 *
 * WHY this exists: once `.webpieces/` is shared by every linked worktree (see SharedStateDir), files
 * that used to have exactly ONE writer per worktree now have N concurrent writers across the repo —
 * seven agents, one `merged-branches.json`. A plain `fs.writeFileSync` TRUNCATES first and then writes,
 * so a reader that opens the file in that window reads a truncated or half-written document and its
 * `JSON.parse` throws. That is not theoretical: it is exactly the failure PR #526 had to paper over
 * from the READER side for webpieces.config.json (retry a transient parse failure). This fixes the
 * WRITER side, which is where it actually belongs — a reader retry cannot help a reader that is handed
 * a syntactically VALID prefix of a JSON document.
 *
 * The fix is write-to-temp-then-`rename()`. POSIX `rename(2)` within a single directory is atomic: a
 * concurrent reader sees either the entire old file or the entire new one, never a mix, and never a
 * zero-length file. The temp file MUST be created in the SAME directory as the destination, otherwise
 * the rename crosses a filesystem boundary, degrades to copy+unlink, and loses the atomicity.
 *
 * NOT everything should come through here. Append-only logs (`branch-mutations.log`,
 * `guard-*.log`) are already concurrency-safe by a different mechanism — `fs.appendFileSync` opens
 * with O_APPEND and issues ONE `write(2)` per record, which POSIX guarantees not to interleave for
 * writes under PIPE_BUF. Routing an append through a rename would be strictly WORSE: it would make
 * concurrent appenders clobber each other's lines wholesale.
 */
@injectable(bindingScopeValues.Singleton)
export class AtomicFile {
    // Distinguishes temp files written by the same process within the same millisecond. Combined with
    // the pid this makes the temp name unique across every concurrent writer of a shared file.
    private sequence: number = 0;

    /**
     * Write `contents` to `absPath` so that no concurrent reader can ever observe a partial file.
     * Creates the parent directory. Throws only if the write itself genuinely failed (disk full,
     * permissions) — callers that must not fail wrap this.
     */
    writeAtomic(absPath: string, contents: string): void {
        const dir = path.dirname(absPath);
        fs.mkdirSync(dir, { recursive: true });
        const tmpPath = this.tempPathFor(absPath);
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            fs.writeFileSync(tmpPath, contents);
            fs.renameSync(tmpPath, absPath);
        } catch (err: unknown) {
            const error = toError(err);
            this.discard(tmpPath);
            throw new Error(`Failed atomic write of ${absPath}: ${error.message}`, { cause: error });
        }
    }

    /** `writeAtomic` of a pretty-printed JSON document, trailing newline included. */
    writeJsonAtomic(absPath: string, value: object): void {
        this.writeAtomic(absPath, JSON.stringify(value, null, 2) + '\n');
    }

    /**
     * Atomic write, SKIPPED when the file already holds exactly `contents`. Returns true when it wrote.
     *
     * This is the instruct-ai regeneration case: every `wp-*` command rewrites the same generated docs,
     * and with a shared `.webpieces/` those rewrites now overlap across worktrees. Identical content is
     * the overwhelmingly common case, so the cheapest correct answer is to not write at all; when the
     * content genuinely changed, the write is atomic so a concurrent reader never sees a half-doc.
     */
    writeIfChanged(absPath: string, contents: string): boolean {
        if (this.alreadyHolds(absPath, contents)) return false;
        this.writeAtomic(absPath, contents);
        return true;
    }

    // True when the file exists and its bytes already equal `contents`. Any read failure answers false
    // (rewrite it) — "cannot read the current content" must never read as "it is already correct".
    private alreadyHolds(absPath: string, contents: string): boolean {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            if (!fs.existsSync(absPath)) return false;
            return fs.readFileSync(absPath, 'utf8') === contents;
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return false;
        }
    }

    // A sibling of the destination (same directory ⇒ same filesystem ⇒ the rename stays atomic), named
    // so a crash leaves an obviously-temporary dotfile rather than something mistaken for real state.
    private tempPathFor(absPath: string): string {
        this.sequence += 1;
        const stamp = `${String(process.pid)}-${String(Date.now())}-${String(this.sequence)}`;
        return path.join(path.dirname(absPath), `.${path.basename(absPath)}.tmp-${stamp}`);
    }

    // Best-effort removal of an abandoned temp file. A failure here is not worth reporting over the
    // original write failure that caused it.
    private discard(tmpPath: string): void {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch (err: unknown) {
            const error = toError(err);
            void error;
        }
    }
}
