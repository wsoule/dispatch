// Every sequence a reader may treat as a line break: CRLF, LF, CR, VT, FF,
// NEL and the Unicode line and paragraph separators.
export const LINE_BREAK = /\r\n|[\n\v\f\r\u0085\u2028\u2029]/;
