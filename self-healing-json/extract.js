/**
 * Pull known fields out of an LLM response without caring how the model
 * wrapped them: find the JSON, then walk the whole tree looking for each field
 * by the names it answers to. See README.md for why.
 */

/**
 * Find the first parseable JSON value in a model response.
 *
 * Handles a bare object, a fenced ```json block, and prose with an object
 * somewhere inside it. Returns null when there is nothing parseable.
 */
function findJson(text) {
  if (text === null || text === undefined) return null;
  if (typeof text === 'object') return text; // already parsed upstream

  const raw = String(text).trim();

  const direct = tryParse(raw);
  if (direct !== undefined) return direct;

  // ```json ... ``` or plain ``` ... ```
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const parsed = tryParse(fenced[1].trim());
    if (parsed !== undefined) return parsed;
  }

  // An object or array embedded in prose. Scan from each opening bracket and
  // take the first balanced span that parses, so trailing chatter is ignored.
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== '{' && ch !== '[') continue;
    const span = balancedSpan(raw, i);
    if (span === null) continue;
    const parsed = tryParse(span);
    if (parsed !== undefined) return parsed;
  }

  return null;
}

function tryParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** Return the substring from `start` to its matching bracket, ignoring brackets inside strings. */
function balancedSpan(s, start) {
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < s.length; i++) {
    const ch = s[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Breadth-first search for the first value stored under any of `names`.
 *
 * Breadth-first rather than depth-first so a top-level `id` beats one buried in
 * a nested object, which is almost always what the caller means.
 *
 * Comparison is loose on purpose: order_id, orderId, "Order ID" and ORDER_ID
 * all collapse to orderid, because which one the model picks is a coin flip.
 *
 * `accept` decides whether a hit is usable. Without it the first key wins even
 * if its value is null or an empty string, which is how a plausible-looking
 * empty order reaches production.
 */
function deepFind(value, names, accept = (v) => v !== null && v !== undefined && v !== '') {
  const wanted = new Set(names.map(normalizeKey));
  const queue = [value];

  while (queue.length > 0) {
    const node = queue.shift();
    if (node === null || typeof node !== 'object') continue;

    if (Array.isArray(node)) {
      queue.push(...node);
      continue;
    }

    for (const [key, val] of Object.entries(node)) {
      if (wanted.has(normalizeKey(key)) && accept(val)) return val;
    }
    for (const val of Object.values(node)) {
      if (val !== null && typeof val === 'object') queue.push(val);
    }
  }

  return undefined;
}

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Extract a whole record in one call.
 *
 * `schema` maps an output field to the names it answers to, optionally with a
 * coercion and a default:
 *
 *   { orderId: { names: ['order_id', 'id'] },
 *     total:   { names: ['total', 'price'], coerce: toNumber, default: 0 } }
 *
 * Returns { values, missing }. `missing` lists the fields nothing matched, so
 * the caller can route the item to a human instead of publishing a hole.
 */
function extract(text, schema) {
  const json = findJson(text);
  const values = {};
  const missing = [];

  for (const [field, spec] of Object.entries(schema)) {
    const names = spec.names ?? [field];
    const found = json === null ? undefined : deepFind(json, names, spec.accept);

    if (found === undefined) {
      if ('default' in spec) values[field] = spec.default;
      missing.push(field);
      continue;
    }

    values[field] = spec.coerce ? spec.coerce(found) : found;
  }

  return { values, missing };
}

/**
 * Digits out of "\u0e3f 1,250.00" or "1 250,00 THB". Returns undefined if there is no number.
 *
 * The hard part is deciding what the last separator means. "1,250.00" is a
 * thousand two hundred fifty; so is "1.250,00" and so is "1,250". Guessing that
 * the last separator is always decimal turns $1,299 into 1.299 and a million
 * into 1250, and the wrong number is worse than no number: it passes every
 * downstream check.
 *
 * The rule that actually holds: a separator followed by exactly three digits is
 * grouping, unless it is the only separator and the number also has no other
 * separator type to disambiguate it. Grouping repeats; a decimal point does not.
 */
function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;

  const cleaned = String(value).replace(/[^\d.,-]/g, '');
  if (!/\d/.test(cleaned)) return undefined;

  const negative = /^-/.test(cleaned);
  const digits = cleaned.replace(/-/g, '');

  const separators = digits.match(/[.,]/g) ?? [];
  let normalized;

  if (separators.length === 0) {
    normalized = digits;
  } else {
    const lastAt = Math.max(digits.lastIndexOf(','), digits.lastIndexOf('.'));
    const tail = digits.slice(lastAt + 1);
    const distinct = new Set(separators);

    // More than one separator: the last one is decimal only if the separators
    // differ ("1.250,00"). Repeated identical separators are all grouping
    // ("1,250,000").
    const lastIsDecimal =
      separators.length > 1 ? distinct.size > 1 : !(tail.length === 3);

    normalized = lastIsDecimal
      ? digits.slice(0, lastAt).replace(/[.,]/g, '') + '.' + tail
      : digits.replace(/[.,]/g, '');
  }

  const n = Number(normalized);
  return Number.isNaN(n) ? undefined : negative ? -n : n;
}

module.exports = { extract, findJson, deepFind, toNumber };
