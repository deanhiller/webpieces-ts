import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { specTempDirs } from '@webpieces/tooling-testkit';
import { ProjectInfo } from '../project-info';
import { CanonicalClientBindings } from './canonical-clients';

class Fixture {
    readonly root = specTempDirs.make('canonical-clients-');
    readonly infos = new Map<string, ProjectInfo>();
    readonly definitions = `
        class ClientConfig { constructor(target: string, custom?: number) {} }
        class TaskClientConfig { constructor(target: string) {} }
        class ClientHttpFactory { createRpcClient(api: object, config: ClientConfig, filters?: object[]) { return {}; } }
        class ClientHttpBrowserFactory { createRpcClient(api: object, config: ClientConfig, filters?: object[]) { return {}; } }
        class ClientCloudTasksFactory { createPubSubClient(api: object, config: TaskClientConfig) { return {}; } }
        class Binding { toDynamicValue(callback: Function): Binding { return this; } inSingletonScope() {} }
        class Options { bind(token: object | symbol): Binding { return new Binding(); } }
        class Context { get<T>(type: new () => T): T { return new type(); } }
        declare const options: Options, ctx: Context, TOKEN: symbol, OtherApi: symbol, filters: object[];
        class SaveApi {}
    `;

    write(
        owner: string,
        source: string,
        file: string = 'wiring.ts',
        tagged: boolean = true,
    ): string {
        const root = path.join(this.root, owner);
        fs.mkdirSync(path.join(root, 'src'), { recursive: true });
        fs.writeFileSync(
            path.join(root, 'tsconfig.json'),
            JSON.stringify({ compilerOptions: { target: 'es2022' }, include: ['src/*.ts'] }),
        );
        const target = path.join(root, 'src', file);
        fs.writeFileSync(target, this.definitions + source);
        this.infos.set(owner, new ProjectInfo(owner, owner, tagged ? ['webpieces-lib'] : []));
        return target;
    }

    problems(source: string): string[] {
        const file = this.write('app', source);
        const program = ts.createProgram([file], { target: ts.ScriptTarget.ES2022 });
        return new CanonicalClientBindings(program.getTypeChecker()).problems(
            program.getSourceFile(file)!,
        );
    }
}

describe('ALL-CODE canonical helper registration grammar', () => {
    it('reports supported bindings inside wiring.ts with token, API, target and filters', () => {
        const problems = new Fixture().problems(
            `options.bind(TOKEN).toDynamicValue(() => ctx.get(ClientHttpFactory).createRpcClient(SaveApi, new ClientConfig('save'), filters)).inSingletonScope();`,
        );
        expect(problems[0]).toContain(
            "binder.createRpcClientAndBind(SaveApi, 'save', new ClientBindOptions(TOKEN, filters));",
        );
    });

    it('follows method, callback, configuration and bind aliases and computed chained calls', () => {
        const problems = new Fixture().problems(`
            const factory = new ClientHttpFactory();
            const create = factory.createRpcClient;
            const config = new ClientConfig('save');
            const callback = () => create(SaveApi, config);
            const bind = options.bind;
            bind(TOKEN)['toDynamicValue'](callback)['inSingletonScope']();
        `);
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain("'save'");
    });

    it('audits the supported pubsub and browser helper equivalents', () => {
        const problems = new Fixture().problems(`
            options.bind(TOKEN).toDynamicValue(() => new ClientCloudTasksFactory().createPubSubClient(SaveApi, new TaskClientConfig('tasks'))).inSingletonScope();
            const providers = [{ provide: OtherApi, useFactory: (factory: ClientHttpBrowserFactory) => factory.createRpcClient(SaveApi, new ClientConfig('browser')), deps: [ClientHttpBrowserFactory] }];
        `);
        expect(problems).toHaveLength(2);
        expect(problems[0]).toContain(
            "binder.createPubSubClientAndBind(SaveApi, 'tasks', new PubSubBindOptions(TOKEN));",
        );
        expect(problems[1]).toContain(
            "binder.createRpcClientAndBind(SaveApi, 'browser', new ClientBindOptions(OtherApi));",
        );
    });

    it('leaves low-level use, unrelated factories and unsupported semantics alone', () => {
        expect(
            new Fixture().problems(`
            const factory = new ClientHttpFactory();
            factory.createRpcClient(SaveApi, new ClientConfig('low-level'));
            options.bind(TOKEN).toDynamicValue(() => factory.createRpcClient(SaveApi, new ClientConfig('transient')));
            options.bind(TOKEN).toDynamicValue(() => factory.createRpcClient(SaveApi, new ClientConfig('custom', 100))).inSingletonScope();
            options.bind(TOKEN).toDynamicValue(() => { console.log('side effect'); return factory.createRpcClient(SaveApi, new ClientConfig('custom')); }).inSingletonScope();
            class OtherFactory { createRpcClient(api: object, config: object) { return {}; } }
            options.bind(TOKEN).toDynamicValue(() => new OtherFactory().createRpcClient(SaveApi, new ClientConfig('other'))).inSingletonScope();
            const providers = [{provide: TOKEN, useFactory: (f: ClientHttpBrowserFactory) => f.createRpcClient(SaveApi, new ClientConfig('browser'), filters)}];
        `),
        ).toEqual([]);
    });

    it('omits the options argument when the token IS the api and no filters are passed', () => {
        const problems = new Fixture().problems(
            `options.bind(SaveApi).toDynamicValue(() => ctx.get(ClientHttpFactory).createRpcClient(SaveApi, new ClientConfig('save'))).inSingletonScope();`,
        );
        expect(problems[0]).toContain("binder.createRpcClientAndBind(SaveApi, 'save');");
    });

    it('passes canonical binder equivalents', () => {
        expect(
            new Fixture().problems(`
            class Binder { createRpcClientAndBind(api: object, target: string, options?: object) {} createPubSubClientAndBind(api: object, target: string, options?: object) {} }
            declare const binder: Binder;
            binder.createRpcClientAndBind(SaveApi, 'save');
            binder.createPubSubClientAndBind(SaveApi, 'tasks');
        `),
        ).toEqual([]);
    });
});
