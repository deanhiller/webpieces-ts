import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'node:path';
import * as ts from 'typescript';
import { ApiDocExtractor } from '../extract/ApiDocExtractor';
import { ApiDocExtractionError } from '../extract/ApiDocExtractionError';
import {
    ApiDocModel,
    DocumentedEndpoint,
    DocumentedField,
    DocumentedType,
    UnmappedType,
} from '../model/ApiDocModel';
import { TypeRef } from '../model/TypeRef';

/**
 * The vitest matrix issue #981 enumerates, one `it` per row.
 *
 * Every assertion is made against a FIXTURE CONTRACT written as ordinary TypeScript
 * (`fixtures/ExampleApi.ts`), never against a hand-built AST: what this package has to survive is
 * source somebody actually wrote, and a synthetic tree would quietly stop resembling that.
 */

/** Decorators are legal in the fixtures, so the program has to be built with them enabled. */
const COMPILER_OPTIONS: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    experimentalDecorators: true,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
};

class Harness {
    fixture(name: string): string {
        return path.join(__dirname, 'fixtures', name);
    }

    extract(name: string): ApiDocModel {
        return new ApiDocExtractor().extractFile(this.fixture(name), COMPILER_OPTIONS);
    }

    /**
     * The failure an extraction threw, or undefined when it did not throw. A method rather than a
     * try/catch per test: the catch is the assertion, and one of them is enough.
     */
    failureOf(name: string): ApiDocExtractionError | undefined {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- the throw IS what this method returns
        try {
            this.extract(name);
            return undefined;
        } catch (err: unknown) {
            //const error = toError(err);
            return err instanceof ApiDocExtractionError ? err : undefined;
        }
    }

    endpoint(model: ApiDocModel, methodName: string): DocumentedEndpoint {
        const found = model.endpoints.find((e: DocumentedEndpoint) => e.methodName === methodName);
        expect(found, `no endpoint '${methodName}'`).toBeDefined();
        return found!;
    }

    type(model: ApiDocModel, name: string): DocumentedType {
        const found = model.types.get(name);
        expect(found, `no type '${name}'`).toBeDefined();
        return found!;
    }

    field(type: DocumentedType, name: string): DocumentedField {
        const found = type.fields.find((f: DocumentedField) => f.name === name);
        expect(found, `no field '${name}' on ${type.name}`).toBeDefined();
        return found!;
    }
}

const harness = new Harness();
let model: ApiDocModel;

beforeAll(() => {
    model = harness.extract('ExampleApi.ts');
});

describe('the contract itself', () => {
    it('reads the class, its @ApiPath and its prose, with {@link} flattened', () => {
        expect(model.contractName).toBe('ExampleApi');
        expect(model.basePath).toBe('/api/example');
        // `{@link Customer.email}` became plain text at THIS boundary, so no renderer needs the grammar.
        expect(model.description).toContain('Customer.email');
        expect(model.description).not.toContain('@link');
    });

    it('FOLDS a path held in a constant, across an import', () => {
        expect(harness.endpoint(model, 'save').path).toBe('/save');
    });

    it('records every EndpointKind verbatim, inventing no taxonomy', () => {
        expect(harness.endpoint(model, 'save').kind).toBe('rpc');
        expect(harness.endpoint(model, 'enqueue').kind).toBe('cloudtasks');
        expect(harness.endpoint(model, 'nightly').kind).toBe('cron');
        expect(harness.endpoint(model, 'hook').kind).toBe('external');
    });

    it('records `hidden`, and leaves it false where it was not declared', () => {
        expect(harness.endpoint(model, 'internal').hidden).toBe(true);
        expect(harness.endpoint(model, 'save').hidden).toBe(false);
    });

    it('records EndpointOptions — formPost, calledBy, callerKind', () => {
        const hook = harness.endpoint(model, 'hook');
        expect(hook.options.formPost).toBe(true);
        expect(hook.options.calledBy).toBe('twilio');
        expect(hook.options.callerKind).toBe('vendor');
        expect(harness.endpoint(model, 'save').options.formPost).toBe(false);
    });

    it('records the @WpAuth* declaration, the @WpMcpTool, the @WpMcpAuthJwt and the @MaskLog', () => {
        const save = harness.endpoint(model, 'save');
        expect(save.auth?.decorator).toBe('WpAuthJwt');
        expect(save.mcpTool?.name).toBe('save_customer');
        expect(save.mcpTool?.hints.get('readOnly')).toBe(false);
        expect(save.mcpTool?.hints.get('idempotent')).toBe(true);
        expect(save.mcpAuthText).toContain('admin');
        expect(save.maskLog.get('secretToken')).toBe('full');

        // @WpMcpAuthJwt must NOT be mistaken for the endpoint's own credential declaration.
        expect(harness.endpoint(model, 'hook').auth?.decorator).toBe('WpAuthPublic');
    });

    it('captures @mcp where it was written, and leaves it UNDEFINED where it was not', () => {
        expect(harness.endpoint(model, 'save').mcpDescription).toContain('Create or update');
        // Undefined, not defaulted: "the author wrote an agent-facing sentence" is worth knowing.
        expect(harness.endpoint(model, 'enqueue').mcpDescription).toBeUndefined();
        expect(harness.endpoint(model, 'enqueue').description).toContain('Enqueued by a producer');
    });

    it('resolves the request and response DTOs to $ref-able named entries', () => {
        const save = harness.endpoint(model, 'save');
        expect(save.request).toEqual(TypeRef.ref('SaveRequest'));
        expect(save.response).toEqual(TypeRef.ref('SaveResponse'));
    });
});

