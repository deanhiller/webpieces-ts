import * as crypto from 'crypto';
import { RequiredChecklist } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { DiffBasis } from './diff-basis';
import { DiffMaterializer } from './diff-materializer';

/**
 * ONE hash per checklist of the diff that checklist is actually judged on: its in-scope files, each with
 * its patch from the fork point. Two verdicts judged the same change exactly when their hashes are equal —
 * which is the whole question verdict CARRY-OVER asks (issue #863).
 *
 * WHY a carried verdict is keyed on this and not on HEAD: on the measured Codex run, round 3 re-ran the
 * security and error-handling checklists although both were green in round 2 and the round-2 fix touched
 * none of their in-scope files. HEAD moved; what those two reviewers judge did not. The hash is what says so.
 *
 * NORMALIZED so that bookkeeping git adds around a patch does not look like a change to it:
 *   - `index <a>..<b>` lines are dropped — blob ids, which move whenever the fork point does;
 *   - hunk headers keep their text but lose their line numbers — a `wp-start-upsert-pr` merge that adds
 *     lines ABOVE an untouched hunk shifts `@@ -40,6 +40,9 @@`, and the change itself is identical.
 * Everything else — every added, removed and context line, and the set of files — is hashed, so a change
 * anywhere in a checklist's scope (including a NEW file coming into it) re-briefs that checklist.
 *
 * `@injectable(bindingScopeValues.Singleton)` so it is injected by type and drawn in the DI design.
 */
@injectable(bindingScopeValues.Singleton)
export class ChecklistScopeHasher {
    constructor(private readonly materializer: DiffMaterializer) {}

    /**
     * checklist id → scope hash, for every checklist given. ONE `git diff` for all of them (the same single
     * capture the materializer uses), then per-file normalization, then one sha256 per checklist.
     * Empty when the basis is unresolved: with no fork point there is no diff to hash.
     */
    hashes(repoRoot: string, basis: DiffBasis, checklists: readonly RequiredChecklist[]): Record<string, string> {
        const out: Record<string, string> = {};
        if (basis.unresolved || checklists.length === 0) return out;
        const byFile = this.materializer.diffByFile(repoRoot, basis);
        for (const req of checklists) out[req.id] = this.hashOf(req.matchedFiles, byFile);
        return out;
    }

    /** The hash of one file set against an already-captured diff. Public for the spec's normalization cases. */
    hashOf(files: readonly string[], byFile: ReadonlyMap<string, string>): string {
        const hash = crypto.createHash('sha256');
        for (const file of [...files].sort()) {
            hash.update(`FILE ${file}\n`);
            hash.update(this.normalize(byFile.get(file) ?? '<no diff>\n'));
        }
        return hash.digest('hex');
    }

    private normalize(patch: string): string {
        return patch
            .split('\n')
            .filter((line: string): boolean => !line.startsWith('index '))
            .map((line: string): string => line.startsWith('@@') ? line.replace(/^@@ [^@]*@@/, '@@') : line)
            .join('\n');
    }
}
