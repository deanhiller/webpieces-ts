export type BrowserToken = object | symbol | string;
export type BrowserType = new (...args: never[]) => object;

/** Concrete structural provider types keep the browser package independent of Angular. */
export class BrowserValueProvider {
    constructor(public readonly provide: BrowserToken, public readonly useValue: object | string | number | boolean | null) {}
}

export class BrowserClassProvider {
    constructor(public readonly provide: BrowserToken, public readonly useClass: BrowserType) {}
}

export class BrowserExistingProvider {
    constructor(public readonly provide: BrowserToken, public readonly useExisting: BrowserToken) {}
}

export class BrowserFactoryProvider {
    constructor(
        public readonly provide: BrowserToken,
        public readonly useFactory: (...args: never[]) => object,
        public readonly deps: BrowserToken[],
    ) {}
}

/** Structural identity of Angular's opaque initializer/provider bundle; no runtime dependency. */
export class BrowserEnvironmentProviders {
    declare readonly ɵbrand: 'EnvironmentProviders';
}

export type BrowserProvider = BrowserType | BrowserValueProvider | BrowserClassProvider | BrowserExistingProvider | BrowserFactoryProvider | BrowserEnvironmentProviders;
