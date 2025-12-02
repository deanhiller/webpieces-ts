import { FilterMatcher, HttpFilter } from './FilterMatcher';
import { Filter, WpResponse, Service } from '@webpieces/http-filters';
import { FilterDefinition } from '@webpieces/core-meta';
import { MethodMeta } from './MethodMeta';

/**
 * Mock filter implementation for testing.
 */
class MockFilter extends Filter<MethodMeta, WpResponse<unknown>> {
    constructor(public priority: number) {
        super();
    }

    async filter(
        meta: MethodMeta,
        nextFilter: Service<MethodMeta, WpResponse<unknown>>,
    ): Promise<WpResponse<unknown>> {
        return nextFilter.invoke(meta);
    }
}

describe('FilterMatcher', () => {
    describe('findMatchingFilters', () => {
        it('should match all filters when no pattern is specified', () => {
            const filter1 = new MockFilter(100);
            const filter2 = new MockFilter(50);

            const def1 = new FilterDefinition(100, MockFilter, '*');
            def1.filter = filter1;
            const def2 = new FilterDefinition(50, MockFilter, '*');
            def2.filter = filter2;

            const registry = [def1, def2];

            const result = FilterMatcher.findMatchingFilters(
                'src/controllers/SaveController.ts',
                registry,
            );

            expect(result).toEqual([filter1, filter2]);
        });

        it('should match glob pattern for admin controllers', () => {
            const adminFilter = new MockFilter(100);
            const globalFilter = new MockFilter(50);

            const adminDef = new FilterDefinition(100, MockFilter, 'src/controllers/admin/**/*.ts');
            adminDef.filter = adminFilter;
            const globalDef = new FilterDefinition(50, MockFilter, '*');
            globalDef.filter = globalFilter;

            const registry = [adminDef, globalDef];

            // Should match admin controller
            let result = FilterMatcher.findMatchingFilters(
                'src/controllers/admin/UserController.ts',
                registry,
            );
            expect(result).toEqual([adminFilter, globalFilter]);

            // Should NOT match non-admin controller
            result = FilterMatcher.findMatchingFilters(
                'src/controllers/SaveController.ts',
                registry,
            );
            expect(result).toEqual([globalFilter]);
        });

        it('should match specific controller file', () => {
            const specificFilter = new MockFilter(100);

            const def = new FilterDefinition(100, MockFilter, '**/SaveController.ts');
            def.filter = specificFilter;

            const registry = [def];

            const result = FilterMatcher.findMatchingFilters(
                'src/controllers/SaveController.ts',
                registry,
            );

            expect(result).toEqual([specificFilter]);
        });

        it('should match wildcard patterns', () => {
            const wildcardFilter = new MockFilter(100);

            const def = new FilterDefinition(100, MockFilter, '**/admin/**');
            def.filter = wildcardFilter;

            const registry = [def];

            // Should match anything in admin directory
            let result = FilterMatcher.findMatchingFilters(
                'src/controllers/admin/UserController.ts',
                registry,
            );
            expect(result).toEqual([wildcardFilter]);

            result = FilterMatcher.findMatchingFilters(
                'apps/admin/modules/TestController.ts',
                registry,
            );
            expect(result).toEqual([wildcardFilter]);

            // Should NOT match non-admin paths
            result = FilterMatcher.findMatchingFilters(
                'src/controllers/SaveController.ts',
                registry,
            );
            expect(result).toEqual([]);
        });

        it('should sort filters by priority (highest first)', () => {
            const filter1 = new MockFilter(50);
            const filter2 = new MockFilter(100);
            const filter3 = new MockFilter(75);

            const def1 = new FilterDefinition(50, MockFilter, '*');
            def1.filter = filter1;
            const def2 = new FilterDefinition(100, MockFilter, '*');
            def2.filter = filter2;
            const def3 = new FilterDefinition(75, MockFilter, '*');
            def3.filter = filter3;

            const registry = [def1, def2, def3];

            const result = FilterMatcher.findMatchingFilters(
                'src/controllers/SaveController.ts',
                registry,
            );

            expect(result).toEqual([filter2, filter3, filter1]);
        });

        it('should handle undefined filepath gracefully', () => {
            const globalFilter = new MockFilter(100);
            const specificFilter = new MockFilter(50);

            const globalDef = new FilterDefinition(100, MockFilter, '*');
            globalDef.filter = globalFilter;
            const specificDef = new FilterDefinition(50, MockFilter, 'src/**/*.ts');
            specificDef.filter = specificFilter;

            const registry = [globalDef, specificDef];

            // When filepath is undefined, only wildcard patterns should match
            const result = FilterMatcher.findMatchingFilters(undefined, registry);

            expect(result).toEqual([globalFilter]);
        });

        it('should handle explicit wildcard patterns with undefined filepath', () => {
            const wildcardFilter1 = new MockFilter(100);
            const wildcardFilter2 = new MockFilter(90);
            const specificFilter = new MockFilter(50);

            const def1 = new FilterDefinition(100, MockFilter, '*');
            def1.filter = wildcardFilter1;
            const def2 = new FilterDefinition(90, MockFilter, '**/*');
            def2.filter = wildcardFilter2;
            const def3 = new FilterDefinition(50, MockFilter, 'src/**/*.ts');
            def3.filter = specificFilter;

            const registry = [def1, def2, def3];

            const result = FilterMatcher.findMatchingFilters(undefined, registry);

            // Both wildcard filters should match
            expect(result).toEqual([wildcardFilter1, wildcardFilter2]);
        });

        it('should handle empty filter registry', () => {
            const result = FilterMatcher.findMatchingFilters(
                'src/controllers/SaveController.ts',
                [],
            );

            expect(result).toEqual([]);
        });
    });

    describe('normalizeFilepath', () => {
        it('should convert backslashes to forward slashes', () => {
            const result = FilterMatcher.normalizeFilepath('src\\controllers\\SaveController.ts');
            expect(result).toBe('src/controllers/SaveController.ts');
        });

        it('should remove leading ./', () => {
            const result = FilterMatcher.normalizeFilepath('./src/controllers/SaveController.ts');
            expect(result).toBe('src/controllers/SaveController.ts');
        });

        it('should handle mixed backslashes and leading ./', () => {
            const result = FilterMatcher.normalizeFilepath(
                '.\\src\\controllers\\SaveController.ts',
            );
            expect(result).toBe('src/controllers/SaveController.ts');
        });

        it('should leave already normalized paths unchanged', () => {
            const result = FilterMatcher.normalizeFilepath('src/controllers/SaveController.ts');
            expect(result).toBe('src/controllers/SaveController.ts');
        });
    });
});
