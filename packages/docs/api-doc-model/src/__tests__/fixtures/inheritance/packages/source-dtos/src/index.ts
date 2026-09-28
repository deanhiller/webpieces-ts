/**
 * A workspace package read as SOURCE through tsconfig `paths` — the monorepo half of the
 * cross-package case (#1055).
 */

/** Anything addressed in one language. */
export class RequestLanguageDto {
    /** The language being taught. */
    language!: string;
}

/** Anything that names a learner. */
export interface LearnerNamedDto {
    /** The learner's display name. */
    learnerName: string;
}
