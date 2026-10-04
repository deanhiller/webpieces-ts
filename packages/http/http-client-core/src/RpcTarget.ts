import type { ApiPrototype } from './ApiPrototype';

declare const rpcTargetContract: unique symbol;

/** A contract capability at one deployment. URLs and credentials stay in the registry. */
class RpcTarget<T extends object> {
    // Invariance prevents a target for a narrower contract being widened to a different API.
    declare readonly [rpcTargetContract]: (value: T) => T;

    constructor(
        public readonly api: ApiPrototype<T>,
        public readonly serviceName: string,
    ) {}
}

// webpieces-disable no-function-outside-class -- public declaration helper, deliberately one expression at the wiring boundary
export function rpcTarget<T extends object>(
    api: ApiPrototype<T>,
    serviceName: string,
): RpcTarget<T> {
    return new RpcTarget(api, serviceName);
}

export type { RpcTarget };
