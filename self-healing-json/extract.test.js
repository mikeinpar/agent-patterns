const test = require('node:test');
const assert = require('node:assert/strict');
const { extract, findJson, deepFind, toNumber } = require('./extract');

const SCHEMA = {
  orderId: { names: ['order_id', 'id', 'orderNumber'] },
  total: { names: ['total', 'price', 'amount'], coerce: toNumber },
};

// The four shapes that actually showed up in production for one prompt.

test('clean object, exactly as asked', () => {
  const { values, missing } = extract('{"order_id": "A-1001", "total": 1250}', SCHEMA);
  assert.deepEqual(values, { orderId: 'A-1001', total: 1250 });
  assert.deepEqual(missing, []);
});

test('fenced code block', () => {
  const response = 'Here you go:\n```json\n{"order_id": "A-1002", "total": "฿ 1,250.00"}\n```';
  const { values } = extract(response, SCHEMA);
  assert.deepEqual(values, { orderId: 'A-1002', total: 1250 });
});

test('wrapped in an envelope key', () => {
  const { values } = extract('{"result": {"data": {"order_id": "A-1003", "total": 90}}}', SCHEMA);
  assert.deepEqual(values, { orderId: 'A-1003', total: 90 });
});

test('single-element array', () => {
  const { values } = extract('[{"orderNumber": "A-1004", "amount": "1 250,50"}]', SCHEMA);
  assert.deepEqual(values, { orderId: 'A-1004', total: 1250.5 });
});

test('keys renamed to camelCase and title case', () => {
  const { values } = extract('{"Order ID": "A-1005", "Price": 42}', SCHEMA);
  assert.deepEqual(values, { orderId: 'A-1005', total: 42 });
});

test('prose before and after the object', () => {
  const response = 'Sure! The parsed order is {"order_id": "A-1006", "total": 15}. Let me know if you need more.';
  const { values } = extract(response, SCHEMA);
  assert.deepEqual(values, { orderId: 'A-1006', total: 15 });
});

// Failing loudly is the other half of the job.

test('a field nothing matched is reported, not silently undefined', () => {
  const { values, missing } = extract('{"order_id": "A-1007"}', SCHEMA);
  assert.equal(values.orderId, 'A-1007');
  assert.deepEqual(missing, ['total']);
});

test('an empty value counts as missing', () => {
  const { missing } = extract('{"order_id": "", "total": null}', SCHEMA);
  assert.deepEqual(missing, ['orderId', 'total']);
});

test('a default fills the value but the field still reports as missing', () => {
  const schema = { total: { names: ['total'], default: 0 } };
  const { values, missing } = extract('{"note": "no total here"}', schema);
  assert.equal(values.total, 0);
  assert.deepEqual(missing, ['total']);
});

test('unparseable response marks every field missing instead of throwing', () => {
  const { missing } = extract('I could not complete that request.', SCHEMA);
  assert.deepEqual(missing, ['orderId', 'total']);
});

// Details worth pinning.

test('a top-level key wins over a deeper one', () => {
  const value = deepFind({ id: 'top', nested: { id: 'deep' } }, ['id']);
  assert.equal(value, 'top');
});

test('braces inside strings do not confuse the scanner', () => {
  const parsed = findJson('note: {"comment": "use {curly} braces", "order_id": "A-1008"}');
  assert.equal(parsed.order_id, 'A-1008');
});

test('already-parsed input passes through', () => {
  const { values } = extract({ order_id: 'A-1009', total: 7 }, SCHEMA);
  assert.deepEqual(values, { orderId: 'A-1009', total: 7 });
});

test('number coercion handles both separator conventions', () => {
  assert.equal(toNumber('1,250.00'), 1250);
  assert.equal(toNumber('1.250,00'), 1250);
  assert.equal(toNumber('฿1 250'), 1250);
  assert.equal(toNumber('free'), undefined);
});

test('a grouping separator with no decimal part is not read as a decimal point', () => {
  // The case that makes a naive parser turn $1,299 into 1.299 and quietly
  // write it to the database.
  assert.equal(toNumber('$1,299'), 1299);
  assert.equal(toNumber('1,250'), 1250);
  assert.equal(toNumber('1.250'), 1250);
});

test('repeated separators are all grouping', () => {
  assert.equal(toNumber('1,250,000'), 1250000);
  assert.equal(toNumber('1.250.000'), 1250000);
  assert.equal(toNumber('1,250,000.75'), 1250000.75);
});

test('two decimal places after a lone separator is a decimal point', () => {
  assert.equal(toNumber('12,50'), 12.5);
  assert.equal(toNumber('0.99'), 0.99);
});

test('negative amounts keep their sign', () => {
  assert.equal(toNumber('-1 250,50'), -1250.5);
  assert.equal(toNumber('-42'), -42);
});

test('a number passes through, a non-finite one does not', () => {
  assert.equal(toNumber(1250), 1250);
  assert.equal(toNumber(Infinity), undefined);
  assert.equal(toNumber(NaN), undefined);
});
