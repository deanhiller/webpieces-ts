/**
 * A CLASS that happens to be named `JsonValueDto` (#1447). It is NOT the recursive JSON marker —
 * only a type alias of that name is — so its declared fields must survive into the document.
 */
export class JsonValueDto {
    /** A real, typed field the open JSON schema would silently drop. */
    label!: string;
}
