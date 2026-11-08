import { ROUTING_METADATA_KEYS } from './decorators';
import {
    Container,
    ContainerModule,
    type ContainerModuleLoadOptions,
    type Newable,
    type ServiceIdentifier,
    type BindToFluentSyntax,
} from 'inversify';
import { RequestContext, provideFrameworkSingletonDefaultForApi } from '@webpieces/core-context';
import { type ApiPrototype } from '@webpieces/http-client-core';
import type { ClassType } from './ClassType';
import { ContainerBinder, type ClientBindOptions, type PubSubBindOptions } from './Binder';
import type { BindModule } from './BindModule';

/** The cancellable native deadline edge; feature tests replace only this clock. */
export class LazyFeatureDeadline {
    constructor(public readonly cancel: () => void) {}
}

/** Schedules a bounded first-use initialization; never a per-request authorization cache. */
export abstract class LazyFeatureTimer {
    abstract schedule(timeoutMillis: number, expire: () => void): Promise<LazyFeatureDeadline>;
}

@provideFrameworkSingletonDefaultForApi(LazyFeatureTimer)
class NodeLazyFeatureTimer extends LazyFeatureTimer {
    override async schedule(
        timeoutMillis: number,
        expire: () => void,
    ): Promise<LazyFeatureDeadline> {
        const timer = setTimeout(expire, timeoutMillis);
        return new LazyFeatureDeadline(() => clearTimeout(timer));
    }
}

/** Imported only on first permitted use. Explicitly list private concrete singletons. */
export class LazyImplementation<T extends object> {
    constructor(
        public readonly controller: Newable<T>,
        public readonly bindings: readonly BindModule[],
        public readonly singletons: readonly Newable<object>[],
        public readonly shared: readonly ServiceIdentifier[],
    ) {}
}

/**
 * Eager identity/security metadata, deferred implementation. The loader imports one feature and
 * returns declarative bindings; it must not open resources or perform request work. A failure is
 * retained per router until restart. The required deadline bounds waiting, not JavaScript CPU.
 */
export class LazyController<T extends object> {
    constructor(
        public readonly name: string,
        public readonly filepath: string,
        public readonly timeoutMillis: number,
        public readonly load: () => Promise<LazyImplementation<T>>,
    ) {
        if (!name.trim() || !filepath.trim())
            throw new Error('LazyController requires a stable name and filter filepath.');
        if (!Number.isFinite(timeoutMillis) || timeoutMillis <= 0 || timeoutMillis > 2_147_483_647)
            throw new Error(
                'LazyController timeoutMillis must be positive, finite and at most 2147483647.',
            );
    }
}

/** Isolated scope: cannot replace application bindings; explicitly inherited external overrides win. */
class LazyFeatureBinder extends ContainerBinder {
    constructor(
        options: ContainerModuleLoadOptions,
        private readonly scope: Container,
        private readonly parent: Container,
    ) {
        super(options);
    }

    override bind<T>(token: ServiceIdentifier<T>): BindToFluentSyntax<T> {
        if (this.scope.isCurrentBound(token) || this.parent.isCurrentBound(token))
            throw new Error(`Lazy feature cannot shadow or duplicate binding ${String(token)}.`);
        return super.bind(token);
    }

    override createRpcClientAndBind<T extends object>(
        api: ApiPrototype<T>,
        deployment: string,
        options?: ClientBindOptions<NoInfer<T>>,
    ): void {
        if (!this.inherit(options?.token ?? api))
            super.createRpcClientAndBind(api, deployment, options);
    }

    override createPubSubClientAndBind<T extends object>(
        api: ApiPrototype<T>,
        deployment: string,
        options?: PubSubBindOptions<NoInfer<T>>,
    ): void {
        if (!this.inherit(options?.token ?? api))
            super.createPubSubClientAndBind(api, deployment, options);
    }

    override bindExternal<T extends object>(
        api: ApiPrototype<T>,
        implementation: Newable<NoInfer<T>>,
    ): void {
        if (!this.inherit(api)) super.bindExternal(api, implementation);
    }
    private inherit<T>(token: ServiceIdentifier<T>): boolean {
        if (!this.parent.isCurrentBound(token)) return false;
        if (!this.scope.isCurrentBound(token))
            this.scope.bind(token).toDynamicValue(() => this.parent.get(token));
        return true;
    }
}

