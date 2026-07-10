import { describe, it, expect } from 'vitest';

import { findRedundantInjectInSource } from '../validate-inject-annotation-not-needed-for-concrete-class';

// The AST detector is pure over (content, filePath, disableAllowed) — no git/disk needed. These tests
// pin the one rule: a CONSTRUCTOR parameter whose `@inject(X)` token is textually identical to the
// parameter's own declared type is redundant. Every legitimate token (Symbol/string/provider/interface)
// differs from the type and must pass untouched, and property injection must not be flagged.

function violations(source: string, disableAllowed: boolean = true): string[] {
    return findRedundantInjectInSource(source, 'src/example.ts', disableAllowed).map((v: { context: string }): string => v.context);
}

describe('findRedundantInjectInSource — FLAGGED (token === parameter type)', () => {
    it('flags @inject(Foo) on a param typed : Foo', () => {
        const src = 'class C { constructor(@inject(Foo) private readonly foo: Foo) {} }';
        expect(violations(src)).toHaveLength(1);
    });

    it('flags even with a leading @optional() decorator', () => {
        const src = 'class C { constructor(@optional() @inject(Foo) private readonly foo: Foo) {} }';
        expect(violations(src)).toHaveLength(1);
    });

    it('flags @inject(Foo) x: Foo<Bar> (generic type, name matches)', () => {
        const src = 'class C { constructor(@inject(Foo) private readonly foo: Foo<Bar>) {} }';
        expect(violations(src)).toHaveLength(1);
    });

    it('flags each redundant param independently', () => {
        const src = 'class C { constructor(@inject(A) a: A, @inject(B) b: B) {} }';
        expect(violations(src)).toHaveLength(2);
    });
});

describe('findRedundantInjectInSource — ALLOWED (token differs from type)', () => {
    it('does NOT flag a Symbol/UPPER_SNAKE token that differs from the type', () => {
        const src = 'class C { constructor(@inject(TASK_PROXY_CLIENT_PROVIDER) x: Provider<TaskProxyClient>) {} }';
        expect(violations(src)).toHaveLength(0);
    });

    it('does NOT flag a config-token injecting an interface type', () => {
        const src = 'class C { constructor(@inject(WEBPIECES_CONFIG_TOKEN) c: WebpiecesConfig) {} }';
        expect(violations(src)).toHaveLength(0);
    });

    it('does NOT flag a string-literal token', () => {
        const src = "class C { constructor(@inject('some-token') x: Foo) {} }";
        expect(violations(src)).toHaveLength(0);
    });

    it('does NOT flag @inject(Symbol.for(...)) (not a bare identifier)', () => {
        const src = "class C { constructor(@inject(Symbol.for('X')) x: Foo) {} }";
        expect(violations(src)).toHaveLength(0);
    });

    it('does NOT flag a plain param with no @inject', () => {
        const src = 'class C { constructor(private readonly foo: Foo) {} }';
        expect(violations(src)).toHaveLength(0);
    });

    it('does NOT flag a param with no type annotation', () => {
        const src = 'class C { constructor(@inject(Foo) foo) {} }';
        expect(violations(src)).toHaveLength(0);
    });

    it('does NOT flag PROPERTY injection (only constructor params are in scope)', () => {
        const src = 'class C { @inject(Foo) private readonly foo!: Foo; }';
        expect(violations(src)).toHaveLength(0);
    });

    it('does NOT flag a method param that happens to carry @inject', () => {
        const src = 'class C { doThing(@inject(Foo) foo: Foo): void {} }';
        expect(violations(src)).toHaveLength(0);
    });
});

describe('findRedundantInjectInSource — disable handling', () => {
    it('marks the violation disabled when a webpieces-disable comment is on the line above (disableAllowed=true)', () => {
        const src = [
            'class C {',
            '  constructor(',
            '    // webpieces-disable inject-annotation-not-needed-for-concrete-class -- legacy binding',
            '    @inject(Foo) private readonly foo: Foo,',
            '  ) {}',
            '}',
        ].join('\n');
        const found = findRedundantInjectInSource(src, 'src/example.ts', true);
        expect(found).toHaveLength(1);
        expect(found[0]?.hasDisableComment).toBe(true);
    });

    it('does NOT honor the disable comment when disableAllowed=false', () => {
        const src = [
            'class C {',
            '  constructor(',
            '    // webpieces-disable inject-annotation-not-needed-for-concrete-class -- legacy binding',
            '    @inject(Foo) private readonly foo: Foo,',
            '  ) {}',
            '}',
        ].join('\n');
        const found = findRedundantInjectInSource(src, 'src/example.ts', false);
        expect(found).toHaveLength(1);
        expect(found[0]?.hasDisableComment).toBe(false);
    });
});
