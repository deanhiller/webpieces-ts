/* eslint-disable */
/** The document-wide failure body, named by a manifest and read with the compiler. */
export interface ApiError {
    /** A stable, machine-readable code. */
    code: string;

    /** What went wrong, for a human. */
    message: string;
}
