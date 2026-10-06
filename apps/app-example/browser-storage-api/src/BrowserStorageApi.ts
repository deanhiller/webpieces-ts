/**
 * A browser VENDOR seam: persistent key/value storage. It is an external contract, not an HTTP API —
 * no `@ApiPath`, and no service implements it. The browser app supplies the vendor implementation and
 * registers it with `binder.bindExternal(BrowserStorageApi, new UseExisting(...))` in its
 * canonical wiring.ts, which also records the `uses / external` edge in the approved runtime graph.
 */
export abstract class BrowserStorageApi {
    /** The stored value, or undefined when nothing is stored under `key`. */
    abstract read(key: string): string | undefined;

    abstract write(key: string, value: string): void;
}
