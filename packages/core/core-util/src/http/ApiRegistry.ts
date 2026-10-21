import { ErrorTranslator } from './ErrorTranslator';
import { CallOutcome, ErrorClassifier } from './ErrorClassifier';
import { CallScope, CallScopeLadder } from './CallScope';
import { WEBPIECES_DEFAULT_ERROR_CLASSIFIER } from './WebpiecesDefaultErrorClassifier';
import { WEBPIECES_DEFAULT_ERROR_TRANSLATOR } from './WebpiecesDefaultErrorTranslator';
import { ApiMethodInfo } from './ApiMethodInfo';

/** One {@link CallScope} rung of the error-translator ladder. Data only, so a class. */
class TranslatorSlot {
    translator?: ErrorTranslator;
}

/** One {@link CallScope} rung of the error-classifier ladder. Data only, so a class. */
class ClassifierSlot {
    classifier?: ErrorClassifier;
}

/**
 * ApiRegistry - the startup settings BOTH sides of an API call read: the {@link ErrorTranslator}
 * (the server's `toWire`, every client's `fromWire`, IPC and MCP) and the {@link ErrorClassifier}
 * (the server's `LogApiFilter`, `LogApiCall`, `RetryStrategy`, the MCP renderer, Cloud Tasks). What
 * only an OUTBOUND call reads — URLs, timeouts, strategies — lives on `ClientRegistry` instead.
 *
 * Every setting is scoped by a {@link CallScope} and resolved method -> API -> ALL -> the webpieces
 * default. Process-global, populated once at startup on the SERVER and in the BROWSER, with no DI
 * wiring (like `HeaderRegistry` / `LogManager`).
 *
 * ```ts
 * ApiRegistry.setErrorTranslator(new AppErrorTranslator(), CallScope.all());
 * ApiRegistry.setErrorTranslator(new VendorErrorTranslator(), CallScope.api(VendorApi));
 * ApiRegistry.setErrorClassifier(new CompanyClassifier(), CallScope.all());
 * ```
 */
export class ApiRegistry {
    /**
     * The {@link ErrorTranslator} per {@link CallScope} — method -> API -> ALL, and below every rung
     * {@link WEBPIECES_DEFAULT_ERROR_TRANSLATOR}, so {@link ApiRegistry.getErrorTranslator} is never
     * undefined.
     *
     * ONE translator per scope, not a list, on purpose: an app that has several layers of error
     * policy for one scope composes them INSIDE its own `toWire`, where the precedence is written
     * down. The ladder exists because vendors put their errors on the wire in their OWN formats — a
     * per-API translator reads one vendor's 4xx body (`fromWire`), or writes the error body an
     * inbound vendor expects back (`toWire`), while every other contract keeps the app's ALL one.
     */
    private static readonly errorTranslators = new CallScopeLadder<TranslatorSlot>(
        () => new TranslatorSlot(),
    );

    /**
     * The {@link ErrorClassifier} per {@link CallScope} — method -> API -> ALL, and below every rung
     * {@link WEBPIECES_DEFAULT_ERROR_CLASSIFIER}. A classifier that DEFERS (`undefined`) falls through
     * to the next rung. The ALL classifier reads {@link ApiMethodInfo.side}, so one classifier covers
     * the server router AND every internal client; an SDK-wrapping api-client registers its own at
     * its abstract `XxxApi` class. See {@link ApiRegistry.classify}.
     */
    private static readonly errorClassifiers = new CallScopeLadder<ClassifierSlot>(
        () => new ClassifierSlot(),
    );

