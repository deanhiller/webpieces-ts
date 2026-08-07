import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { injectable, bindingScopeValues } from 'inversify';

/** The filename inside the temp dir. Named, because it is what a human sees in a `gh` error. */
export const MERGE_BODY_FILE = 'merge-commit-body.md';

/**
 * Writes the gated squash-commit body to a THROWAWAY file, because `gh pr merge --body-file` takes a
 * path and not a string. That is the entire job.
 *
 * ─── Why this is temp state and not a store ────────────────────────────────────────────────────────
 * It replaces `MergeBodyFiler`, which filed the same bytes under
 * `~/.webpieces/prs/<host>/<owner>/<repo>/<n>/merge-commit-body.md` so a later `wp-land-pr` could find
 * them. That store existed because the PR DESCRIPTION was a different (much longer) string from the
 * merge body, so the bytes finish produced lived nowhere else. Since the two surfaces were swapped —
 * the description IS the compact body, and the dashboard moved into the PR's comments — the durable
 * copy is the PR itself. A machine-global cache of a fact GitHub owns can only be missing, stale, or on
 * the wrong computer, and it was all three. `wp-land-pr` now reads `gh pr view --json body`.
 *
 * So both callers reach the same place from different directions: finish already holds the bytes it
 * just published, land reads them back from the PR, and each needs them on disk for the length of one
 * `gh` invocation. See `decisions/0005-the-pr-description-is-the-merge-body.md`.
 */
@injectable(bindingScopeValues.Singleton)
export class MergeBodyTempFile {
    /** @returns an absolute path to a file holding exactly `body`. Never ''. */
    write(body: string): string {
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-merge-body-')), MERGE_BODY_FILE);
        fs.writeFileSync(file, body);
        return file;
    }
}
