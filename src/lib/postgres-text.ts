// Postgres `text` rejects NUL (0x00) and most other C0/C1 control characters
// with 22021 "invalid byte sequence for encoding UTF8". PDF text layers
// (notably Arabic PDFs) can embed NUL bytes from font encoding, so strip
// the forbidden characters before any extracted text reaches the database.
// Tab, LF and CR are legal in Postgres text and are kept. The character is
// deleted, not replaced with a space, so words the NUL sat inside keep
// their shape.
export function stripPostgresForbiddenChars(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
}