describe('the DTO graph', () => {
    it('distinguishes OPTIONAL from NULLABLE', () => {
        const customer = harness.type(model, 'Customer');
        const nickname = harness.field(customer, 'nickname');
        const middleName = harness.field(customer, 'middleName');

        expect(nickname.optional).toBe(true);
        expect(nickname.nullable).toBe(false);
        expect(middleName.optional).toBe(false);
        expect(middleName.nullable).toBe(true);
        // `{}` and `{middleName: null}` are different documents; the model must not conflate them.
        expect(middleName.type).toEqual(TypeRef.primitiveOf('string'));
    });

    it('turns a NAMED string-literal union into one enum entry', () => {
        expect(harness.type(model, 'Color').enumValues).toEqual(['red', 'green', 'blue']);
        expect(harness.field(harness.type(model, 'Customer'), 'colour').type).toEqual(
            TypeRef.ref('Color'),
        );
    });

    it('turns Record<string, X> into an OPEN MAP', () => {
        expect(harness.field(harness.type(model, 'Customer'), 'tags').type).toEqual(
            TypeRef.openMap(TypeRef.primitiveOf('string')),
        );
    });

    it('lifts @format onto the scalar, and on an array onto the ITEM', () => {
        const customer = harness.type(model, 'Customer');
        expect(harness.field(customer, 'email').format).toBe('email');
        const visitedAt = harness.field(customer, 'visitedAt');
        expect(visitedAt.type).toEqual(TypeRef.array(TypeRef.primitiveOf('string')));
        // The field is an ARRAY, so the format describes the item — a list is never a date-time.
        expect(visitedAt.format).toBe('date-time');
    });

    it('captures @mcp on a FIELD too', () => {
        expect(
            harness.field(harness.type(model, 'Customer'), 'orderCount').mcpDescription,
        ).toContain('lifetime order count');
        expect(
            harness.field(harness.type(model, 'Customer'), 'email').mcpDescription,
        ).toBeUndefined();
    });

    it('TERMINATES on a cyclic DTO, by making it ONE entry it refers back to', () => {
        const tree = harness.type(model, 'TreeNode');
        expect(harness.field(tree, 'children').type).toEqual(
            TypeRef.array(TypeRef.ref('TreeNode')),
        );
        expect(harness.field(tree, 'parent').type).toEqual(TypeRef.ref('TreeNode'));
        expect(harness.field(tree, 'parent').optional).toBe(true);
    });

    it('does NOT truncate a deep-but-finite graph — all 8 named hops are present', () => {
        // The whole point of having no depth counter: a truncated graph publishes a document that is
        // quietly missing a field, and nothing downstream can tell.
        for (const hop of ['Hop1', 'Hop2', 'Hop3', 'Hop4', 'Hop5', 'Hop6', 'Hop7', 'Hop8']) {
            expect(model.types.has(hop), `${hop} missing`).toBe(true);
        }
        expect(harness.field(harness.type(model, 'Hop8'), 'leaf').type).toEqual(
            TypeRef.primitiveOf('string'),
        );
    });
});

