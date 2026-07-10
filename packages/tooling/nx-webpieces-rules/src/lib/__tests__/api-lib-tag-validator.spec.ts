/**
 * Tests the two-way role:api-lib tag ⇔ code validator over synthetic scan results.
 */

import { describe, it, expect } from 'vitest';
import { ProjectInfo } from '../project-info';
import type { ApiScanResult } from '../api-usage/api-scanner';
import { findApiLibTagViolations } from '../api-usage/api-lib-tag-validator';

function infos(entries: [string, string[]][]): Map<string, ProjectInfo> {
    const map = new Map<string, ProjectInfo>();
    for (const entry of entries) {
        map.set(entry[0], new ProjectInfo(entry[0], `apps/${entry[0]}`, entry[1]));
    }
    return map;
}

function scan(apiLibs: string[], scanned: string[]): ApiScanResult {
    return {
        relationsByProject: new Map(),
        apiLibProjects: new Set(apiLibs),
        apiIndex: new Map(),
        scannedProjects: new Set(scanned),
    };
}

describe('findApiLibTagViolations', () => {
    it('flags a project that exports an API contract but is not tagged role:api-lib', () => {
        const v = findApiLibTagViolations(
            infos([['some-api', ['role:lib']]]),
            scan(['some-api'], ['some-api']),
        );
        expect(v).toEqual([{ project: 'some-api', kind: 'missing-tag' }]);
    });

    it('flags a role:api-lib project that exports NO API contract (and was scanned)', () => {
        const v = findApiLibTagViolations(
            infos([['fake-api', ['role:api-lib']]]),
            scan([], ['fake-api']),
        );
        expect(v).toEqual([{ project: 'fake-api', kind: 'unnecessary-tag' }]);
    });

    it('passes when the tag matches the code both ways', () => {
        const v = findApiLibTagViolations(
            infos([
                ['some-api', ['role:api-lib']],
                ['a-server', ['role:server']],
            ]),
            scan(['some-api'], ['some-api', 'a-server']),
        );
        expect(v).toEqual([]);
    });

    it('does NOT flag an unnecessary tag when the project was never scanned', () => {
        const v = findApiLibTagViolations(
            infos([['unscanned-api', ['role:api-lib']]]),
            scan([], []), // not in scannedProjects → can't prove it exports nothing
        );
        expect(v).toEqual([]);
    });
});
