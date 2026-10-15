import { SourceContributionConfig } from "../source-contribution-config";
import { describe, it, expect } from 'vitest';



import { EditContext } from '@webpieces/hook-runtime';
import { NoDestructureRule } from './no-destructure';

function ctx(relativePath: string, content: string, disabledLines: number[] = []): EditContext {
    const lines = content.split('\n');
    const disabled = new Set(disabledLines);
    return new EditContext(
        'Write',
        0,
        1,
        `/tmp/x/${relativePath}`,
        relativePath,
        '/tmp/x',
        content,
        content,
        lines,
        lines, // strippedLines — fine here, the snippets carry no comments
        '',
        (lineNum: number): boolean => disabled.has(lineNum),
    );
}

function rule(excludePaths: string[] = [], disableAllowed = true): NoDestructureRule {
    const cfg = new SourceContributionConfig();
    cfg.mode = 'NEW_AND_MODIFIED_CODE';
    cfg.excludePaths = excludePaths;
    cfg.disableAllowed = disableAllowed;
    return new NoDestructureRule(cfg);
}

// What the engine does (#1253): it asks the rule's framework-owned excludePaths BEFORE dispatching it.
function dispatched(r: NoDestructureRule, c: EditContext): readonly unknown[] {
    return r.excludesPath(c.relativePath) ? [] : r.check(c);
}

const RN_HOOK = 'const { width } = useWindowDimensions();';

describe('NoDestructureRule — the framework-owned excludePaths (#1253)', () => {
    it('flags a destructure in a file outside excludePaths', () => {
        expect(dispatched(rule(), ctx('src/service.ts', RN_HOOK))).toHaveLength(1);
    });

    it('skips a file matched by an excludePaths glob', () => {
        expect(dispatched(rule(['mobile/**']), ctx('mobile/lang-android/Transport.tsx', RN_HOOK))).toHaveLength(0);
    });

    // The strict posture is the one where the hole existed — an inline disable is ignored there,
    // so excludePaths must still exempt the tree.
    it('skips an excludePaths file even when disableAllowed is false', () => {
        expect(dispatched(rule(['mobile/**'], false), ctx('mobile/lang-android/Transport.tsx', RN_HOOK))).toHaveLength(0);
    });

    it('still flags a sibling tree that is not exempted', () => {
        expect(dispatched(rule(['mobile/**']), ctx('apps/server/thing.ts', RN_HOOK))).toHaveLength(1);
    });

    it('the rule applies no configured path itself — the engine does', () => {
        expect(rule(['mobile/**']).check(ctx('mobile/lang-android/Transport.tsx', RN_HOOK))).toHaveLength(1);
    });
});
