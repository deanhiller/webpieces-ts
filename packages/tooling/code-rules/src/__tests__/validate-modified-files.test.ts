import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { MaxFileLinesConfig, GENERATED_CODE_PATHS, isPathExcluded, NoFunctionOutsideClassConfig } from '@webpieces/rules-config';

import { findViolations, exemptPathsFor, violationsError } from '../validate-modified-files';

// The build-time half of the max-file-lines path exemption. The incident: a graphql-codegen
// client-preset output is ~42k lines because it embeds the whole upstream Hasura schema, so
// `NEW_AND_MODIFIED_FILES` hard-blocked every PR that so much as touched it, and the only escape was
// `turnOffRuleUntilEpoch` — a GLOBAL off-switch that also stopped the rule on hand-written files.

const GENERATED = 'services/public-api/src/__generated__/graphql.ts';
const DOT_GENERATED = 'services/orders/src/schema.generated.ts';
const GENERATED_DIR = 'libraries/db/generated/client.ts';
const VENDOR = 'vendor/sdk/client.ts';
const HAND_WRITTEN = 'services/orders/src/OrderService.ts';

const LIMIT = 902;

let root: string;

function write(relPath: string, lineCount: number): void {
    const full = path.join(root, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'const x = 1;\n'.repeat(lineCount - 1), 'utf-8');
}

function config(allowedPaths?: string[]): MaxFileLinesConfig {
    const cfg = new MaxFileLinesConfig();
    cfg.mode = 'NEW_AND_MODIFIED_FILES';
    cfg.limit = LIMIT;
    cfg.disableAllowed = false;
    if (allowedPaths !== undefined) cfg.allowedPaths = allowedPaths;
    return cfg;
}

function offenders(files: string[], cfg: MaxFileLinesConfig): string[] {
    return findViolations(root, files, LIMIT, false, exemptPathsFor(cfg)).map((v: { file: string }): string => v.file);
}

beforeAll((): void => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-modified-files-'));
    // 43,000 lines — the real size class of the codegen output that started this.
    write(GENERATED, 43_000);
    write(DOT_GENERATED, 43_000);
    write(GENERATED_DIR, 43_000);
    write(VENDOR, 43_000);
    // A hand-written service class of exactly the size the rule exists to catch.
    write(HAND_WRITTEN, 1_500);
    write('services/orders/src/SmallService.ts', 100);
});

afterAll((): void => {
    fs.rmSync(root, { recursive: true, force: true });
});

describe('findViolations — generated code is exempt with NO configuration', () => {
    it('passes a 43,000-line file under **/__generated__/**', () => {
        expect(offenders([GENERATED], config())).toEqual([]);
    });

    it('passes *.generated.ts, a generated/ directory, and dist output', () => {
        expect(offenders([DOT_GENERATED, GENERATED_DIR], config())).toEqual([]);
        expect(isPathExcluded('apps/web/dist/main.ts', GENERATED_CODE_PATHS)).toBe(true);
    });
});

describe('findViolations — allowedPaths', () => {
    it('passes the same huge file via an explicit allowedPaths glob', () => {
        expect(offenders([VENDOR], config(['vendor/**']))).toEqual([]);
    });

    it('flags that file when allowedPaths does not cover it', () => {
        expect(offenders([VENDOR], config())).toEqual([VENDOR]);
    });

    // allowedPaths ADDS to the built-in floor, so configuring one of your own trees can never cost
    // you the generated-code exemption.
    it('keeps the generated exemption when allowedPaths names something else', () => {
        expect(offenders([GENERATED, VENDOR], config(['vendor/**']))).toEqual([]);
    });
});

describe('findViolations — hand-written files are STILL protected', () => {
    it('flags a 1,500-line hand-written file outside every exempt glob', () => {
        const violations = findViolations(root, [HAND_WRITTEN], LIMIT, false, exemptPathsFor(config()));
        expect(violations).toHaveLength(1);
        expect(violations[0].lines).toBe(1_500);
    });

    it('flags it even while a generated sibling in the same diff is exempt', () => {
        expect(offenders([GENERATED, HAND_WRITTEN], config(['vendor/**']))).toEqual([HAND_WRITTEN]);
    });

    it('passes a small hand-written file', () => {
        expect(offenders(['services/orders/src/SmallService.ts'], config())).toEqual([]);
    });
});

describe('allowedPaths glob matching agrees with no-function-outside-class', () => {
    // Both rules feed the SAME matcher (isPathExcluded) — that is what "same semantics" has to mean.
    const cases: ReadonlyArray<readonly [string, readonly string[]]> = [
        [VENDOR, ['vendor/**']],
        [VENDOR, ['vendor/sdk']],
        [HAND_WRITTEN, ['vendor/**']],
        [GENERATED, ['**/__generated__/**']],
    ];

    it.each(cases)('%s vs %s', (relPath: string, patterns: readonly string[]) => {
        const nfoc = new NoFunctionOutsideClassConfig();
        nfoc.allowedPaths = [...patterns];
        const expected = isPathExcluded(relPath, nfoc.allowedPaths) || isPathExcluded(relPath, GENERATED_CODE_PATHS);
        expect(offenders([relPath], config([...patterns])).length === 0).toBe(expected);
    });
});

describe('violationsError — one thrown failure value, cures as Option[]', () => {
    it('names allowedPaths as the cure for a machine-generated file', () => {
        const err = violationsError(findViolations(root, [HAND_WRITTEN], LIMIT, false, exemptPathsFor(config())), LIMIT, false);
        const cures = err.fixOptions.map((o: { text: string }): string => o.text).join('\n');
        expect(cures).toContain('allowedPaths');
        expect(err.ruleName).toBe('max-file-lines');
        expect(err.humanMessage).toContain(HAND_WRITTEN);
    });

    it('offers the human-only epoch hatch only as a cure, never hand-numbered in the message', () => {
        const err = violationsError(findViolations(root, [HAND_WRITTEN], LIMIT, false, exemptPathsFor(config())), LIMIT, false);
        expect(err.humanMessage).not.toContain('turnOffRuleUntilEpoch');
        expect(err.fixOptions.some((o: { text: string }): boolean => o.text.includes('turnOffRuleUntilEpoch'))).toBe(true);
        expect(err.humanMessage).not.toContain('Fix Option');
    });

    it('offers the dated inline disable instead when disableAllowed is true', () => {
        const err = violationsError(findViolations(root, [HAND_WRITTEN], LIMIT, true, exemptPathsFor(config())), LIMIT, true);
        expect(err.fixOptions.some((o: { text: string }): boolean => o.text.includes('webpieces-disable max-lines-modified-files'))).toBe(true);
    });
});
