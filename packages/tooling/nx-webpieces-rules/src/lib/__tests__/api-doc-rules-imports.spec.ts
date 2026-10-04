import { describe, expect, it } from 'vitest';
import { specTempDirs } from '@webpieces/tooling-testkit';
import { FixtureWorkspace, fixtureProjects } from './api-doc-rules-fixtures';
import { ApiDocRule, MCP_RULE, OPENAPI_RULE } from '../api-usage/api-doc-rules';
import { ApiDocRulesScan } from '../api-usage/api-doc-rules-scan';

const dirs = specTempDirs;

describe('canonical contract discovery', () => {
    it.each(['alias', 'namespace'])('finds an orphan tool through a %s import', (form: string) => {
        const root = dirs.makeReal('wp-doc-imports-');
        const imports = form === 'alias'
            ? "import { ApiPath as Path, WpMcpTool as Tool } from '@webpieces/core-util';"
            : "import * as wp from '@webpieces/core-util';";
        const path = form === 'alias' ? 'Path' : 'wp.ApiPath';
        const tool = form === 'alias' ? 'Tool' : 'wp.WpMcpTool';
        new FixtureWorkspace(root).project('aliased', `
            ${imports}
            @${path}('/alias')
            export abstract class AliasedApi {
                @${tool}('orphan', 'missing endpoint')
                abstract orphan(): Promise<void>;
            }
        `);
        const found = new ApiDocRulesScan(root, fixtureProjects('aliased'),
            ApiDocRule.armed(OPENAPI_RULE), ApiDocRule.armed(MCP_RULE)).run();
        expect(JSON.stringify(found)).toContain('orphan');
        expect(JSON.stringify(found)).toContain('Endpoint');
    });
});
