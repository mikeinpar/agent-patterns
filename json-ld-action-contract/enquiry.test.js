const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { FIELDS, toJsonSchema, validate, respond } = require('./enquiry');

const GOOD = {
  name: 'Dana Okafor',
  email: 'dana@example.org',
  projectType: 'integration',
  message: 'We need our Shopify orders to land in Postgres every hour.',
};

test('a well-formed enquiry is accepted', () => {
  const result = validate(GOOD);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.value.name, 'Dana Okafor');
});

test('whitespace is trimmed off accepted values', () => {
  const result = validate({ ...GOOD, name: '  Dana Okafor  ' });
  assert.equal(result.value.name, 'Dana Okafor');
});

test('optional fields may be omitted', () => {
  assert.equal(validate(GOOD).valid, true);
});

test('an optional field is validated when present', () => {
  const result = validate({ ...GOOD, budgetUsd: 'about ten thousand' });
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, [{ field: 'budgetUsd', problem: 'must be a whole number' }]);
});

test('every missing required field is reported at once, not one per round trip', () => {
  const result = validate({ name: 'Dana Okafor' });
  const fields = result.errors.map((e) => e.field).sort();
  assert.deepEqual(fields, ['email', 'message', 'projectType']);
});

test('an empty string counts as missing', () => {
  const result = validate({ ...GOOD, name: '   ' });
  assert.deepEqual(result.errors, [{ field: 'name', problem: 'is required' }]);
});

test('a bad email says so in a sentence the caller can act on', () => {
  const result = validate({ ...GOOD, email: 'dana at example.org' });
  assert.deepEqual(result.errors, [{ field: 'email', problem: 'must be a valid email address' }]);
});

test('a value outside the enum lists the allowed values', () => {
  const result = validate({ ...GOOD, projectType: 'website' });
  assert.match(result.errors[0].problem, /integration, agent, data-pipeline, other/);
});

test('a too-short message names the minimum', () => {
  const result = validate({ ...GOOD, message: 'hi' });
  assert.deepEqual(result.errors, [{ field: 'message', problem: 'must be at least 20 characters' }]);
});

test('an unknown field is rejected rather than quietly dropped', () => {
  const result = validate({ ...GOOD, phone: '+1 555 0100' });
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, [{ field: 'phone', problem: 'unknown field, it is not part of the contract' }]);
});

test('a non-object body is rejected without throwing', () => {
  for (const body of [null, 'a string', 42, ['array']]) {
    const result = validate(body);
    assert.equal(result.valid, false);
    assert.equal(result.errors[0].problem, 'body must be a JSON object');
  }
});

test('no value survives a failed validation', () => {
  assert.equal(validate({ name: 'Dana Okafor' }).value, null);
});

// The contract is only worth something if the published half matches the enforced half.

test('the generated schema requires exactly the fields validate() requires', () => {
  const schema = toJsonSchema();
  const requiredInCode = Object.entries(FIELDS)
    .filter(([, spec]) => spec.required)
    .map(([name]) => name);
  assert.deepEqual(schema.required.sort(), requiredInCode.sort());
});

test('the generated schema publishes every field and nothing else', () => {
  const schema = toJsonSchema();
  assert.deepEqual(Object.keys(schema.properties).sort(), Object.keys(FIELDS).sort());
  assert.equal(schema.additionalProperties, false);
});

test('the schema does not leak the internal required flag into published properties', () => {
  for (const property of Object.values(toJsonSchema().properties)) {
    assert.equal('required' in property, false);
  }
});

test('the JSON-LD file points at the schema url the generator uses', () => {
  const jsonld = JSON.parse(fs.readFileSync(path.join(__dirname, 'contract.jsonld'), 'utf8'));
  const advertised = jsonld.potentialAction.additionalProperty.find((p) => p.name === 'schemaUrl').value;
  assert.equal(advertised, toJsonSchema().$id);
});

test('the JSON-LD advertises the same method and content type the endpoint expects', () => {
  const jsonld = JSON.parse(fs.readFileSync(path.join(__dirname, 'contract.jsonld'), 'utf8'));
  const target = jsonld.potentialAction.target;
  assert.equal(target.httpMethod, 'POST');
  assert.equal(target.contentType, 'application/json');
});

test('a rejected enquiry answers 400 with the field errors', () => {
  const { status, body } = respond(validate({ name: 'Dana Okafor' }));
  assert.equal(status, 400);
  assert.equal(body.accepted, false);
  assert.ok(body.errors.length > 0);
});

test('an accepted enquiry answers 202 with a reference', () => {
  const { status, body } = respond(validate(GOOD), { reference: 'ENQ-2026-0042' });
  assert.equal(status, 202);
  assert.deepEqual(body, { accepted: true, reference: 'ENQ-2026-0042' });
});
