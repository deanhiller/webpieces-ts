/**
 * The grammar of `ApiEndUserError.errorCode`: `<code>[:<detail>]`.
 *
 * - `<code>` names WHICH mistake it was (`user-not-found`, `terms-not-accepted`). It is what
 *   {@link EndUserErrorRegistry} matches on to rebuild the subclass on the receiving side, so it must
 *   not itself contain a `:`.
 * - `<detail>` is optional DATA the client acts on (the id that was not found, the terms version to
 *   accept), never prose: prose belongs in the message. Everything after the FIRST `:` is the detail,
 *   so a detail may itself contain colons.
 *
 * Kept as one tiny stateless class so a throw site, the registry and an app's own client code all
 * split the string the same way.
 */
export class EndUserErrorCode {
    static readonly SEPARATOR = ':';

    /** `code` alone, or `code:detail` when a detail is given. */
    // webpieces-disable no-function-outside-class -- stateless grammar helper shared by browser and server
    static format(code: string, detail?: string): string {
        return detail === undefined ? code : `${code}${EndUserErrorCode.SEPARATOR}${detail}`;
    }

    /** The `<code>` part: everything before the first `:`, or the whole string when there is none. */
    // webpieces-disable no-function-outside-class -- stateless grammar helper shared by browser and server
    static codeOf(errorCode: string): string {
        const at = errorCode.indexOf(EndUserErrorCode.SEPARATOR);
        return at < 0 ? errorCode : errorCode.slice(0, at);
    }

    /** The `<detail>` part: everything after the first `:`, or undefined when there is none. */
    // webpieces-disable no-function-outside-class -- stateless grammar helper shared by browser and server
    static detailOf(errorCode: string): string | undefined {
        const at = errorCode.indexOf(EndUserErrorCode.SEPARATOR);
        return at < 0 ? undefined : errorCode.slice(at + 1);
    }
}
