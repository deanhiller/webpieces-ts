import { OpenApiImportError } from '../OpenApiImportError';
import { SpecNode } from '../spec/SpecNode';
import { VendorSpec } from '../spec/VendorSpec';
import { JsDoc } from './JsDoc';
import { Names } from './Names';

/** The disable a generated `unknown` needs: the vendor, not us, left the value shapeless. */
const UNKNOWN_DISABLE = '// webpieces-disable no-any-unknown -- the vendor spec documents no shape for this value';

/**
 * JSON Schema -> TypeScript, collecting every DTO class and string enum the contract REACHES. A
 * schema the operations never reach is never declared. Declarations come out sorted by name, so the
 * output is byte-identical however the spec orders its components.
 *
 * - `$ref '#/components/schemas/Item'` -> class `ItemDto`; an inline object or string enum is named
 *   from where it sits (`<Parent><Property>Dto`, or the request/response name the contract gives it)
 * - `allOf` is FLATTENED into one class; `oneOf` / `anyOf` become a union
 * - an object with only `additionalProperties` -> `Record<string, T>`; a shapeless value -> `unknown`
 * - OpenAPI 3.0 `nullable: true` and 3.1 `type: [T, "null"]` -> `T | null`
 */
export class TypeEmitter {
    private readonly names = new Names();
    private readonly doc = new JsDoc();
    /** name -> the source it was declared from, to refuse two different schemas sharing one name. */
    private readonly owners = new Map<string, string>();
    /** name -> its rendered declaration. */
    private readonly declarations = new Map<string, string>();

    constructor(private readonly spec: VendorSpec) {}

    /** Every reached declaration, sorted by name. */
    rendered(): string[] {
        return [...this.declarations.keys()].sort().map((name: string) => this.declarations.get(name)!);
    }

    /**
     * The TypeScript type of `schema`. `name` is what an INLINE object or enum here is called; a
     * `$ref` keeps its component's name.
     */
    typeOf(schema: SpecNode, name: string): string {
        const ref = schema.text('$ref');
        if (ref !== undefined) return this.named(ref);
        const base = this.baseType(schema, name);
        return this.isNullable(schema) && base !== 'unknown' ? `${base} | null` : base;
    }

    private baseType(schema: SpecNode, name: string): string {
        const allOf = schema.list('allOf');
        if (allOf.length === 1 && !schema.at('properties').isPresent()) return this.typeOf(allOf[0], name);
        if (allOf.length > 0) return this.declareClass(schema, name, `inline:${name}`);
        const alternatives = [...schema.list('oneOf'), ...schema.list('anyOf')];
        if (alternatives.length > 0) {
            const members = alternatives.map((member: SpecNode, index: number) =>
                this.typeOf(member, this.names.dtoName(`${this.stem(name)}Option${index + 1}`)),
            );
            return [...new Set(members)].join(' | ');
        }
        const types = this.types(schema);
        if (schema.texts('enum').length > 0 && (types.length === 0 || types.includes('string'))) {
            return this.declareEnum(schema, name, `inline:${name}`);
        }
        if (types.includes('array') || schema.at('items').isPresent()) {
            const item = this.typeOf(schema.at('items'), name);
            return item.includes(' ') ? `(${item})[]` : `${item}[]`;
        }
        if (types.includes('object') || schema.at('properties').isPresent() || schema.at('additionalProperties').isPresent()) {
            return this.objectType(schema, name);
        }
        if (types.includes('string')) return 'string';
        if (types.includes('integer') || types.includes('number')) return 'number';
        if (types.includes('boolean')) return 'boolean';
        return 'unknown';
    }

    private objectType(schema: SpecNode, name: string): string {
        if (schema.at('properties').keys().length > 0) return this.declareClass(schema, name, `inline:${name}`);
        const additional = schema.at('additionalProperties');
        if (additional.isObject()) return `Record<string, ${this.typeOf(additional, this.names.dtoName(`${this.stem(name)}Value`))}>`;
        return 'Record<string, unknown>';
    }

    private types(schema: SpecNode): string[] {
        const single = schema.text('type');
        if (single !== undefined) return [single];
        return schema.texts('type').filter((type: string) => type !== 'null');
    }

