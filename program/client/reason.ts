/** A one-line reason as span keeps it: runs of spaces folded to one and the ends trimmed. Null when it is empty, longer than
 *  `max`, has a character outside printable ASCII (0x20-0x7E), or reads as a link, an address or a domain. */
export function cleanText(text: string, max: number): string | null {
  const s = text.replace(/\s+/g, " ").trim();
  if (!s || s.length > max) return null;
  if (/[^\x20-\x7e]/.test(s)) return null;
  if (/:\/\/|www\.|@/i.test(s) || /\b[a-z0-9-]+\.[a-z]{2,}\b/i.test(s)) return null;
  return s;
}
