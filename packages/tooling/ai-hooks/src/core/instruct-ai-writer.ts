import * as fs from 'fs';
import * as path from 'path';

const INSTRUCT_DIR = '.webpieces/instruct-ai';

export function writeTemplateIfMissing(workspaceRoot: string, templateName: string): void {
    const dir = path.join(workspaceRoot, INSTRUCT_DIR);
    const filePath = path.join(dir, templateName);
    if (fs.existsSync(filePath)) return;

    const templatePath = path.join(__dirname, '..', '..', 'templates', templateName);
    const content = fs.readFileSync(templatePath, 'utf-8');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content);
}
