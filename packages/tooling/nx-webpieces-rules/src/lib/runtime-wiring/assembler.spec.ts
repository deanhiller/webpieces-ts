import { describe, expect, it } from 'vitest';
import { RuntimeWiringAssembler } from './assembler';
import {
    ContractIdentity,
    ImplementsFacts,
    UsesFacts,
    RuntimeDeclaration,
    WiringExport,
    WiringRelationship,
    WiringSelection,
} from './declaration';

const auth = new ContractIdentity('auth-api', 'AuthStoreApi');
const library = new RuntimeDeclaration('auth', 'node', {
    AuthClients: new WiringExport(
        'binding',
        [
            new WiringRelationship(
                auth,
                new UsesFacts('rpc', { kind: 'parameter', parameter: 'store' }),
            ),
        ],
        [],
    ),
    Unselected: new WiringExport(
        'routing',
        [
            new WiringRelationship(
                new ContractIdentity('admin-api', 'AdminApi'),
                new ImplementsFacts('rpc'),
            ),
        ],
        [],
    ),
});

function application(project: string, target: string): RuntimeDeclaration {
    return new RuntimeDeclaration(
        project,
        'node',
        {
            Plan: new WiringExport(
                'app',
                [],
                [
                    new WiringSelection(
                        'auth',
                        'AuthClients',
                        { store: { kind: 'service', service: target } },
                        {},
                    ),
                ],
            ),
        },
        'Plan',
        project,
    );
}

describe('approved runtime composition', () => {
    it('selects exports and substitutes targets independently for each app', () => {
        const assembler = new RuntimeWiringAssembler(
            new Map([
                ['auth', library],
                ['lang', application('lang', 'lang-fsdb')],
                ['helper', application('helper', 'helper-fsdb')],
            ]),
        );
        expect(assembler.assemble('lang')).toMatchObject([
            { api: 'AuthStoreApi', target: { service: 'lang-fsdb' } },
        ]);
        expect(assembler.assemble('helper')).toMatchObject([
            { api: 'AuthStoreApi', target: { service: 'helper-fsdb' } },
        ]);
        expect(assembler.assemble('lang')).toHaveLength(1);
        expect(assembler.assemble('lang')[0].via).toContain('auth#AuthClients');
    });

    it('rejects missing target arguments instead of guessing from library imports', () => {
        const broken = new RuntimeDeclaration(
            'broken',
            'node',
            {
                Plan: new WiringExport(
                    'app',
                    [],
                    [new WiringSelection('auth', 'AuthClients', {}, {})],
                ),
            },
            'Plan',
        );
        expect(() =>
            new RuntimeWiringAssembler(
                new Map([
                    ['auth', library],
                    ['broken', broken],
                ]),
            ).assemble('broken'),
        ).toThrow('Unresolved target parameter store');
    });

    it('rejects missing exports and composition cycles', () => {
        const broken = new RuntimeDeclaration(
            'broken',
            'node',
            { Plan: new WiringExport('app', [], [new WiringSelection('broken', 'Plan', {}, {})]) },
            'Plan',
        );
        expect(() =>
            new RuntimeWiringAssembler(new Map([['broken', broken]])).assemble('broken'),
        ).toThrow('expected binding');
        expect(() => new RuntimeWiringAssembler(new Map()).assemble('missing')).toThrow(
            'Missing approved',
        );
    });

    it('requires an explicit conditional decision and preserves qualified contract identity', () => {
        const warmup = new WiringRelationship(
            new ContractIdentity('core-api', 'WarmupApi'),
            new ImplementsFacts('rpc', 'publicWarmup'),
        );
        const declaration = new RuntimeDeclaration(
            'app',
            'node',
            {
                Plan: new WiringExport('app', [], [], [new WiringSelection('app', 'Routes', {}, { publicWarmup: false })]),
                Routes: new WiringExport('routing', [warmup], []),
            },
            'Plan',
        );
        expect(new RuntimeWiringAssembler(new Map([['app', declaration]])).assemble('app')).toEqual(
            [],
        );
        declaration.exports.Plan.routeModules[0].policies.publicWarmup = true;
        expect(
            new RuntimeWiringAssembler(new Map([['app', declaration]])).assemble('app'),
        ).toMatchObject([{ owner: 'core-api', api: 'WarmupApi' }]);
        declaration.exports.Plan.routeModules[0].policies.publicWarmup = 'runtime';
        expect(
            new RuntimeWiringAssembler(new Map([['app', declaration]])).assemble('app'),
        ).toMatchObject([{ conditional: 'app#Routes:publicWarmup' }]);
        delete declaration.exports.Plan.routeModules[0].policies.publicWarmup;
        expect(() =>
            new RuntimeWiringAssembler(new Map([['app', declaration]])).assemble('app'),
        ).toThrow('Missing explicit policy');
    });
});
