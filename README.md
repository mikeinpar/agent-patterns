# agent-patterns

[![tests](https://github.com/mikeinpar/agent-patterns/actions/workflows/tests.yml/badge.svg)](https://github.com/mikeinpar/agent-patterns/actions/workflows/tests.yml)

Three failures I have had to design around in LLM systems running for clients,
extracted into isolated, runnable examples.

**An agent that argues with your operator in front of the customer.** A human
answers the thread by hand, the agent answers too, and the customer gets two
contradicting replies. Fixed in [silence-protocol](silence-protocol/), along
with the related problem of answering each fragment of "hi" / "quick question"
/ "about the delivery" separately.

**A price that arrives without a price.** The model returns the field you asked
for, nested one level deeper than last week, and a parser written against last
week's shape returns `undefined`. It does not crash. It writes an order with a
hole in it. Fixed in [self-healing-json](self-healing-json/), which finds fields
by name rather than by path and reports what it could not find.

**A form that only humans can fill in.** An assistant sent to contact your
business finds a React widget, a honeypot and a token minted by a script, so it
scrapes the markup and guesses, and the guesses land in your inbox. Fixed in
[json-ld-action-contract](json-ld-action-contract/), which publishes a
machine-readable entry point and validates against a schema generated from the
same definition it publishes.

The client systems are under NDA. The problems are not, and none of these
depends on anything specific to one client.

## Running it

```bash
npm test        # 50 tests, no dependencies, Node 20 or newer
```

Each folder holds a README stating the problem and what the technique costs, one
small module, and its tests. These are working examples at the smallest size
that still demonstrates the technique, not libraries: read the module, take the
twenty lines you need.

## Why JavaScript

These three lived in n8n Code nodes, where JavaScript is the language of the
runtime. The Python side of the same work is in
[postimat-mcp-server](https://github.com/mikeinpar/postimat-mcp-server), an MCP
server over Postgres with asyncpg and a pytest suite.

## One more, without the code

A fourth pattern is worth stating even though the code for it is unremarkable.
Route a failure into one of three lanes rather than handling every failure the
same way: retry quietly, park and retry slowly, or stop and wake a person. The
part people get wrong is the fourth rule that stitches the lanes together. A
transient error that keeps repeating past the attempt ceiling is not transient
any more, whatever its status code says, and it has to escalate. Without that
rule the retry lane swallows outages silently; with it, alerts stay rare enough
that people still read them.

More work, written up with numbers: [nextai.design](https://nextai.design/)

MIT licensed.