describe('unions', () => {
    it('DERIVES a discriminator when every branch carries one string literal', () => {
        const shape = harness.type(model, 'Shape');
        expect(shape.unionRefNames).toEqual(['Circle', 'Square']);
        expect(shape.discriminator?.propertyName).toBe('kind');
        expect(shape.discriminator?.branchValues.get('Circle')).toBe('circle');
        expect(shape.discriminator?.branchValues.get('Square')).toBe('square');
    });

    it('INVENTS no discriminator for a union TypeScript itself cannot narrow', () => {
        // Alpha | Beta share no single-literal property, so it is recorded rather than guessed at.
        expect(model.types.has('Mixed')).toBe(false);
        const recorded = model.unmapped.find((u: UnmappedType) => u.typeText.includes('Alpha'));
        expect(
            recorded,
            'the non-discriminable union was dropped instead of recorded',
        ).toBeDefined();
        expect(recorded!.reason).toContain('discriminator');
        expect(recorded!.location).toMatch(/ExampleApi\.ts:\d+:\d+$/);
        expect(harness.field(harness.type(model, 'SaveRequest'), 'mixed').type.kind).toBe(
            'unmapped',
        );
    });
});

describe('Integer and @WpInt are both accepted, and produce IDENTICAL model output', () => {
    /**
     * Two spellings of integer-ness ship deliberately — Dean's design-review decision of 2026-09-22,
     * recorded in issue #981. `Integer` is PREFERRED because it composes (`Integer[]`,
     * `Record<string, Integer>`) where a decorator on `counts?: number[]` is ambiguous about whether
     * it describes the array or its items. This test is the contract that they never diverge.
     */
    it('agrees on the scalar, the array ITEM and the map VALUE', () => {
        const byAlias = harness.type(model, 'LimitByAlias');
        const byDecorator = harness.type(model, 'LimitByDecorator');

        for (const name of ['limit', 'counts', 'quotas']) {
            expect(harness.field(byDecorator, name).type, `field '${name}' diverged`).toEqual(
                harness.field(byAlias, name).type,
            );
        }

        expect(harness.field(byAlias, 'limit').type).toEqual(
            TypeRef.primitiveOf('number', /*integer*/ true),
        );
        expect(harness.field(byAlias, 'counts').type).toEqual(
            TypeRef.array(TypeRef.primitiveOf('number', true)),
        );
        expect(harness.field(byAlias, 'quotas').type).toEqual(
            TypeRef.openMap(TypeRef.primitiveOf('number', true)),
        );
    });

    it('keeps optionality independent of the spelling', () => {
        expect(harness.field(harness.type(model, 'LimitByAlias'), 'limit').optional).toBe(true);
        expect(harness.field(harness.type(model, 'LimitByDecorator'), 'limit').optional).toBe(true);
    });

    it('records @WpMin / @WpMax on a numeric field', () => {
        const bounded = harness.field(harness.type(model, 'BoundedRequest'), 'pageSize');
        expect(bounded.min).toBe(1);
        expect(bounded.max).toBe(100);
        expect(bounded.type.integer).toBe(true);
    });
});

describe('what FAILS the build rather than being guessed at', () => {
    it('a path that cannot be constant-folded', () => {
        const failure = harness.failureOf('UnfoldablePathApi.ts');
        expect(failure, 'a runtime path was accepted').toBeDefined();
        expect(failure!.message).toContain('not a foldable constant');
        expect(failure!.location).toMatch(/UnfoldablePathApi\.ts:\d+:\d+$/);
        expect(failure!.cure.length).toBeGreaterThan(0);
        // The caller's renderer owns cure numbering; a message that writes its own has forked it.
        expect(failure!.cure).not.toMatch(/Fix Option/);
    });

    it('@WpMin on a non-numeric field', () => {
        const failure = harness.failureOf('BadBoundsApi.ts');
        expect(failure, '@WpMin on a string was accepted').toBeDefined();
        expect(failure!.message).toContain('non-numeric field');
        expect(failure!.location).toMatch(/BadBoundsApi\.ts:\d+:\d+$/);
    });

    it('a file with no @ApiPath class', () => {
        const failure = harness.failureOf('contract-stubs.ts');
        expect(failure?.message).toContain('no @ApiPath class');
    });
});
