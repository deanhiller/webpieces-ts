import { SourceContributionConfig } from "../source-contribution-config";
import { specTempDirs } from '@webpieces/tooling-testkit';
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';


import { FileContext } from '@webpieces/hook-runtime';
import { MaxFileLinesRule } from './max-file-lines';

// The incident this pins: a graphql-codegen client-preset output is ~42k lines because it embeds the
// whole upstream schema. Before a path exclusion existed the only escape was turnOffRuleUntilEpoch — a
// GLOBAL off-switch that also stopped the rule on hand-written files.
const GENERATED_LINES = 43_000;
const HANDWRITTEN_LINES = 1_500;

// A real (empty) directory: a violation makes the rule write its instruct-ai doc under the workspace root.
const WORKSPACE_ROOT = specTempDirs.make('wp-max-file-lines-');

function ctx(relativePath: string, projectedLines: number): FileContext {
    return new FileContext(
        'Write',
        path.join(WORKSPACE_ROOT, relativePath),
        relativePath,
        WORKSPACE_ROOT,
        null,
        projectedLines,
        0,
        0,
        projectedLines,
    );
}

function rule(excludePaths?: string[], disableAllowed = false): MaxFileLinesRule {
    const cfg = new SourceContributionConfig();
    cfg.mode = 'NEW_AND_MODIFIED_FILES';
    cfg.limit = 902;
    cfg.disableAllowed = disableAllowed;
    if (excludePaths !== undefined) cfg.excludePaths = excludePaths;
    return new MaxFileLinesRule(cfg);
}

// What the engine does (#1253): it asks the rule's framework-owned excludePaths BEFORE dispatching it.
function dispatched(r: MaxFileLinesRule, c: FileContext): readonly unknown[] {
    return r.excludesPath(c.relativePath) ? [] : r.check(c);
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

describe('MaxFileLinesRule — the framework-owned excludePaths (#1253)', () => {
    it('passes the same huge file via an excludePaths glob, applied before the rule is dispatched', () => {
        expect(dispatched(rule(['vendor/**']), ctx('vendor/sdk/client.ts', GENERATED_LINES))).toHaveLength(0);
    });

    it('the rule itself applies no configured path — only its generated-code floor', () => {
        expect(rule(['vendor/**']).check(ctx('vendor/sdk/client.ts', GENERATED_LINES))).toHaveLength(1);
    });

    // excludePaths ADDS to the built-in floor — configuring your own tree must not cost you the
    // generated-code exemption, which is how the incident would come straight back.
    it('keeps the generated exemption when excludePaths names something else entirely', () => {
        expect(dispatched(rule(['vendor/**']), ctx('services/public-api/src/__generated__/graphql.ts', GENERATED_LINES))).toHaveLength(0);
    });
});

describe('MaxFileLinesRule — hand-written files are STILL protected', () => {
    it('fails a 1,500-line hand-written file outside every exempt glob', () => {
        const violations = rule().check(ctx('services/orders/src/OrderService.ts', HANDWRITTEN_LINES));
        expect(violations).toHaveLength(1);
        expect(violations[0].message).toContain('1500');
    });

    it('fails a 1,500-line hand-written file even when excludePaths exempts a SIBLING tree', () => {
        expect(dispatched(rule(['vendor/**']), ctx('services/orders/src/OrderService.ts', HANDWRITTEN_LINES))).toHaveLength(1);
    });

    it('still passes an ordinary file under the limit', () => {
        expect(rule().check(ctx('services/orders/src/OrderService.ts', 900))).toHaveLength(0);
    });

    it('names excludePaths (not the global epoch switch, not the retired allowedPaths) as the cure', () => {
        const texts = rule().fixHint.fixOptions.map((o: { text: string }): string => o.text).join('\n');
        expect(texts).toContain('max-file-lines.excludePaths');
        expect(texts).not.toContain('allowedPaths');
        expect(texts).not.toContain('turnOffRuleUntilEpoch');
    });
});

describe('MaxFileLinesRule — mode', () => {
    it('runs under NEW_AND_MODIFIED_FILES (the mode the incident repo uses)', () => {
        expect(rule().shouldRun()).toBe(true);
    });

    it('does not run when mode is OFF', () => {
        const cfg = new SourceContributionConfig();
        cfg.mode = 'OFF';
        expect(new MaxFileLinesRule(cfg).shouldRun()).toBe(false);
    });
});
