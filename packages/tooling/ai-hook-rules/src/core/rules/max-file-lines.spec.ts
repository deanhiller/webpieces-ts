import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { MaxFileLinesConfig, GENERATED_CODE_PATHS, isPathExcluded, NoFunctionOutsideClassConfig } from '@webpieces/rules-config';

import { FileContext } from '../types';
import { MaxFileLinesRule } from './max-file-lines';

// The incident this pins: a graphql-codegen client-preset output is ~42k lines because it embeds the
// whole upstream schema. Before allowedPaths the only escape was turnOffRuleUntilEpoch — a GLOBAL
// off-switch that also stopped the rule on hand-written files.
const GENERATED_LINES = 43_000;
const HANDWRITTEN_LINES = 1_500;

// A real (empty) directory: a violation makes the rule write its instruct-ai doc under the workspace root.
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-max-file-lines-'));

function ctx(relativePath: string, projectedLines: number): FileContext {
    return new FileContext(
        'Write',
        path.join(WORKSPACE_ROOT, relativePath),
        relativePath,
        WORKSPACE_ROOT,
        projectedLines,
        0,
        0,
        projectedLines,
    );
}

function rule(allowedPaths?: string[], disableAllowed = false): MaxFileLinesRule {
    const cfg = new MaxFileLinesConfig();
    cfg.mode = 'NEW_AND_MODIFIED_FILES';
    cfg.limit = 902;
    cfg.disableAllowed = disableAllowed;
    if (allowedPaths !== undefined) cfg.allowedPaths = allowedPaths;
    return new MaxFileLinesRule(cfg);
}

describe('MaxFileLinesRule — generated code is exempt with NO configuration', () => {
    it('passes a 43,000-line file under **/__generated__/**', () => {
        expect(rule().check(ctx('services/public-api/src/__generated__/graphql.ts', GENERATED_LINES))).toHaveLength(0);
    });

    it('passes a *.generated.ts file', () => {
        expect(rule().check(ctx('services/orders/src/schema.generated.ts', GENERATED_LINES))).toHaveLength(0);
    });

    it('passes a file under a generated/ directory', () => {
        expect(rule().check(ctx('libraries/db/generated/client.ts', GENERATED_LINES))).toHaveLength(0);
    });

    it('passes build output under dist', () => {
        expect(rule().check(ctx('apps/web/dist/main.ts', GENERATED_LINES))).toHaveLength(0);
    });
});

describe('MaxFileLinesRule — allowedPaths', () => {
    it('passes the same huge file via an explicit allowedPaths glob', () => {
        expect(rule(['vendor/**']).check(ctx('vendor/sdk/client.ts', GENERATED_LINES))).toHaveLength(0);
    });

    it('passes via an allowedPaths directory prefix', () => {
        expect(rule(['vendor/sdk']).check(ctx('vendor/sdk/nested/client.ts', GENERATED_LINES))).toHaveLength(0);
    });

    // allowedPaths ADDS to the built-in floor — configuring your own tree must not cost you the
    // generated-code exemption, which is how the incident would come straight back.
    it('keeps the generated exemption when allowedPaths names something else entirely', () => {
        expect(rule(['vendor/**']).check(ctx('services/public-api/src/__generated__/graphql.ts', GENERATED_LINES))).toHaveLength(0);
    });
});

describe('MaxFileLinesRule — hand-written files are STILL protected', () => {
    it('fails a 1,500-line hand-written file outside every exempt glob', () => {
        const violations = rule().check(ctx('services/orders/src/OrderService.ts', HANDWRITTEN_LINES));
        expect(violations).toHaveLength(1);
        expect(violations[0].message).toContain('1500');
    });

    it('fails a 1,500-line hand-written file even when allowedPaths exempts a SIBLING tree', () => {
        expect(rule(['vendor/**']).check(ctx('services/orders/src/OrderService.ts', HANDWRITTEN_LINES))).toHaveLength(1);
    });

    it('still passes an ordinary file under the limit', () => {
        expect(rule().check(ctx('services/orders/src/OrderService.ts', 900))).toHaveLength(0);
    });

    it('names allowedPaths (not the global epoch switch) as the cure for a generated file', () => {
        const texts = rule().fixHint.fixOptions.map((o: { text: string }): string => o.text).join('\n');
        expect(texts).toContain('max-file-lines.allowedPaths');
        expect(texts).not.toContain('turnOffRuleUntilEpoch');
    });
});

describe('MaxFileLinesRule — mode', () => {
    it('runs under NEW_AND_MODIFIED_FILES (the mode the incident repo uses)', () => {
        expect(rule().shouldRun()).toBe(true);
    });

    it('does not run when mode is OFF', () => {
        const cfg = new MaxFileLinesConfig();
        cfg.mode = 'OFF';
        expect(new MaxFileLinesRule(cfg).shouldRun()).toBe(false);
    });
});

describe('allowedPaths glob matching agrees with no-function-outside-class', () => {
    // Both rules feed the SAME matcher (isPathExcluded), which is what "same semantics" has to mean.
    const cases = [
        ['mobile/lang-android/Transport.tsx', ['mobile/**']],
        ['mobile/lang-android/hooks/useThing.ts', ['mobile/lang-android']],
        ['apps/server/thing.ts', ['mobile/**']],
        ['services/public-api/src/__generated__/graphql.ts', ['**/__generated__/**']],
    ] as const;

    it.each(cases)('%s vs %s', (relPath: string, patterns: readonly string[]) => {
        const nfoc = new NoFunctionOutsideClassConfig();
        nfoc.allowedPaths = [...patterns];
        const expected = isPathExcluded(relPath, nfoc.allowedPaths);

        // The max-file-lines answer for the SAME patterns: exempt (no violation) iff the matcher says so,
        // once the generated floor is discounted.
        const exemptByFloor = isPathExcluded(relPath, GENERATED_CODE_PATHS);
        const flagged = rule([...patterns]).check(ctx(relPath, GENERATED_LINES)).length > 0;
        expect(!flagged).toBe(expected || exemptByFloor);
    });
});
