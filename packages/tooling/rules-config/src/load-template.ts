import * as fs from 'fs';
import * as path from 'path';
import { injectable, bindingScopeValues } from 'inversify';

import { AtomicFile } from './atomic-file';
import { InstructAiDocSet } from './instruct-ai-docs';
import { INSTRUCT_AI_LEAF } from './repo-root';
import { DotWebpieces, dotWebpieces } from './state-dir';

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
// Sentinel for "use the resolved LOCAL instruct-ai dir". Kept as the parameter default so the handful
// of callers that pass an explicit relative dir (they join it onto workspaceRoot themselves) are
// unaffected; anything passing the default gets DotWebpieces.local() resolution.
const DEFAULT_INSTRUCT_DIR = '';

/**
 * Writes the AI-facing instruct-ai template docs under `<workspaceRoot>/.webpieces/instruct-ai/`.
 * `@injectable(bindingScopeValues.Singleton)` so it can be injected and appear in the rules-config DI design.
 */
@injectable(bindingScopeValues.Singleton)
export class TemplateWriter {
    constructor(
        private readonly dotDir: DotWebpieces = dotWebpieces,
        private readonly atomicFile: AtomicFile = new AtomicFile(),
        private readonly docs: InstructAiDocSet = new InstructAiDocSet(),
    ) {}

    loadTemplate(name: string): string {
        return fs.readFileSync(path.join(TEMPLATES_DIR, name), 'utf-8');
    }

    /**
     * SEED `name` and everything it links to — writing only the ones that are not already on disk.
     *
     * Same closure as `writeTemplate`, for the same reason: a rule that drops
     * `webpieces.exceptions.md` next to its violation is delivering a doc a reader follows links out
     * of, and a seeded doc that later gains a sibling link would otherwise dangle exactly the way
     * git-workflow.md's link to the merge process did. The difference from `writeTemplate` is only
     * WHETHER an existing file is refreshed, never WHICH files are considered.
     */
    writeTemplateIfMissing(workspaceRoot: string, name: string, instructDir: string = DEFAULT_INSTRUCT_DIR): void {
        for (const doc of this.docs.closure(name, (docName: string): string => this.loadTemplate(docName))) {
            const target = this.destination(workspaceRoot, doc.name, instructDir);
            if (fs.existsSync(target)) continue;
            this.atomicFile.writeAtomic(target, doc.render(this.loadTemplate(doc.name)));
        }
    }

    /**
     * Write `name` AND every instruct-ai doc it links to, ATOMICALLY and only where bytes changed.
     * Returns the absolute path of `name` itself.
     *
     * THE CLOSURE IS THE POINT. Callers name the ONE doc their command is about; the docs a reader is
     * sent on to arrive with it, because a doc whose links dangle is worse than no doc — it teaches the
     * reader that the paths in these files cannot be trusted. See instruct-ai-docs.ts for the incident.
     *
     * Every `wp-*` command regenerates these, and the AI is routinely told to open one by absolute
     * path. A plain truncating write means a reader can catch it empty; skip-if-unchanged means the
     * overwhelmingly common case (same package version ⇒ identical content) does not write at all.
     */
    writeTemplate(workspaceRoot: string, name: string, instructDir: string = DEFAULT_INSTRUCT_DIR): string {
        for (const doc of this.docs.closure(name, (docName: string): string => this.loadTemplate(docName))) {
            const target = this.destination(workspaceRoot, doc.name, instructDir);
            // A doc stamped with live run state is SEEDED, never refreshed: `wp-finish-upsert-pr` runs
            // while a conflicted merge is still open, and clobbering that handback with the reference
            // copy would delete the file list the agent is working from.
            if (doc.seedOnly() && fs.existsSync(target)) continue;
            this.atomicFile.writeIfChanged(target, doc.render(this.loadTemplate(doc.name)));
        }
        return this.destination(workspaceRoot, name, instructDir);
    }

    // LOCAL `.webpieces/instruct-ai/<name>` by default; an explicitly-passed relative dir is still
    // joined onto workspaceRoot exactly as before.
    private destination(workspaceRoot: string, name: string, instructDir: string): string {
        if (instructDir === DEFAULT_INSTRUCT_DIR) {
            return this.dotDir.localFile(workspaceRoot, INSTRUCT_AI_LEAF, name);
        }
        return path.join(workspaceRoot, instructDir, name);
    }
}

// Temporary migration delegators — consumers migrate to injecting TemplateWriter over follow-up PRs.
const templateWriterSvc = new TemplateWriter();

export function loadTemplate(name: string): string {
    return templateWriterSvc.loadTemplate(name);
}

export function writeTemplateIfMissing(
    workspaceRoot: string,
    name: string,
    instructDir: string = DEFAULT_INSTRUCT_DIR,
): void {
    templateWriterSvc.writeTemplateIfMissing(workspaceRoot, name, instructDir);
}

export function writeTemplate(
    workspaceRoot: string,
    name: string,
    instructDir: string = DEFAULT_INSTRUCT_DIR,
): string {
    return templateWriterSvc.writeTemplate(workspaceRoot, name, instructDir);
}
