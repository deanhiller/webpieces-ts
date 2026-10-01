/**
 * The wire closure (#1064, D4): every type an `@ApiPath` contract reaches must be declared in a
 * `role:api-lib` project and carry the suffix its `required-type-suffix` entry demands — checked inside
 * the `api-rules-for-openapi` / `api-rules-for-mcp` scan, so it needs no generate tag.
 *
 * The contract reaches its DTO through a RELATIVE import into another project — exactly the shape the
 * dependency rule cannot see, because no nx edge is involved.
 */
import * as fs from 'fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RequiredTypeSuffixEntry, specTempDirs } from '@webpieces/rules-config';
import { ProjectInfo } from '../project-info';
import { ApiContractDefect, ApiDocRule, MCP_RULE, OPENAPI_RULE } from '../api-usage/api-doc-rules';
import { ApiDocRulesScan } from '../api-usage/api-doc-rules-scan';
import { WireClosureRule } from '../api-usage/wire-closure';
import { FixtureWorkspace } from './api-doc-rules-fixtures';

let root = '';

beforeEach(() => {
    root = specTempDirs.make('wp-wire-closure-');
    const fx = new FixtureWorkspace(root);
    fx.project('lang-apis', `/** Lessons. */
    import { AiProvider, LessonDto } from '../../company-core/src/index';

    @ApiPath('/lessons')
    export abstract class LessonApi {
        /** Fetch one lesson. */
        @Endpoint('POST', '/fetch', 'read', 'rpc')
        @WpAuthJwt({ allRolesAllowed: true })
        abstract fetch(request: FetchLessonRequest): Promise<FetchLessonResponse>;
    }

    /** What to fetch. */
    export interface FetchLessonRequest {
        /** The lesson id. */
        id: string;
        /** Which model wrote it. */
        provider: AiProvider;
    }

    /** The lesson. */
    export interface FetchLessonResponse {
        /** The lesson. */
        lesson: LessonDto;
    }
`);
    fx.project('company-core', `
    /** Which model. */
    export enum AiProvider { CLAUDE = 'claude', CHATGPT = 'chatgpt' }

    /** One lesson. */
    export interface LessonDto {
        /** Its title. */
        title: string;
    }
`);
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

function infos(companyCoreRole: string): Map<string, ProjectInfo> {
    const map = new Map<string, ProjectInfo>();
    map.set('lang-apis', new ProjectInfo('lang-apis', 'libraries/lang-apis', ['role:api-lib']));
    map.set('company-core', new ProjectInfo('company-core', 'libraries/company-core', [`role:${companyCoreRole}`]));
    return map;
}

function suffixes(...list: string[]): WireClosureRule {
    const entry = new RequiredTypeSuffixEntry();
    entry.paths = ['libraries/**'];
    entry.suffixes = list;
    return new WireClosureRule([entry]);
}

function wireDefects(companyCoreRole: string, rule: WireClosureRule): string[] {
    const findings = new ApiDocRulesScan(
        root,
        infos(companyCoreRole),
        ApiDocRule.armed(OPENAPI_RULE),
        ApiDocRule.armed(MCP_RULE),
        rule,
    ).run();
    return findings.openApi.violations
        .filter((d: ApiContractDefect) => d.what.includes('goes over the wire'))
        .map((d: ApiContractDefect) => `${d.what} || ${d.cure}`);
}

describe('wire closure (D4)', () => {
    it('RED: a contract reaching types declared in a role:lib package is refused, naming the type, its package and the fix', () => {
        const found = wireDefects('lib', WireClosureRule.withoutSuffixes());
        expect(found).toHaveLength(2);
        expect(found[0]).toContain(
            "'AiProvider' goes over the wire but is declared in no package (project 'company-core', role:lib), " +
                'which is not a role:api-lib project — every type a contract reaches must be declared in an api library',
        );
        expect(found[0]).toContain("Move 'AiProvider' into a role:api-lib project — as a '…Dto' string enum");
        expect(found[1]).toContain("'LessonDto' goes over the wire");
    });

    it('GREEN: the same types declared in a role:api-lib project pass', () => {
        expect(wireDefects('api-lib', WireClosureRule.withoutSuffixes())).toEqual([]);
    });

    it('RED: a reached type missing its required-type-suffix suffix is refused', () => {
        const found = wireDefects('api-lib', suffixes('Request', 'Response', 'Dto'));
        expect(found).toEqual([
            expect.stringContaining(
                "'AiProvider' goes over the wire from libraries/company-core/src/index.ts but does not end in one of " +
                    "[Request, Response, Dto], which the required-type-suffix entry 'libraries/**' demands of it",
            ),
        ]);
    });

    it('nothing runs when both doc rules are OFF', () => {
        const findings = new ApiDocRulesScan(root, infos('lib'), ApiDocRule.off(OPENAPI_RULE), ApiDocRule.off(MCP_RULE)).run();
        expect(findings.openApi.isEmpty() && findings.mcp.isEmpty()).toBe(true);
    });
});