    private isNullable(schema: SpecNode): boolean {
        return schema.flag('nullable') === true || schema.texts('type').includes('null');
    }

    /** A component `$ref` -> its declared name, declaring it the first time it is reached. */
    private named(ref: string): string {
        const name = this.names.dtoName(ref.slice(ref.lastIndexOf('/') + 1));
        if (this.claim(name, ref)) {
            const schema = this.spec.resolve(ref);
            const target = schema.text('$ref');
            if (target !== undefined) return this.named(target);
            const types = this.types(schema);
            if (schema.texts('enum').length > 0 && (types.length === 0 || types.includes('string'))) {
                this.declarations.delete(name);
                this.owners.delete(name);
                return this.declareEnum(schema, name, ref);
            }
            if (schema.at('properties').isPresent() || schema.list('allOf').length > 0 || types.includes('object')) {
                this.declarations.delete(name);
                this.owners.delete(name);
                return this.declareClass(schema, name, ref);
            }
            // A component that is a primitive, an array or a union is an alias, not a class.
            this.declarations.set(name, `export type ${name} = ${this.typeOf(schema, name)};\n`);
        }
        return name;
    }

    /** True the FIRST time `name` is claimed by `source`; refuses a second, different source. */
    private claim(name: string, source: string): boolean {
        const owner = this.owners.get(name);
        if (owner === source) return false;
        if (owner !== undefined) {
            throw new OpenApiImportError(
                `two different schemas would both generate '${name}' (${owner} and ${source})`,
                this.spec.file,
                'Rename one of the schemas, or drop one of the operations that reaches it.',
            );
        }
        this.owners.set(name, source);
        // A placeholder, so a schema that refers to itself terminates.
        this.declarations.set(name, '');
        return true;
    }

    private declareClass(schema: SpecNode, name: string, source: string): string {
        if (!this.claim(name, source)) return name;
        const properties = new Map<string, SpecNode>();
        const required = new Set<string>();
        this.collect(schema, properties, required);
        const fields: string[] = [];
        for (const property of properties.keys()) {
            const fieldSchema = properties.get(property)!;
            const type = this.typeOf(fieldSchema, this.names.dtoName(`${this.stem(name)}${this.names.pascal(property)}`));
            const doc = this.doc.block(this.doc.prose(fieldSchema.text('description') ?? this.spec.deref(fieldSchema).text('description')), '    ');
            const disable = type.includes('unknown') ? `    ${UNKNOWN_DISABLE}\n` : '';
            const mark = required.has(property) ? '!' : '?';
            fields.push(`${doc}${disable}    ${this.names.property(property)}${mark}: ${type};\n`);
        }
        const classDoc = this.doc.block(this.doc.prose(schema.text('description')), '');
        const body = fields.length === 0 ? '{}' : `{\n${fields.join('\n')}}`;
        this.declarations.set(name, `${classDoc}export class ${name} ${body}\n`);
        return name;
    }

    /** Properties and `required` of `schema` and, flattened, of every `allOf` part. */
    private collect(schema: SpecNode, properties: Map<string, SpecNode>, required: Set<string>): void {
        for (const part of schema.list('allOf')) this.collect(this.spec.deref(part), properties, required);
        const own = schema.at('properties');
        for (const key of own.keys()) properties.set(key, own.at(key));
        for (const key of schema.texts('required')) required.add(key);
    }

    private declareEnum(schema: SpecNode, name: string, source: string): string {
        if (!this.claim(name, source)) return name;
        const used = new Set<string>();
        const members = schema.texts('enum').map((value: string) => {
            let member = this.names.enumMember(value);
            for (let n = 2; used.has(member); n++) member = `${this.names.enumMember(value)}_${n}`;
            used.add(member);
            return `    ${member} = ${this.names.literal(value)},\n`;
        });
        const doc = this.doc.block(this.doc.prose(schema.text('description')), '');
        this.declarations.set(name, `${doc}export enum ${name} {\n${members.join('')}}\n`);
        return name;
    }

    /** A declared name without its `Dto` / `Request` / `Response` suffix, for naming what it contains. */
    private stem(name: string): string {
        return name.replace(/(Dto|Request|Response)$/, '');
    }
}
