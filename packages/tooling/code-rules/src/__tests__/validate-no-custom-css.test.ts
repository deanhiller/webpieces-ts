import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NoCustomCssConfig } from '@webpieces/rules-config';
import { NoCustomCssValidator } from '../validate-no-custom-css';

let tmpDir: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-css-'));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFile(relativePath: string, content: string): string {
    const fullPath = path.join(tmpDir, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf-8');
    return relativePath;
}

function validator(): NoCustomCssValidator {
    return new NoCustomCssValidator(new NoCustomCssConfig());
}

describe('findHitsForFile (.ts @Component)', () => {
    it('flags styles: block in @Component', () => {
        const file = writeFile('src/foo.component.ts', `@Component({ selector: 'x', styles: ['.a{color:red}'] })\nclass Foo {}\n`);
        const hits = validator().findHitsForFile(file, tmpDir);
        expect(hits).toHaveLength(1);
        expect(hits[0]!.detail).toContain('styles');
    });

    it('flags styleUrls: in @Component', () => {
        const file = writeFile('src/foo.component.ts', `@Component({ styleUrls: ['./foo.css'] })\nclass Foo {}\n`);
        expect(validator().findHitsForFile(file, tmpDir)).toHaveLength(1);
    });

    it('flags styleUrl: (singular) in @Component', () => {
        const file = writeFile('src/foo.component.ts', `@Component({ styleUrl: './foo.css' })\nclass Foo {}\n`);
        expect(validator().findHitsForFile(file, tmpDir)).toHaveLength(1);
    });

    it('does NOT flag a styles property on a non-@Component object', () => {
        const file = writeFile('src/config.ts', `const cfg = { styles: ['a'] };\n`);
        expect(validator().findHitsForFile(file, tmpDir)).toHaveLength(0);
    });

    it('does NOT flag a Tailwind-only component', () => {
        const file = writeFile('src/foo.component.ts', `@Component({ template: '<div class="flex gap-4"></div>' })\nclass Foo {}\n`);
        expect(validator().findHitsForFile(file, tmpDir)).toHaveLength(0);
    });

    it('marks hasDisableComment=true when disable on the previous line', () => {
        const file = writeFile('src/foo.component.ts', `@Component({\n  // webpieces-disable no-custom-css -- vendored\n  styles: ['.a{}']\n})\nclass Foo {}\n`);
        const hits = validator().findHitsForFile(file, tmpDir);
        expect(hits).toHaveLength(1);
        expect(hits[0]!.hasDisableComment).toBe(true);
    });
});

describe('findHitsForFile (.html templates)', () => {
    it('flags inline style= attribute', () => {
        const file = writeFile('src/foo.component.html', `<div style="color: red"></div>\n`);
        const hits = validator().findHitsForFile(file, tmpDir);
        expect(hits).toHaveLength(1);
        expect(hits[0]!.detail).toContain('style=');
    });

    it('flags [style.width] binding', () => {
        const file = writeFile('src/foo.component.html', `<div [style.width]="w"></div>\n`);
        const hits = validator().findHitsForFile(file, tmpDir);
        expect(hits).toHaveLength(1);
        expect(hits[0]!.detail).toContain('[style.x]');
    });

    it('flags [ngStyle]', () => {
        const file = writeFile('src/foo.component.html', `<div [ngStyle]="s"></div>\n`);
        const hits = validator().findHitsForFile(file, tmpDir);
        expect(hits).toHaveLength(1);
        expect(hits[0]!.detail).toContain('ngStyle');
    });

    it('does NOT flag Tailwind classes or [class.x] toggles', () => {
        const file = writeFile('src/foo.component.html', `<div class="flex gap-4" [class.active]="on"></div>\n`);
        expect(validator().findHitsForFile(file, tmpDir)).toHaveLength(0);
    });

    it('does NOT flag the word stylesheet or a .css href', () => {
        const file = writeFile('src/foo.component.html', `<link rel="stylesheet" href="app.style.css">\n`);
        expect(validator().findHitsForFile(file, tmpDir)).toHaveLength(0);
    });

    it('marks hasDisableComment=true with an HTML disable comment above', () => {
        const file = writeFile('src/foo.component.html', `<!-- webpieces-disable no-custom-css -- dynamic -->\n<div [style.width]="w"></div>\n`);
        const hits = validator().findHitsForFile(file, tmpDir);
        expect(hits).toHaveLength(1);
        expect(hits[0]!.hasDisableComment).toBe(true);
    });
});

describe('isRelevantFile', () => {
    it('accepts .ts and .html, rejects test files and others', () => {
        const v = validator();
        expect(v.isRelevantFile('src/a.component.ts')).toBe(true);
        expect(v.isRelevantFile('src/a.component.html')).toBe(true);
        expect(v.isRelevantFile('src/a.spec.ts')).toBe(false);
        expect(v.isRelevantFile('src/a.scss')).toBe(false);
    });
});
