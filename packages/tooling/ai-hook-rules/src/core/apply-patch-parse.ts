import * as path from 'path';

import { FileOperation } from './agent-event';
import { NormalizedEdit, NormalizedToolInput, InformAiError } from './types';

const BEGIN_PATCH = '*** Begin Patch';
const END_PATCH = '*** End Patch';
const ADD_FILE = '*** Add File: ';
const UPDATE_FILE = '*** Update File: ';
const DELETE_FILE = '*** Delete File: ';
const MOVE_TO = '*** Move to: ';
const HUNK_HEADER = '@@';

/**
 * Parses Codex's `apply_patch` envelope into the same `FileOperation[]` the rest of the hook already
 * understands, so a Codex edit is judged by the identical rules a Claude edit is.
 *
 * The grammar is MEASURED from a live codex-cli 0.151.0 session, not inferred from a diff format it
 * resembles. Two properties of it drive every design choice here:
 *
 *  - ONE envelope carries MANY files with MIXED operations, which is why the result is a LIST of
 *    `FileOperation` (each with its own kind) rather than one kind for the call.
 *  - Hunk headers are a BARE `@@` with NO line numbers. A unified-diff `@@ -1,3 +1,4 @@` is therefore
 *    not a stricter spelling of the same thing — it is an envelope we have never seen, and guessing at
 *    it is how a guard silently judges the wrong bytes. It is rejected.
 *
 * Paths are sometimes relative and sometimes absolute (measured: subagents used relative, the
 * coordinator absolute), so a relative path is resolved against the payload's `cwd`.
 *
 * FAIL CLOSED. Every malformed envelope THROWS `InformAiError`, which the hook's one top-level handler
 * turns into a deny naming the offending line. A parser that "did its best" on an envelope it did not
 * understand would hand the rule engine a subset of the real edit and allow the rest unjudged, which is
 * strictly worse than refusing the call.
 */
export class ApplyPatchParser {
    parse(command: string, cwd: string): readonly FileOperation[] {
        const lines = command.split('\n');
        const begin = lines.findIndex((l: string): boolean => l.trim() === BEGIN_PATCH);
        if (begin < 0) {
            throw new InformAiError(`[apply-patch] envelope has no '${BEGIN_PATCH}' line — refusing to judge a patch this parser does not recognise.`);
        }
        const end = lines.findIndex((l: string): boolean => l.trim() === END_PATCH);
        if (end < 0 || end < begin) {
            throw new InformAiError(`[apply-patch] envelope has no '${END_PATCH}' line after '${BEGIN_PATCH}' — refusing to judge a truncated patch.`);
        }

        const body = lines.slice(begin + 1, end);
        const ops: FileOperation[] = [];
        let index = 0;
        while (index < body.length) {
            const line = body[index];
            if (line.startsWith(ADD_FILE)) {
                index = this.parseAdd(body, index, cwd, ops);
            } else if (line.startsWith(DELETE_FILE)) {
                ops.push(new FileOperation('Delete', new NormalizedToolInput(this.resolve(line.slice(DELETE_FILE.length), cwd), [])));
                index += 1;
            } else if (line.startsWith(UPDATE_FILE)) {
                index = this.parseUpdate(body, index, cwd, ops);
            } else if (line.trim() === '') {
                index += 1;
            } else {
                throw new InformAiError(`[apply-patch] unexpected line outside any file section: ${JSON.stringify(line)}`);
            }
        }
        if (ops.length === 0) {
            throw new InformAiError('[apply-patch] envelope names no files — refusing to allow a patch whose targets could not be read.');
        }
        return ops;
    }

    /** `*** Add File: <p>` plus a body of `+` lines → a Write of the joined body. */
    private parseAdd(body: readonly string[], start: number, cwd: string, ops: FileOperation[]): number {
        const filePath = this.resolve(body[start].slice(ADD_FILE.length), cwd);
        const content: string[] = [];
        let index = start + 1;
        while (index < body.length && !body[index].startsWith('*** ')) {
            const line = body[index];
            if (!line.startsWith('+')) {
                throw new InformAiError(`[apply-patch] '${ADD_FILE.trim()}' body line must begin with '+', got ${JSON.stringify(line)}`);
            }
            content.push(line.slice(1));
            index += 1;
        }
        ops.push(new FileOperation('Write', new NormalizedToolInput(filePath, [new NormalizedEdit('', content.join('\n'))])));
        return index;
    }

    /**
     * `*** Update File: <p>`, an optional `*** Move to: <q>`, then one or more bare-`@@` hunks.
     *
     * A `Move to` makes the DESTINATION the judged path. That is the file whose bytes will exist after
     * the call, so it is the one a path-scoped rule must see; judging the source would let a rename
     * into a guarded directory land unjudged.
     */
    private parseUpdate(body: readonly string[], start: number, cwd: string, ops: FileOperation[]): number {
        let index = start + 1;
        let filePath = this.resolve(body[start].slice(UPDATE_FILE.length), cwd);
        if (index < body.length && body[index].startsWith(MOVE_TO)) {
            filePath = this.resolve(body[index].slice(MOVE_TO.length), cwd);
            index += 1;
        }
        const edits: NormalizedEdit[] = [];
        while (index < body.length && !body[index].startsWith('*** ')) {
            const header = body[index];
            if (header.trim() !== HUNK_HEADER) {
                throw new InformAiError(`[apply-patch] malformed hunk header ${JSON.stringify(header)} — a Codex hunk header is a bare '@@' with no line numbers.`);
            }
            index += 1;
            const oldLines: string[] = [];
            const newLines: string[] = [];
            while (index < body.length && !body[index].startsWith('*** ') && body[index].trim() !== HUNK_HEADER) {
                const line = body[index];
                // A bare empty line is a CONTEXT line whose content is empty — the leading space is
                // routinely stripped by whatever carried the patch, so treating it as malformed would
                // deny ordinary edits to files with blank lines.
                if (line === '') {
                    oldLines.push('');
                    newLines.push('');
                } else if (line.startsWith(' ')) {
                    oldLines.push(line.slice(1));
                    newLines.push(line.slice(1));
                } else if (line.startsWith('-')) {
                    oldLines.push(line.slice(1));
                } else if (line.startsWith('+')) {
                    newLines.push(line.slice(1));
                } else {
                    throw new InformAiError(`[apply-patch] hunk line must begin with ' ', '-' or '+', got ${JSON.stringify(line)}`);
                }
                index += 1;
            }
            edits.push(new NormalizedEdit(oldLines.join('\n'), newLines.join('\n')));
        }
        if (edits.length === 0) {
            throw new InformAiError(`[apply-patch] '${UPDATE_FILE.trim()}' section for ${filePath} carries no '@@' hunk — refusing to allow an edit whose content could not be read.`);
        }
        ops.push(new FileOperation('Edit', new NormalizedToolInput(filePath, edits)));
        return index;
    }

    private resolve(rawPath: string, cwd: string): string {
        const trimmed = rawPath.trim();
        if (trimmed === '') {
            throw new InformAiError('[apply-patch] a file directive named an empty path.');
        }
        return path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
    }
}
