# Self-healing JSON extraction

## The problem

You ask a model for `{"order_id": ..., "total": ...}`. Most of the time you get
it. The rest of the time you get one of these:

- the same object wrapped in a fenced code block, with the price as `"฿ 1,250.00"`
- `{"result": {"data": {"order_id": "A-1003", "total": 90}}}`
- `[{"orderNumber": "A-1004", "amount": "1 250,50"}]`
- `Sure! The parsed order is {"order_id": "A-1006", "total": 15}. Let me know if you need more.`

A parser written against the first shape returns `undefined` for all four. That
is the expensive part: not a crash, but a quiet `undefined` that flows on and
becomes a kitchen ticket with no price on it. Tightening the prompt helps and
then stops helping, because the next model version, the next temperature change
or the next unusually long order brings the wrappers back.

## The approach

Stop asserting the shape. Do two things instead.

**Find the JSON.** Try the raw string, then a fenced code block, then scan for a
balanced `{` or `[` span inside prose, skipping brackets that appear inside
strings.

**Find the fields by name, not by path.** Walk the parsed tree breadth-first
looking for each field under any of the names it answers to, comparing keys
with punctuation and case stripped, so `order_id`, `orderId`, `Order ID` and
`ORDER_ID` are the same key. Breadth-first matters: a top-level `id` should beat
a nested one.

**Report what was not found.** `extract()` returns `missing`, a list of fields
nothing matched. A field that is absent is different from a field that is empty,
and both are different from a field that parsed fine. Without this list the
pattern trades a loud failure for a silent one, which is worse than the problem
it set out to fix.

## Use

```js
const { extract, toNumber } = require('./extract');

const { values, missing } = extract(modelResponse, {
  orderId: { names: ['order_id', 'id', 'orderNumber'] },
  total: { names: ['total', 'price', 'amount'], coerce: toNumber },
});

if (missing.length > 0) {
  // Route to a human. Do not publish a half-built record.
  return escalate({ missing, raw: modelResponse });
}

return values;
```

In n8n this is the body of a Code node sitting between the LLM node and whatever
consumes the result.

## What "self-healing" means here

It re-locks onto the fields when the response shape changes, without anyone
editing a path. It does not repair broken JSON: if the model truncates
mid-object there is nothing to recover, and the response fails cleanly with
every field listed as missing.

## Trade-offs

Name matching is deliberately loose, so a response containing both a customer id
and an order id under similar names can match the wrong one. Keep the name lists
narrow and specific, and put the most precise name first.

Money parsing is a guess about a human convention, not a fact. `toNumber` reads
a separator followed by exactly three digits as grouping, so `1,250` is a
thousand two hundred fifty and `12,50` is twelve and a half. That rule covers
both European and Anglo formats and gets `1.250` wrong if someone really meant
one and a quarter. When the currency is known, parse with `Intl.NumberFormat`
for that locale instead of guessing.

An escalation path is not optional. The value of this pattern is that it turns
"most responses parse" into "every response either parses or is visibly
flagged", and the second half only exists if something acts on `missing`.

## Run the tests

```bash
node --test
```