    /**
     * Install an {@link ErrorTranslator} for one {@link CallScope}: `CallScope.all()` (the app's
     * translator, server side AND every client side), one contract (`CallScope.api(VendorApi)`), or
     * one method of one contract (`CallScope.method(VendorApi, 'sync')`). The scope is REQUIRED —
     * there is no unscoped spelling. Call at startup, on the server AND in the browser.
     *
     * `set`, not `add`: see the field doc above for why a per-scope LIST is not wanted. A translator
     * declines an error by DELEGATING to {@link WebpiecesDefaultErrorTranslator} — not to the next
     * rung.
     */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/LogManager); populated once at startup, never DI-injected
    static setErrorTranslator(translator: ErrorTranslator, scope: CallScope): void {
        ApiRegistry.errorTranslators.at(scope).translator = translator;
    }

    /**
     * THE {@link ErrorTranslator} for one call — method -> API -> ALL ->
     * {@link WEBPIECES_DEFAULT_ERROR_TRANSLATOR}, never `undefined`, so a caller never branches.
     *
     * Both arguments are required so every call site states what it knows: the client and the server
     * pass the route's contract class and method; a failure with no route (an unmatched request, a
     * failure before routing) passes `undefined, undefined` and reaches the ALL rung alone.
     */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/LogManager); populated once at startup, never DI-injected
    static getErrorTranslator(api: Function | undefined, methodName: string | undefined): ErrorTranslator {
        const registered = ApiRegistry.errorTranslators
            .rungs(api, methodName)
            .find((slot: TranslatorSlot) => slot.translator !== undefined)?.translator;
        return registered ?? WEBPIECES_DEFAULT_ERROR_TRANSLATOR;
    }

    /**
     * Install an {@link ErrorClassifier} for one {@link CallScope}: `CallScope.all()` (the
     * app/company classifier — it reads {@link ApiMethodInfo.side}, so it covers the server router
     * and every internal client), one contract (an SDK-wrapping api-client keys by its abstract
     * `XxxApi`), or one method of one contract. The scope is REQUIRED. Call at startup, on the server
     * AND in the browser. See {@link ErrorClassifier}.
     */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/LogManager); populated once at startup, never DI-injected
    static setErrorClassifier(classifier: ErrorClassifier, scope: CallScope): void {
        ApiRegistry.errorClassifiers.at(scope).classifier = classifier;
    }

    /**
     * The {@link CallOutcome} of a thrown API-call error. Resolved on the {@link CallScope} ladder of
     * `methodInfo.contract` / `methodInfo.methodName`, most specific first, and ALWAYS definitive:
     *   1. the method classifier — unless it defers;
     *   2. else the API classifier — unless it defers;
     *   3. else the ALL classifier — unless it defers;
     *   4. else the webpieces built-in ({@link WEBPIECES_DEFAULT_ERROR_CLASSIFIER}), which never defers.
     *
     * The ONE verdict read by `RetryStrategy` (retry only TRANSIENT), `ClientRegistry`'s per-attempt
     * log line, `LogApiCall` (EXPECTED → OTHER, else FAIL) and the MCP renderer's retry advice.
     */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/LogManager); populated once at startup, never DI-injected
    static classify(error: Error, methodInfo: ApiMethodInfo): CallOutcome {
        const rungs = ApiRegistry.errorClassifiers.rungs(methodInfo.contract, methodInfo.methodName);
        for (const slot of rungs) {
            const verdict = slot.classifier?.classify(error, methodInfo);
            if (verdict !== undefined) {
                return verdict;
            }
        }
        return WEBPIECES_DEFAULT_ERROR_CLASSIFIER.classify(error, methodInfo);
    }

    /**
     * Put the process-globals back to the state a fresh process starts in. For TESTS, so one spec
     * cannot leak its registrations into the next.
     *
     * It empties every translator and classifier rung, which RESTORES the webpieces defaults:
     * `getErrorTranslator(...)` and `classify(...)` fall through to them below every rung, so
     * "cleared" is not a state they have.
     */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/LogManager); populated once at startup, never DI-injected
    static resetForTests(): void {
        ApiRegistry.errorTranslators.clear();
        ApiRegistry.errorClassifiers.clear();
    }
}
