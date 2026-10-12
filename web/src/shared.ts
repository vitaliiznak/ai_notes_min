// What the client shares with the server (server/src/shared): note types, limits, text rules and error codes.
// Everything in the client imports them from here, so the form and the API measure a note the same way.
export * from "../../server/src/shared/rules";
export type * from "../../server/src/shared/notes";
export type * from "../../server/src/shared/error-codes";
