/** TypeScript identifiers made from vendor names (operationIds, schema keys, property names). */
export class Names {
    /** The words of a name: split on non-alphanumerics and on lower→Upper boundaries. */
    words(name: string): string[] {
        return name
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .split(/[^A-Za-z0-9]+/)
            .filter((word: string) => word !== '');
    }

    pascal(name: string): string {
        const joined = this.words(name)
            .map((word: string) => word.charAt(0).toUpperCase() + word.slice(1))
            .join('');
        return /^[0-9]/.test(joined) ? `N${joined}` : joined;
    }

    camel(name: string): string {
        const pascal = this.pascal(name);
        return pascal.charAt(0).toLowerCase() + pascal.slice(1);
    }

    /** `items.GetItems` -> `getItems`: the segment after the last `.`, camel-cased. */
    methodName(operationId: string): string {
        const segment = operationId.slice(operationId.lastIndexOf('.') + 1);
        return this.camel(segment);
    }

    /** A DTO class / enum name from a schema key, always ending in `Dto`. */
    dtoName(base: string): string {
        const pascal = this.pascal(base);
        return pascal.endsWith('Dto') ? pascal : `${pascal}Dto`;
    }

    /** A property name as written on a class: bare when it is an identifier, quoted otherwise. */
    property(name: string): string {
        return /^[A-Za-z_$][\w$]*$/.test(name) ? name : `'${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    }

    /** A string enum MEMBER name from its value: `in-progress` -> `IN_PROGRESS`. */
    enumMember(value: string): string {
        const member = this.words(value)
            .map((word: string) => word.toUpperCase())
            .join('_');
        if (member === '') return 'EMPTY';
        return /^[0-9]/.test(member) ? `V_${member}` : member;
    }

    /** A single-quoted TypeScript string literal. */
    literal(value: string): string {
        return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
    }
}
