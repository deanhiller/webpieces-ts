import { FilterMatcher } from './FilterMatcher';
import { Filter, MethodMeta, Action, NextFilter } from '@webpieces/http-filters';
import { FilterDefinition } from '@webpieces/core-meta';

/**
 * Mock filter implementation for testing.
 */
class MockFilter implements Filter {
  constructor(public priority: number) {}

  async filter(meta: MethodMeta, next: NextFilter): Promise<Action> {
    return next.execute();
  }
}

describe('FilterMatcher', () => {
  describe('findMatchingFilters', () => {
    it('should match all filters when no pattern is specified', () => {
      const filter1 = new MockFilter(100);
      const filter2 = new MockFilter(50);

      const registry = [
        { filter: filter1, definition: { priority: 100, filterClass: MockFilter } },
        { filter: filter2, definition: { priority: 50, filterClass: MockFilter } },
      ];

      const result = FilterMatcher.findMatchingFilters(
        'src/controllers/SaveController.ts',
        registry
      );

      expect(result).toEqual([filter1, filter2]);
    });

    it('should match glob pattern for admin controllers', () => {
      const adminFilter = new MockFilter(100);
      const globalFilter = new MockFilter(50);

      const registry = [
        {
          filter: adminFilter,
          definition: {
            priority: 100,
            filterClass: MockFilter,
            filepathPattern: 'src/controllers/admin/**/*.ts',
          },
        },
        {
          filter: globalFilter,
          definition: { priority: 50, filterClass: MockFilter },
        },
      ];

      // Should match admin controller
      let result = FilterMatcher.findMatchingFilters(
        'src/controllers/admin/UserController.ts',
        registry
      );
      expect(result).toEqual([adminFilter, globalFilter]);

      // Should NOT match non-admin controller
      result = FilterMatcher.findMatchingFilters(
        'src/controllers/SaveController.ts',
        registry
      );
      expect(result).toEqual([globalFilter]);
    });

    it('should match specific controller file', () => {
      const specificFilter = new MockFilter(100);

      const registry = [
        {
          filter: specificFilter,
          definition: {
            priority: 100,
            filterClass: MockFilter,
            filepathPattern: '**/SaveController.ts',
          },
        },
      ];

      const result = FilterMatcher.findMatchingFilters(
        'src/controllers/SaveController.ts',
        registry
      );

      expect(result).toEqual([specificFilter]);
    });

    it('should match wildcard patterns', () => {
      const wildcardFilter = new MockFilter(100);

      const registry = [
        {
          filter: wildcardFilter,
          definition: {
            priority: 100,
            filterClass: MockFilter,
            filepathPattern: '**/admin/**',
          },
        },
      ];

      // Should match anything in admin directory
      let result = FilterMatcher.findMatchingFilters(
        'src/controllers/admin/UserController.ts',
        registry
      );
      expect(result).toEqual([wildcardFilter]);

      result = FilterMatcher.findMatchingFilters(
        'apps/admin/modules/TestController.ts',
        registry
      );
      expect(result).toEqual([wildcardFilter]);

      // Should NOT match non-admin paths
      result = FilterMatcher.findMatchingFilters(
        'src/controllers/SaveController.ts',
        registry
      );
      expect(result).toEqual([]);
    });

    it('should sort filters by priority (highest first)', () => {
      const filter1 = new MockFilter(50);
      const filter2 = new MockFilter(100);
      const filter3 = new MockFilter(75);

      const registry = [
        { filter: filter1, definition: { priority: 50, filterClass: MockFilter } },
        { filter: filter2, definition: { priority: 100, filterClass: MockFilter } },
        { filter: filter3, definition: { priority: 75, filterClass: MockFilter } },
      ];

      const result = FilterMatcher.findMatchingFilters(
        'src/controllers/SaveController.ts',
        registry
      );

      expect(result).toEqual([filter2, filter3, filter1]);
    });

    it('should handle undefined filepath gracefully', () => {
      const globalFilter = new MockFilter(100);
      const specificFilter = new MockFilter(50);

      const registry = [
        { filter: globalFilter, definition: { priority: 100, filterClass: MockFilter } },
        {
          filter: specificFilter,
          definition: {
            priority: 50,
            filterClass: MockFilter,
            filepathPattern: 'src/**/*.ts',
          },
        },
      ];

      // When filepath is undefined, only wildcard patterns should match
      const result = FilterMatcher.findMatchingFilters(undefined, registry);

      expect(result).toEqual([globalFilter]);
    });

    it('should handle explicit wildcard patterns with undefined filepath', () => {
      const wildcardFilter1 = new MockFilter(100);
      const wildcardFilter2 = new MockFilter(90);
      const specificFilter = new MockFilter(50);

      const registry = [
        {
          filter: wildcardFilter1,
          definition: {
            priority: 100,
            filterClass: MockFilter,
            filepathPattern: '*',
          },
        },
        {
          filter: wildcardFilter2,
          definition: {
            priority: 90,
            filterClass: MockFilter,
            filepathPattern: '**/*',
          },
        },
        {
          filter: specificFilter,
          definition: {
            priority: 50,
            filterClass: MockFilter,
            filepathPattern: 'src/**/*.ts',
          },
        },
      ];

      const result = FilterMatcher.findMatchingFilters(undefined, registry);

      // Both wildcard filters should match
      expect(result).toEqual([wildcardFilter1, wildcardFilter2]);
    });

    it('should handle empty filter registry', () => {
      const result = FilterMatcher.findMatchingFilters(
        'src/controllers/SaveController.ts',
        []
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
      const result = FilterMatcher.normalizeFilepath('.\\src\\controllers\\SaveController.ts');
      expect(result).toBe('src/controllers/SaveController.ts');
    });

    it('should leave already normalized paths unchanged', () => {
      const result = FilterMatcher.normalizeFilepath('src/controllers/SaveController.ts');
      expect(result).toBe('src/controllers/SaveController.ts');
    });
  });
});
