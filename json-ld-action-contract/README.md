# JSON-LD action contract

## The problem

An assistant is asked to get in touch with a business on someone's behalf. It
opens the site and finds a contact form built for human hands: a React widget, a
honeypot field, a token minted by a script, a submit handler that expects
`multipart/form-data`. So it scrapes the markup and guesses.

The guesses land as garbage in the inbox. Fields in the wrong order, an invented
phone number where the form wanted a company name, the honeypot filled in
because it looked like a field. Or the assistant gives up and tells the person
to visit the site themselves.

Meanwhile the site already publishes JSON-LD for search engines: name, address,
services. It describes what the business is and says nothing about what can be
done with it.

## The approach

Publish the action too. `schema.org` has `potentialAction` and `EntryPoint` for
exactly this: a machine-readable statement of the endpoint, the method, the
content type, and where the payload schema lives.

```json
"potentialAction": {
  "@type": "CommunicateAction",
  "target": {
    "@type": "EntryPoint",
    "urlTemplate": "https://example.com/api/enquiry",
    "httpMethod": "POST",
    "contentType": "application/json"
  }
}
```

See [`contract.jsonld`](contract.jsonld) for the whole thing, including the
schema URL, the rate limit, the shape of the response, and an explicit
`humanConfirmation: required` so a well-behaved caller shows the visitor the
payload before sending it.

The endpoint then has to be worth talking to.

**One definition, published and enforced.** The field list lives once in
[`enquiry.js`](enquiry.js). `toJsonSchema()` generates the published schema from
it, `validate()` enforces the same list at the endpoint. A contract whose two
halves drift apart is worse than no contract, because callers trust it. The
tests assert the halves match, including that the JSON-LD advertises the same
schema URL, method and content type the code implements.

**Errors written for a caller that will retry.** The response names the field and
says what is wrong in a sentence: `message: must be at least 20 characters`. A
bare 400 gets four identical retries and then a support ticket. Every problem is
returned at once, not one per round trip.

**Unknown fields are rejected, not dropped.** A caller that sends `phone` needs
to hear that `phone` is not part of the contract. Silently ignoring it means the
visitor believes they sent a phone number and nobody has it.

## Use

```js
const { validate, respond, toJsonSchema } = require('./enquiry');

// POST /api/enquiry
const result = validate(request.body);
const { status, body } = respond(result, { reference: newReference() });
response.status(status).json(body);

// GET /api/enquiry.schema.json
response.json(toJsonSchema());
```

## Trade-offs

This is an open write endpoint that you have advertised, so it needs the
protections any such endpoint needs: rate limiting per source, a size cap,
authentication if the action does anything consequential. The `rateLimit`
property in the JSON-LD is documentation, not enforcement.

Assistants may ignore the contract entirely, or honour the endpoint and skip
`humanConfirmation`. Nothing in the markup can compel a caller, so treat every
submission as untrusted input and never let an advertised action do something
irreversible without a human step on your side.

Only expose actions that are safe to invoke without a session. An enquiry, a
callback request, an availability check: good. Anything that spends money,
changes an account or sends a message as the user: not without real
authentication.

`potentialAction` on schema.org is loosely specified and support varies between
consumers. Keep the entry point conventional (POST, JSON, a published schema) so
a caller can work it out even if it does not recognize the vocabulary.

## Run the tests

```bash
node --test
```
