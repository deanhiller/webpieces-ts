import { describe, it, expect } from 'vitest';
import { EnforceControllerNamingConfig } from './rule-configs';
import { findControllerNamingViolations, toKebabCase } from './controller-naming-config';

// Detection runs on comment/string-stripped lines (both engines pass stripped lines), so plain
// source split by newline is a faithful stand-in here.
function linesOf(src: string): string[] {
    return src.split('\n');
}

function cfg(allowedPaths: string[] = []): EnforceControllerNamingConfig {
    const c = new EnforceControllerNamingConfig();
    c.allowedPaths = allowedPaths;
    return c;
}

describe('toKebabCase', () => {
    it('converts PascalCase controller names to kebab', () => {
        expect(toKebabCase('SaveController')).toBe('save-controller');
        expect(toKebabCase('PublicController')).toBe('public-controller');
        expect(toKebabCase('Server2Controller')).toBe('server2-controller');
        expect(toKebabCase('UserAccountController')).toBe('user-account-controller');
    });
});

describe('findControllerNamingViolations', () => {
    it('passes @Controller class correctly named in a correctly named file', () => {
        const src = ['@Controller()', 'export class SaveController extends SaveApi {}'].join('\n');
        expect(findControllerNamingViolations(linesOf(src), 'src/controllers/save-controller.ts', cfg())).toHaveLength(0);
    });

    it('flags an *Api implementer that declares NO intent (no @Controller / @NotController)', () => {
        const src = 'export class SaveController extends SaveApi {}';
        const v = findControllerNamingViolations(linesOf(src), 'src/controllers/save-controller.ts', cfg());
        expect(v).toHaveLength(1);
        expect(v[0]!.message).toContain('declare its intent');
    });

    it('exempts an *Api implementer marked @NotController (a simulator/client)', () => {
        const src = ['@injectable()', '@NotController()', 'export class Server2Simulator extends Server2Api {}'].join('\n');
        expect(findControllerNamingViolations(linesOf(src), 'src/remote/Server2Simulator.ts', cfg())).toHaveLength(0);
    });

    it('flags a @Controller class whose file name is PascalCase', () => {
        const src = ['@Controller()', 'export class SaveController extends SaveApi {}'].join('\n');
        const v = findControllerNamingViolations(linesOf(src), 'src/controllers/SaveController.ts', cfg());
        expect(v).toHaveLength(1);
        expect(v[0]!.message).toContain('save-controller.ts');
    });

    it('flags a @Controller class not ending in Controller', () => {
        const src = ['@provideSingleton()', '@Controller()', 'export class Bar extends SaveApi {}'].join('\n');
        const v = findControllerNamingViolations(linesOf(src), 'src/controllers/bar.ts', cfg());
        expect(v).toHaveLength(1);
        expect(v[0]!.message).toContain('must be named');
    });

    it('detects @Controller even when @provideSingleton sits between it and the class', () => {
        const src = ['@Controller()', '@provideSingleton()', 'export class WidgetController {}'].join('\n');
        // Correct class name, but file is PascalCase → file-name violation (proves the decorator was seen).
        const v = findControllerNamingViolations(linesOf(src), 'src/Widget.ts', cfg());
        expect(v).toHaveLength(1);
        expect(v[0]!.message).toContain('widget-controller.ts');
    });

    it('does NOT flag plain classes/interfaces with no *Api heritage and no @Controller', () => {
        const src = [
            'export interface Counter { inc(): void }',
            'export class SimpleCounter implements Counter {}',
            'export abstract class SaveApi {}',
        ].join('\n');
        expect(findControllerNamingViolations(linesOf(src), 'src/misc.ts', cfg())).toHaveLength(0);
    });

    it('does not confuse @NotController with @Controller (word-boundary match)', () => {
        // @NotController alone must NOT be read as @Controller and trigger naming enforcement.
        const src = ['@NotController()', 'export class Server2Simulator extends Server2Api {}'].join('\n');
        expect(findControllerNamingViolations(linesOf(src), 'src/remote/Server2Simulator.ts', cfg())).toHaveLength(0);
    });

    it('exempts allowedPaths globs and test files', () => {
        const bad = 'export class Foo extends SaveApi {}';
        expect(findControllerNamingViolations(linesOf(bad), 'src/generated/Foo.ts', cfg(['**/generated/**']))).toHaveLength(0);
        expect(findControllerNamingViolations(linesOf(bad), 'src/foo.spec.ts', cfg())).toHaveLength(0);
        expect(findControllerNamingViolations(linesOf(bad), 'src/__tests__/foo.ts', cfg())).toHaveLength(0);
    });
});
