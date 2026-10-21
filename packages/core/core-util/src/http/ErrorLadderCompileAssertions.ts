import { ApiRegistry } from './ApiRegistry';
import { ClientRegistry } from './ClientRegistry';
import { CallScope } from './CallScope';
import { ErrorClassifier } from './ErrorClassifier';
import { ErrorTranslator } from './ErrorTranslator';
import { ApiMethodInfo } from './ApiMethodInfo';
import { CallContext } from './CallStrategy';
import { WRITE } from './HttpEndpointOptions';

/** A contract class to scope by. */
class SaveTargetApi {
    save(): Promise<void> {
        return Promise.resolve();
    }
}

/**
 * Compiled by tsc (spec files are not), never executed. Pins the ONE spelling of the error ladder:
 * it lives on `ApiRegistry` (both sides read it), every registration states its `CallScope`, and the
 * spellings it replaced do not compile. tsc fails the build with TS2578 if any of these ever starts
 * compiling again.
 */
class ErrorLadderCompileAssertions {
    scopeIsRequired(translator: ErrorTranslator, classifier: ErrorClassifier): void {
        // @ts-expect-error setErrorTranslator(t) became setErrorTranslator(t, CallScope.all()) — the scope is required
        ApiRegistry.setErrorTranslator(translator);
        // @ts-expect-error setDefaultErrorClassifier(c) became setErrorClassifier(c, CallScope.all())
        ApiRegistry.setDefaultErrorClassifier(classifier);
        // @ts-expect-error addErrorClassifier(new KeyedErrorClassifier('XApi', c)) became setErrorClassifier(c, CallScope.api(XApi))
        ApiRegistry.addErrorClassifier(classifier);
        // @ts-expect-error the scope is required — setErrorClassifier(c, CallScope.all())
        ApiRegistry.setErrorClassifier(classifier);
        // @ts-expect-error getErrorTranslator() became getErrorTranslator(api, methodName)
        ApiRegistry.getErrorTranslator();
    }

    scopeIsACallScope(translator: ErrorTranslator, classifier: ErrorClassifier): void {
        // @ts-expect-error the 'ALL' string became CallScope.all()
        ApiRegistry.setErrorTranslator(translator, 'ALL');
        // @ts-expect-error the 'ALL' string became CallScope.all()
        ApiRegistry.setErrorClassifier(classifier, 'ALL');
        // @ts-expect-error the (Api, 'method') tuple became CallScope.method(Api, 'method')
        ApiRegistry.setErrorTranslator(translator, SaveTargetApi, 'save');
        // @ts-expect-error a misspelled method does not compile — it would silently match nothing
        ApiRegistry.setErrorClassifier(classifier, CallScope.method(SaveTargetApi, 'svae'));
        ApiRegistry.setErrorClassifier(classifier, CallScope.method(SaveTargetApi, 'save'));
    }

    errorPolicyMovedToApiRegistry(translator: ErrorTranslator, classifier: ErrorClassifier): void {
        // @ts-expect-error ClientRegistry.setErrorTranslator became ApiRegistry.setErrorTranslator — both sides read it
        ClientRegistry.setErrorTranslator(translator, CallScope.all());
        // @ts-expect-error ClientRegistry.setErrorClassifier became ApiRegistry.setErrorClassifier — both sides read it
        ClientRegistry.setErrorClassifier(classifier, CallScope.all());
        // @ts-expect-error ClientRegistry.getErrorTranslator became ApiRegistry.getErrorTranslator
        ClientRegistry.getErrorTranslator(undefined, undefined);
        // @ts-expect-error ClientRegistry.classify became ApiRegistry.classify
        ClientRegistry.classify(new Error('x'), new ApiMethodInfo('client', 'SaveApi', 'save', SaveTargetApi));
    }

    callIdentityStatesItsContract(): void {
        // @ts-expect-error ApiMethodInfo's contract CLASS is required
        void new ApiMethodInfo('client', 'SaveApi', 'save');
        // @ts-expect-error CallContext's contract CLASS is required
        void new CallContext('SaveApi', 'save', WRITE);
        // @ts-expect-error ApiMethodInfo's contract is a CLASS, never undefined — pass the real contract class
        void new ApiMethodInfo('client', 'SaveApi', 'save', undefined);
        // @ts-expect-error CallContext's contract is a CLASS, never undefined — pass the real contract class
        void new CallContext('SaveApi', 'save', WRITE, undefined);
    }

    keyedByClassNeverByName(classifier: ErrorClassifier): void {
        // @ts-expect-error the ladder is keyed by the contract CLASS, never its name
        ApiRegistry.setErrorClassifier(classifier, 'SaveApi');
    }
}
