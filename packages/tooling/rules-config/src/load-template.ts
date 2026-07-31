import * as fs from 'fs';
import * as path from 'path';
import { injectable, bindingScopeValues } from 'inversify';

import { AtomicFile } from './atomic-file';
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
    ) {}

    loadTemplate(name: string): string {
        return fs.readFileSync(path.join(TEMPLATES_DIR, name), 'utf-8');
    }

    writeTemplateIfMissing(workspaceRoot: string, name: string, instructDir: string = DEFAULT_INSTRUCT_DIR): void {
        const dest = this.destination(workspaceRoot, name, instructDir);
        if (fs.existsSync(dest)) return;
        this.atomicFile.writeAtomic(dest, this.loadTemplate(name));
    }

    /**
     * Rewrite the doc, ATOMICALLY and only when its bytes actually changed.
     *
     * Every `wp-*` command regenerates these, and the AI is routinely told to open one by absolute
     * path. A plain truncating write means a reader can catch it empty; skip-if-unchanged means the
     * overwhelmingly common case (same package version ⇒ identical content) does not write at all.
     */
    writeTemplate(workspaceRoot: string, name: string, instructDir: string = DEFAULT_INSTRUCT_DIR): string {
        const dest = this.destination(workspaceRoot, name, instructDir);
        this.atomicFile.writeIfChanged(dest, this.loadTemplate(name));
        return dest;
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
