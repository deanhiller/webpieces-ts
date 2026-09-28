import { WpInt, WpMax, WpMin } from '@webpieces/core-util';
import { RequestLanguageDto } from '@fixture/source-dtos';

/**
 * The BASES of the inheritance fixture, in their own file — the cross-FILE case (#1055). The
 * grandparent itself extends a class from another package read as source.
 */

/** Addresses one lesson's script. */
export class LessonScriptRequest extends RequestLanguageDto {
    /** The first language, as a name. */
    firstLanguage!: string;

    /** Training lesson 1-2 or numbered lesson 1-100. */
    @WpInt()
    @WpMin(1)
    @WpMax(100)
    lessonNumber!: number;

    /** The base's voice: optional here, redeclared REQUIRED by LessonRenderRequest. */
    voice?: string;
}
