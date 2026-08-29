# Silence protocol

## The problem

Two ways an autonomous chat agent embarrasses the business that deployed it.

**It talks over the operator.** A customer asks something the agent cannot
answer well. The operator sees the thread and replies by hand. The agent, which
has no idea a human is in the room, replies too. The customer now has two
answers that disagree, and the operator finds out about it from the customer.

**It answers every fragment.** People type the way they think: "hi", then "quick
question", then "about the delivery". Three inbound messages, three agent
replies, three LLM calls, one customer being talked at.

Both are usually patched with prompt instructions, which do not work, because
neither problem is about what the model says. They are about when it is allowed
to speak at all.

## The approach

Two keys with expiry times, which is why this belongs in Redis rather than in
the agent's prompt.

**Silence.** Every operator message writes `silence:<conversation>` with a long
TTL, and the agent checks that key before it composes anything. The key extends
on each further operator message, so a thread a human is actively working stays
quiet. `release()` hands it back early when they are done. If nothing happens,
the TTL returns the conversation to the agent on its own; there is nothing to
sweep and nothing to remember to switch back on.

**Debounce.** Every customer message appends to a buffer and stamps it with a
token, and the newest message owns the buffer. The handler waits, then calls
`collect()` with its token. If a later message arrived meanwhile, the token no
longer matches and this handler returns null and does nothing, because the later
one will answer for the whole burst. One reply, one LLM call, the full question.

The two compose: `collect()` re-checks silence, so an operator who steps in
during the debounce window cancels a reply that was already on its way.

## Use

```js
const Redis = require('ioredis');
const { SilenceProtocol, redisStore } = require('./silence');

const protocol = new SilenceProtocol(redisStore(new Redis(process.env.REDIS_URL)), {
  silenceMs: 24 * 60 * 60 * 1000,
  debounceMs: 8000,
});

// Operator webhook
await protocol.humanReplied(conversationId);

// Customer webhook
const decision = await protocol.received(conversationId, text);
if (decision.action === 'silenced') return;

await sleep(decision.waitMs);
const burst = await protocol.collect(conversationId, decision.token);
if (burst === null) return; // superseded, or an operator stepped in

await reply(conversationId, await agent(burst));
```

`memoryStore()` is the same interface backed by a `Map`. It is what the tests
use and it is fine for a single process, but two workers each get their own Map
and will happily talk over each other, so anything with more than one worker
needs the Redis store.

## Trade-offs

**The debounce buffer is not atomic, and that is a real limitation.**
`received()` reads the buffer, appends to it and writes it back. Two workers
handling two messages of the same burst at the same instant can lose one, and
the surviving token may not belong to the last message. The honest fix is to
stop treating the buffer as one value: `RPUSH` the message onto a list and
`SET` the token separately, or do both in one Lua script. It is written the
simple way here because the pattern is the point, but do not ship the simple
way behind a load balancer. Silence itself is a single key with a TTL, so it
has no such problem.

The debounce is a fixed wait, so every answer is at least `debounceMs` late.
Eight seconds is comfortable for messenger conversations and far too slow for a
support widget where the customer is watching a typing indicator. Tune it per
channel.

Silence is per conversation, not per customer. Someone who writes on two
channels gets the agent on one and the operator on the other. Key by whatever
identity your channels actually share if that matters.

The sleep in the example is illustrative. In a workflow runner it is a Wait
node; in a worker it is a delayed job. Do not hold an HTTP request open for
eight seconds to implement it.

Detecting the operator is the integration's job, not this module's. Every
messenger API marks outbound-by-human differently, and getting that detection
wrong makes the agent silence itself in response to its own messages.

## Run the tests

```bash
node --test
```

The tests inject a fake clock, so a 24-hour silence window is verified in
microseconds.
