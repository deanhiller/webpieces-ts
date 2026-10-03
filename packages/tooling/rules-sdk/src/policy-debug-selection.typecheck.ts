import { PolicyDebugSelection } from './rule-runtime';

/** Compiled with the SDK: debug selection cannot accept an absent rule. */
class PolicyDebugSelectionTypeCheck {
    static requireRule(): void {
        const acceptsUndefined: undefined extends ConstructorParameters<
            typeof PolicyDebugSelection
        >[0]
            ? true
            : false = false;
        void acceptsUndefined;
    }
}

PolicyDebugSelectionTypeCheck.requireRule();
