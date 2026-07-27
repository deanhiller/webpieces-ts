import { describe, it, expect } from 'vitest';

import { NoDestructureConfig } from '@webpieces/rules-config';

import { EditContext } from '../types';
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

function rule(allowedPaths: string[] = [], disableAllowed = true): NoDestructureRule {
    const cfg = new NoDestructureConfig();
    cfg.mode = 'NEW_AND_MODIFIED_CODE';
    cfg.allowedPaths = allowedPaths;
    cfg.disableAllowed = disableAllowed;
    return new NoDestructureRule(cfg);
}

const RN_HOOK = 'const { width } = useWindowDimensions();';

describe('NoDestructureRule allowedPaths', () => {
    it('flags a destructure in a file outside allowedPaths', () => {
        expect(rule().check(ctx('src/service.ts', RN_HOOK))).toHaveLength(1);
    });

    it('skips a file matched by an allowedPaths glob', () => {
        expect(rule(['mobile/**']).check(ctx('mobile/lang-android/Transport.tsx', RN_HOOK))).toHaveLength(0);
    });

    it('skips a file under an allowedPaths directory prefix', () => {
        expect(rule(['mobile/lang-android']).check(ctx('mobile/lang-android/hooks/useThing.ts', RN_HOOK))).toHaveLength(0);
    });

    // The strict posture is the one where the hole existed — an inline disable is ignored there,
    // so allowedPaths must still exempt the tree.
    it('skips an allowedPaths file even when disableAllowed is false', () => {
        expect(rule(['mobile/**'], false).check(ctx('mobile/lang-android/Transport.tsx', RN_HOOK))).toHaveLength(0);
    });

    it('still flags a sibling tree that is not exempted', () => {
        expect(rule(['mobile/**']).check(ctx('apps/server/thing.ts', RN_HOOK))).toHaveLength(1);
    });
});
