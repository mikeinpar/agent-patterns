/**
 * One definition of the enquiry payload, used three ways.
 *
 * An action contract is a promise to a caller you will never meet: an assistant
 * reads the JSON-LD on the page, builds a body, and posts it. The promise is
 * only worth something if the published schema and the code at the endpoint
 * agree, and they stop agreeing the first time someone adds a field to one and
 * forgets the other.
 *
 * So the field list lives here once. `toJsonSchema()` publishes it for the
 * caller, `validate()` enforces it at the endpoint, and neither can drift.
 */

const FIELDS = {
  name: {
    type: 'string',
    required: true,
    maxLength: 120,
    description: "The visitor's name.",
  },
  email: {
    type: 'string',
    required: true,
    format: 'email',
    maxLength: 254,
    description: 'A reply address. Ask the visitor, never invent one.',
  },
  projectType: {
    type: 'string',
    required: true,
    enum: ['integration', 'agent', 'data-pipeline', 'other'],
    description: 'Closest match. Use "other" rather than guessing a category.',
  },
  message: {
    type: 'string',
    required: true,
    minLength: 20,
    maxLength: 2000,
    description: 'What the visitor wants, in their own words.',
  },
  budgetUsd: {
    type: 'integer',
    required: false,
    minimum: 0,
    maximum: 10_000_000,
    description: 'Only if the visitor stated a number. Do not estimate one for them.',
  },
  submittedBy: {
    type: 'string',
    required: false,
    maxLength: 80,
    description: 'Name of the assistant submitting on the visitor\'s behalf, for the audit log.',
  },
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** The published half of the contract: standard JSON Schema, generated from FIELDS. */
function toJsonSchema({ id = 'https://example.com/api/enquiry.schema.json' } = {}) {
  const properties = {};
  const required = [];

  for (const [name, spec] of Object.entries(FIELDS)) {
    const { required: isRequired, ...rest } = spec;
    properties[name] = rest;
    if (isRequired) required.push(name);
  }

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: id,
    title: 'Project enquiry',
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

/**
 * The enforced half. Returns { valid, value, errors }.
 *
 * Errors name the field and say what is wrong in a sentence, because the caller
 * is a language model that will try again. "message: must be at least 20
 * characters" gets a usable retry; "400 Bad Request" gets four identical
 * retries and then a support ticket.
 */
function validate(body) {
  const errors = [];

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false, value: null, errors: [{ field: null, problem: 'body must be a JSON object' }] };
  }

  for (const key of Object.keys(body)) {
    if (!(key in FIELDS)) {
      errors.push({ field: key, problem: 'unknown field, it is not part of the contract' });
    }
  }

  const value = {};

  for (const [field, spec] of Object.entries(FIELDS)) {
    const raw = body[field];
    const empty = raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '');

    if (empty) {
      if (spec.required) errors.push({ field, problem: 'is required' });
      continue;
    }

    const problem = checkOne(spec, raw);
    if (problem !== null) {
      errors.push({ field, problem });
      continue;
    }

    value[field] = typeof raw === 'string' ? raw.trim() : raw;
  }

  return { valid: errors.length === 0, value: errors.length === 0 ? value : null, errors };
}

function checkOne(spec, raw) {
  if (spec.type === 'integer') {
    if (typeof raw !== 'number' || !Number.isInteger(raw)) return 'must be a whole number';
    if (spec.minimum !== undefined && raw < spec.minimum) return `must be at least ${spec.minimum}`;
    if (spec.maximum !== undefined && raw > spec.maximum) return `must be at most ${spec.maximum}`;
    return null;
  }

  if (typeof raw !== 'string') return 'must be a string';

  const text = raw.trim();
  if (spec.enum && !spec.enum.includes(text)) return `must be one of: ${spec.enum.join(', ')}`;
  if (spec.minLength !== undefined && text.length < spec.minLength) {
    return `must be at least ${spec.minLength} characters`;
  }
  if (spec.maxLength !== undefined && text.length > spec.maxLength) {
    return `must be at most ${spec.maxLength} characters`;
  }
  if (spec.format === 'email' && !EMAIL_RE.test(text)) return 'must be a valid email address';

  return null;
}

/**
 * The response an assistant gets back. Success carries a reference the visitor
 * can quote; failure carries the field-level errors so the next attempt can be
 * a corrected one.
 */
function respond(result, { reference } = {}) {
  return result.valid
    ? { status: 202, body: { accepted: true, reference } }
    : { status: 400, body: { accepted: false, errors: result.errors } };
}

module.exports = { FIELDS, toJsonSchema, validate, respond };
