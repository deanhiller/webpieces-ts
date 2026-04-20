import * as fs from 'fs';
import * as path from 'path';

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const DEFAULT_INSTRUCT_DIR = '.webpieces/instruct-ai';

export function loadTemplate(name: string): string {
    return fs.readFileSync(path.join(TEMPLATES_DIR, name), 'utf-8');
}

export function writeTemplateIfMissing(
    workspaceRoot: string,
    name: string,
    instructDir: string = DEFAULT_INSTRUCT_DIR
): void {
    const dest = path.join(workspaceRoot, instructDir, name);
    if (fs.existsSync(dest)) return;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, loadTemplate(name), 'utf-8');
}

export function writeTemplate(
    workspaceRoot: string,
    name: string,
    instructDir: string = DEFAULT_INSTRUCT_DIR
): string {
    const dest = path.join(workspaceRoot, instructDir, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, loadTemplate(name), 'utf-8');
    return dest;
}
