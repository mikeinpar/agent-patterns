const test = require('node:test');
const assert = require('node:assert/strict');
const { SilenceProtocol, memoryStore } = require('./silence');

/** A clock we control, so the tests run instantly and deterministically. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

function setup({ silenceMs = 24 * 60 * 60 * 1000, debounceMs = 8000 } = {}) {
  const clock = fakeClock();
  const store = memoryStore({ now: clock.now });
  const protocol = new SilenceProtocol(store, { silenceMs, debounceMs, now: clock.now });
  return { protocol, clock };
}

test('a fresh conversation is not silenced', async () => {
  const { protocol } = setup();
  assert.equal(await protocol.isSilenced('c1'), false);
});

test('an operator reply silences the agent', async () => {
  const { protocol } = setup();
  await protocol.humanReplied('c1');
  assert.equal(await protocol.isSilenced('c1'), true);

  const result = await protocol.received('c1', 'is it still available?');
  assert.deepEqual(result, { action: 'silenced' });
});

test('silence expires on its own', async () => {
  const { protocol, clock } = setup({ silenceMs: 1000 });
  await protocol.humanReplied('c1');

  clock.advance(999);
  assert.equal(await protocol.isSilenced('c1'), true);

  clock.advance(2);
  assert.equal(await protocol.isSilenced('c1'), false);
});

test('a second operator message extends the window rather than letting it lapse', async () => {
  const { protocol, clock } = setup({ silenceMs: 1000 });
  await protocol.humanReplied('c1');

  clock.advance(900);
  await protocol.humanReplied('c1'); // still handling it

  clock.advance(900); // past the original expiry, inside the extended one
  assert.equal(await protocol.isSilenced('c1'), true);
});

test('release hands the conversation back before the window ends', async () => {
  const { protocol } = setup();
  await protocol.humanReplied('c1');
  await protocol.release('c1');
  assert.equal(await protocol.isSilenced('c1'), false);
});

test('silence is per conversation', async () => {
  const { protocol } = setup();
  await protocol.humanReplied('c1');
  assert.equal(await protocol.isSilenced('c2'), false);
});

test('a single message is answered after the debounce', async () => {
  const { protocol } = setup();
  const { action, waitMs, token } = await protocol.received('c1', 'hello');
  assert.equal(action, 'wait');
  assert.equal(waitMs, 8000);

  assert.equal(await protocol.collect('c1', token), 'hello');
});

test('a burst is answered once, as one joined message', async () => {
  const { protocol, clock } = setup();

  const first = await protocol.received('c1', 'hi');
  clock.advance(500);
  const second = await protocol.received('c1', 'quick question');
  clock.advance(500);
  const third = await protocol.received('c1', 'about the delivery');

  // The two earlier calls wake up and find they are no longer the owner.
  assert.equal(await protocol.collect('c1', first.token), null);
  assert.equal(await protocol.collect('c1', second.token), null);

  assert.equal(await protocol.collect('c1', third.token), 'hi\nquick question\nabout the delivery');
});

test('the buffer is emptied after collection, so the next turn starts clean', async () => {
  const { protocol } = setup();
  const first = await protocol.received('c1', 'hi');
  await protocol.collect('c1', first.token);

  const second = await protocol.received('c1', 'still there?');
  assert.equal(await protocol.collect('c1', second.token), 'still there?');
});

test('an operator who answers during the debounce cancels the pending reply', async () => {
  const { protocol } = setup();
  const { token } = await protocol.received('c1', 'is it still available?');

  await protocol.humanReplied('c1'); // operator gets there first

  assert.equal(await protocol.collect('c1', token), null);
});

test('collect with an unknown token returns null instead of throwing', async () => {
  const { protocol } = setup();
  assert.equal(await protocol.collect('c1', 'not-a-real-token'), null);
});

test('two conversations debounce independently', async () => {
  const { protocol } = setup();
  const a = await protocol.received('c1', 'first customer');
  const b = await protocol.received('c2', 'second customer');

  assert.equal(await protocol.collect('c1', a.token), 'first customer');
  assert.equal(await protocol.collect('c2', b.token), 'second customer');
});
