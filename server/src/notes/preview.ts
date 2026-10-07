function skipSpace(json: string, index: number): number {
  let i = index;
  while (i < json.length && (json[i] === " " || json[i] === "\n" || json[i] === "\r" || json[i] === "\t")) i++;
  return i;
}

/** Index just after the colon of a `"key"` property. A key mentioned inside a value does not count. */
function afterKey(json: string, key: string): number {
  const marker = `"${key}"`;
  let from = 0;
  while (from < json.length) {
    const at = json.indexOf(marker, from);
    if (at < 0) return -1;
    const colon = skipSpace(json, at + marker.length);
    if (json[colon] === ":") return colon + 1;
    from = at + marker.length;
  }
  return -1;
}

/** The JSON string value of `key`, including the part the model is still writing. `closed` is false until the ending quote arrives. */
export function partialJsonString(json: string, key: string): { value: string; closed: boolean } | null {
  const valueAt = afterKey(json, key);
  if (valueAt < 0) return null;
  const quote = skipSpace(json, valueAt);
  if (json[quote] !== '"') return null;
  const parsed = readJsonString(json, quote);
  if (!parsed.closed && parsed.value.length === 0) return null;
  return { value: parsed.value, closed: parsed.closed };
}

/** Complete JSON strings from a partial array, plus the string the model is still writing. */
export function partialStringArray(json: string, key: string): { done: string[]; tail: string } | null {
  const valueAt = afterKey(json, key);
  if (valueAt < 0) return null;
  const bracket = skipSpace(json, valueAt);
  if (json[bracket] !== "[") return null;

  const done: string[] = [];
  let i = bracket + 1;
  while (i < json.length) {
    const char = json[i];
    if (char === " " || char === "\n" || char === "\r" || char === "\t" || char === ",") {
      i++;
      continue;
    }
    if (char !== '"') return { done, tail: "" };
    const parsed = readJsonString(json, i);
    if (!parsed.closed) return { done, tail: parsed.value };
    done.push(parsed.value);
    i = parsed.end;
  }
  return { done, tail: "" };
}

function readJsonString(json: string, start: number): { value: string; end: number; closed: boolean } {
  let value = "";
  let i = start + 1;
  while (i < json.length) {
    const char = json[i]!;
    if (char === "\\") {
      const next = json[i + 1];
      if (next === undefined) return { value, end: json.length, closed: false };
      if (next === "u") {
        const hex = json.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return { value, end: json.length, closed: false };
        value += String.fromCharCode(Number.parseInt(hex, 16));
        i += 6;
        continue;
      }
      const escaped: Record<string, string> = {
        '"': '"',
        "\\": "\\",
        "/": "/",
        b: "\b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
      };
      value += escaped[next] ?? next;
      i += 2;
      continue;
    }
    if (char === '"') return { value, end: i + 1, closed: true };
    value += char;
    i++;
  }
  return { value, end: json.length, closed: false };
}
