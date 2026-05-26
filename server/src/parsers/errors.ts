/* Shared parser error base. */

/** Base for "we recognised the media type but cannot use this particular
    file" parser failures — DRM-protected MOBI, DRM/image-only/no-spine EPUB,
    etc. The upload route layer maps any subclass to HTTP 415 with one
    `instanceof` check, distinct from a 500 (an unexpected parse crash) and
    from `UnsupportedFormatError` (we don't recognise the format at all). */
export class UnusableMediaError extends Error {}
