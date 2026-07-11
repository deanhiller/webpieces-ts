import * as fs from 'fs';
import * as path from 'path';
import { provideSingleton } from '@webpieces/core-context';
import { injectable } from 'inversify';

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const DEFAULT_INSTRUCT_DIR = '.webpieces/instruct-ai';

/**
 * Writes the AI-facing instruct-ai template docs under `<workspaceRoot>/.webpieces/instruct-ai/`.
 * `@provideSingleton` so it can be injected and appear in the rules-config DI design.
 */
@provideSingleton()
@injectable()
export class TemplateWriter {
    loadTemplate(name: string): string {
        return fs.readFileSync(path.join(TEMPLATES_DIR, name), 'utf-8');
    }

    writeTemplateIfMissing(workspaceRoot: string, name: string, instructDir: string = DEFAULT_INSTRUCT_DIR): void {
        const dest = path.join(workspaceRoot, instructDir, name);
        if (fs.existsSync(dest)) return;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, this.loadTemplate(name), 'utf-8');
    }

    writeTemplate(workspaceRoot: string, name: string, instructDir: string = DEFAULT_INSTRUCT_DIR): string {
        const dest = path.join(workspaceRoot, instructDir, name);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, this.loadTemplate(name), 'utf-8');
        return dest;
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
