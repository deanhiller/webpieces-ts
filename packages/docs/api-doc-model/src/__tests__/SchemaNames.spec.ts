import { describe, expect, it } from 'vitest';
import { SchemaNameEntry, SchemaNames } from '../model/SchemaNames';

describe('published schema suffixes', () => {
    const names = new SchemaNames([
        new SchemaNameEntry(['/repo/keep/**'], []),
        new SchemaNameEntry(['/repo/**'], ['Dto']),
    ]);

    it('strips exactly one case-sensitive trailing suffix with a non-empty stem', () => {
        expect(names.nameOf('OrderDto', '/repo/api/Order.ts')).toBe('Order');
        expect(names.nameOf('Dto', '/repo/api/Order.ts')).toBe('Dto');
        expect(names.nameOf('DtoOrder', '/repo/api/Order.ts')).toBe('DtoOrder');
        expect(names.nameOf('OrderDTO', '/repo/api/Order.ts')).toBe('OrderDTO');
        expect(names.nameOf('OrderDtoDto', '/repo/api/Order.ts')).toBe('OrderDto');
    });

    it('preserves uncovered paths and uses the first match, including an explicit exemption', () => {
        expect(names.nameOf('OrderDto', '/other/Order.ts')).toBe('OrderDto');
        expect(names.nameOf('OrderDto', '/repo/keep/Order.ts')).toBe('OrderDto');
    });
});
