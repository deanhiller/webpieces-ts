import { ClientRegistry } from './ClientRegistry';
import { ErrorClassifier } from './ErrorClassifier';
import { ErrorTranslator } from './ErrorTranslator';

/**
 * Compiled by tsc (spec files are not), never executed. Pins the ONE spelling of the error ladder:
 * every registration states its `CallScope`, and the unscoped spellings it replaced do not compile.
 * tsc fails the build with TS2578 if any of these ever starts compiling again.
 */
class ErrorLadderCompileAssertions {
    scopeIsRequired(translator: ErrorTranslator, classifier: ErrorClassifier): void {
        // @ts-expect-error setErrorTranslator(t) became setErrorTranslator(t, 'ALL') — the scope is required
        ClientRegistry.setErrorTranslator(translator);
        // @ts-expect-error setDefaultErrorClassifier(c) became setErrorClassifier(c, 'ALL')
        ClientRegistry.setDefaultErrorClassifier(classifier);
        // @ts-expect-error addErrorClassifier(new KeyedErrorClassifier('XApi', c)) became setErrorClassifier(c, XApi)
        ClientRegistry.addErrorClassifier(classifier);
        // @ts-expect-error the scope is required — setErrorClassifier(c, 'ALL')
        ClientRegistry.setErrorClassifier(classifier);
        // @ts-expect-error getErrorTranslator() became getErrorTranslator(api, methodName)
        ClientRegistry.getErrorTranslator();
    }

    allHasNoMethod(translator: ErrorTranslator, classifier: ErrorClassifier): void {
        // @ts-expect-error ALL cannot select a method
        ClientRegistry.setErrorTranslator(translator, 'ALL', 'work');
        // @ts-expect-error ALL cannot select a method
        ClientRegistry.setErrorClassifier(classifier, 'ALL', 'work');
    }

    keyedByClassNeverByName(classifier: ErrorClassifier): void {
        // @ts-expect-error the ladder is keyed by the contract CLASS, never its name
        ClientRegistry.setErrorClassifier(classifier, 'SaveApi');
    }
}
