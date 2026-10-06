/**
 * Small readers for JSON text that JSON.parse cannot answer, kept here so the
 * manifest and the proxy share one tested copy. Both are only called on text
 * JSON.parse has already accepted, so they walk the structure without re-checking it.
 */

/**
 * Keys that appear more than once in the same JSON object, in the order met.
 * JSON.parse keeps the last of two identical keys and says nothing, so a manifest
 * with `"terminate_instance": ["delete"]` and, further down,
 * `"terminate_instance": []` would quietly declare nothing. Only called on text
 * JSON.parse has already accepted, so it walks the structure without re-checking
 * it. Keys are compared after decoding, so "a" and "\u0061" are the same key.
 */
export function duplicateKeys(text: string): string[] {
  const dups: string[] = [];
  const stack: Array<Set<string> | null> = []; // a Set for an object, null for an array
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') stack.push(new Set());
    else if (ch === '[') stack.push(null);
    else if (ch === '}' || ch === ']') stack.pop();
    else if (ch === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const token = JSON.parse(text.slice(i, j + 1)) as string;
      let k = j + 1;
      while (k < text.length && /\s/.test(text[k])) k++;
      const seen = stack[stack.length - 1];
      if (seen && text[k] === ':') {
        if (seen.has(token)) dups.push(token);
        seen.add(token);
      }
      i = j;
    }
  }
  return dups;
}

/**
 * The raw text of a message's top-level `id`, exactly as it was written, or
 * undefined if there is none. `JSON.parse` turns 1234567890123456789 into
 * 1234567890123456800, so an id read that way and written back is a different id:
 * the client could not match the reply it gets to the request it sent. Reading the
 * text keeps a big number, and a string, byte for byte.
 */
export function rawId(text: string): string | undefined {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    else if (ch === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      let k = j + 1;
      while (k < text.length && /\s/.test(text[k])) k++;
      if (depth === 1 && text[k] === ':' && JSON.parse(text.slice(i, j + 1)) === 'id') {
        k++;
        while (k < text.length && /\s/.test(text[k])) k++;
        let end = k;
        if (text[k] === '"') {
          end = k + 1;
          while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
          end++;
        } else if (text[k] === '{' || text[k] === '[') {
          return undefined;                       // not a valid id
        } else {
          while (end < text.length && !/[,}\s]/.test(text[end])) end++;
        }
        return text.slice(k, end);
      }
      i = j;
    }
  }
  return undefined;
}