/** One retained initialization promise per descriptor per router; callers keep their own context. */
export class LazyControllerState<T extends object> {
    private initialized?: Promise<T>;

    constructor(
        private readonly parent: Container,
        private readonly api: ClassType<T>,
        private readonly definition: LazyController<T>,
        private readonly timer: LazyFeatureTimer,
        private readonly methods: readonly string[],
    ) {}

    matchesApi(api: ClassType<object>): boolean {
        return this.api === api;
    }

    resolve(): Promise<T> {
        this.initialized ??= RequestContext.runDetachedScope(() => this.initialize());
        return this.initialized;
    }

    private async initialize(): Promise<T> {
        // No parent-container autobinding: private classes and shared dependencies are explicit.
        // Inversify parent isBound/get can autobind into the parent, even when this child disables it.
        const scope = new Container();
        let abandoned = false;
        let rejectDeadline!: (error: Error) => void;
        const expired = new Promise<never>((_resolve, reject) => {
            rejectDeadline = reject;
        });
        const deadline = await this.timer.schedule(this.definition.timeoutMillis, () => {
            abandoned = true;
            rejectDeadline(
                new Error(
                    `Lazy feature ${this.definition.name} initialization exceeded ${this.definition.timeoutMillis}ms.`,
                ),
            );
        });
        // webpieces-disable no-unmanaged-exceptions -- terminal initialization boundary: release deadline on success, import/binding failure or timeout; rejection is retained and reported by normal dispatch
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return await Promise.race([expired, this.build(scope, () => abandoned)]);
        } finally {
            deadline.cancel();
        }
    }

    private async build(scope: Container, abandoned: () => boolean): Promise<T> {
        const implementation = await this.definition.load();
        if (abandoned())
            throw new Error(`Lazy feature ${this.definition.name} initialization was abandoned.`);
        const controller = implementation.controller;
        if (
            controller.name !== this.definition.name ||
            !this.api.prototype.isPrototypeOf(controller.prototype)
        )
            throw new Error(
                `Lazy controller ${this.definition.name} must preserve its declared name and extend ${this.api.name}.`,
            );
        const source: string | undefined = Reflect.getMetadata(
            ROUTING_METADATA_KEYS.SOURCE_FILEPATH,
            controller,
        );
        if (source !== undefined && source !== this.definition.filepath)
            throw new Error(
                `Lazy controller ${controller.name} filepath must match its @SourceFile metadata.`,
            );
        for (const method of this.methods) {
            if (
                typeof Reflect.get(controller.prototype, method) !== 'function' ||
                Reflect.get(controller.prototype, method) ===
                    Reflect.get(this.api.prototype, method)
            )
                throw new Error(
                    `Lazy controller ${this.definition.name} must implement ${this.api.name}.${method}.`,
                );
        }
        for (const token of implementation.shared) {
            if (
                !this.parent.isCurrentBound(token) &&
                !(typeof token !== 'function' && this.parent.isBound(token))
            )
                throw new Error(
                    `Lazy feature requires an explicitly bound shared dependency ${String(token)}.`,
                );
            if (scope.isCurrentBound(token))
                throw new Error(`Duplicate shared feature dependency ${String(token)}.`);
            scope.bind(token).toDynamicValue(() => this.parent.get(token));
        }
        // Candidate bindings never mutate the shared container, including when a module fails halfway.
        for (const module of implementation.bindings) {
            await scope.load(
                new ContainerModule((options: ContainerModuleLoadOptions) =>
                    module.configure(new LazyFeatureBinder(options, scope, this.parent)),
                ),
            );
            if (abandoned())
                throw new Error(
                    `Lazy feature ${this.definition.name} initialization was abandoned.`,
                );
        }
        for (const singleton of [...implementation.singletons, controller]) {
            if (scope.isCurrentBound(singleton) || this.parent.isCurrentBound(singleton))
                throw new Error(
                    `Lazy feature cannot shadow or duplicate singleton ${singleton.name}.`,
                );
            scope.bind(singleton).toSelf().inSingletonScope();
        }
        return scope.get(controller);
    }
}
