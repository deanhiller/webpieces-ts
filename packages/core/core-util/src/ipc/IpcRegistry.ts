import { IpcErrorTranslator } from './IpcErrorTranslator';
import { IpcReply, IpcSuccess } from './IpcProtocol';
import { WEBPIECES_DEFAULT_IPC_ERROR_TRANSLATOR } from './WebpiecesDefaultIpcErrorTranslator';

/**
 * IpcRegistry - the process-global home of the ONE {@link IpcErrorTranslator}, mirroring
 * `ClientRegistry` for HTTP and `McpRegistry` for MCP.
 *
 * ONE REGISTRY PER PROTOCOL, and that is the design: the three speak different wire shapes
 * (`HttpResponseDto`, `CallToolResult`, `ApiErrorPayload`), so one combined registry would either
 * force an app to answer three unrelated questions in one object or hide two of them behind
 * optionality. Three registries, three unconditional call sites.
 *
 * Configured like `HeaderRegistry` / `ClientRegistry` / LogManager — populated once at startup, then
 * globally accessible with NO DI wiring.
 *
 * ```ts
 * // startup, ONCE per process, in BOTH processes that share the connection
 * IpcRegistry.setErrorTranslator(new MyIpcErrorTranslator());
 * ```
 */
export class IpcRegistry {
    /**
     * THE translator. NEVER undefined — it starts life holding
     * {@link WEBPIECES_DEFAULT_IPC_ERROR_TRANSLATOR}, and {@link IpcRegistry.setErrorTranslator}
     * REPLACES it. So no IPC call site asks "did anyone register one".
     */
    private static errorTranslator: IpcErrorTranslator = WEBPIECES_DEFAULT_IPC_ERROR_TRANSLATOR;

    /**
     * Install the app's {@link IpcErrorTranslator}. `set`, not `add`: an app with several layers of
     * error policy composes them INSIDE its own `toWire`, where the precedence is written down.
     */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/ClientRegistry); populated once at startup, never DI-injected
    static setErrorTranslator(translator: IpcErrorTranslator): void {
        IpcRegistry.errorTranslator = translator;
    }

    /** THE {@link IpcErrorTranslator} for this process — never `undefined`, so no caller branches. */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/ClientRegistry); populated once at startup, never DI-injected
    static getErrorTranslator(): IpcErrorTranslator {
        return IpcRegistry.errorTranslator;
    }

    /** Put the process-global back to the webpieces default. For TESTS, so specs cannot leak. */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/ClientRegistry); populated once at startup, never DI-injected
    static resetForTests(): void {
        IpcRegistry.errorTranslator = WEBPIECES_DEFAULT_IPC_ERROR_TRANSLATOR;
    }
}

/**
 * The CLIENT half's one call site, and the guarantee behind it — the IPC twin of
 * `ClientErrorTranslator.throwIfFailure`.
 *
 * The `asserts` return type is what lets `IpcClientFactory` read the success body straight afterwards
 * with no `if (reply.type === 'failure')` branch left over: after this call the compiler knows the
 * reply is an {@link IpcSuccess}, because the only way past it is that it is one.
 */
export class IpcClientErrorTranslator {
    /**
     * Run `fromWire` over a reply, and make it impossible for an `IpcFailure` to be read as data.
     *
     * The second call is BUG CONTAINMENT, not a fallback branch: an app translator that returns
     * normally for a failure reply has a bug whose symptom would otherwise be `undefined` arriving
     * where the contract promised a DTO. For a genuine success the default returns immediately, so
     * the normal path costs one comparison.
     */
    // webpieces-disable no-function-outside-class -- stateless boundary shared by every IPC client proxy
    static throwIfFailure(reply: IpcReply): asserts reply is IpcSuccess {
        IpcRegistry.getErrorTranslator().fromWire(reply);
        WEBPIECES_DEFAULT_IPC_ERROR_TRANSLATOR.fromWire(reply);
    }
}
