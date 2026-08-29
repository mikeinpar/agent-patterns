/**
 * Two rules that keep an autonomous chat agent from talking over people:
 * silence while a human operator is handling a conversation, and a debounce so
 * a burst of typing gets one reply instead of three. See README.md for why.
 *
 * Both rules are a key with an expiry, which is why Redis is the natural home
 * for them. The store is injected rather than imported so the logic can be
 * tested without a server; see redisStore() at the bottom.
 */

const DEFAULT_SILENCE_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_DEBOUNCE_MS = 8 * 1000;

class SilenceProtocol {
  /**
   * @param {object} store        key/value store with ttl, see memoryStore()
   * @param {object} [options]
   * @param {number} [options.silenceMs]  how long the agent stays quiet after a human speaks
   * @param {number} [options.debounceMs] how long to wait for the customer to stop typing
   * @param {function} [options.now]      clock, injectable for tests
   */
  constructor(store, { silenceMs = DEFAULT_SILENCE_MS, debounceMs = DEFAULT_DEBOUNCE_MS, now = Date.now } = {}) {
    this.store = store;
    this.silenceMs = silenceMs;
    this.debounceMs = debounceMs;
    this.now = now;
  }

  /**
   * Call this on every operator message. Starts or extends the quiet window.
   *
   * Extending matters: an operator handling a conversation for an hour should
   * not have the agent wake up mid-thread because the window started at the
   * first reply.
   */
  async humanReplied(conversationId) {
    await this.store.set(this._silenceKey(conversationId), String(this.now()), this.silenceMs);
  }

  /** True while the agent must stay out of this conversation. */
  async isSilenced(conversationId) {
    return (await this.store.get(this._silenceKey(conversationId))) !== null;
  }

  /** Hand the conversation back to the agent early, when the operator is done. */
  async release(conversationId) {
    await this.store.del(this._silenceKey(conversationId));
  }

  /**
   * Call this on every inbound customer message. Returns what to do with it.
   *
   * The contract: record the message, then wait debounceMs and call
   * collect(). If another message arrived meanwhile, this call is no longer
   * the last one and it drops out, because the later call will answer for the
   * whole burst.
   *
   *   { action: 'silenced' }                    a human owns this conversation
   *   { action: 'wait', waitMs, token }         call collect(id, token) after waitMs
   */
  async received(conversationId, text) {
    if (await this.isSilenced(conversationId)) {
      return { action: 'silenced' };
    }

    const token = `${this.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const key = this._bufferKey(conversationId);
    const buffer = (await this.store.get(key)) ?? { messages: [] };

    buffer.messages.push(text);
    buffer.token = token; // the newest message owns the buffer

    // TTL generously exceeds the debounce so a slow worker does not lose the burst.
    await this.store.set(key, buffer, this.debounceMs * 10);

    return { action: 'wait', waitMs: this.debounceMs, token };
  }

  /**
   * Call after waiting. Returns the joined burst if this token still owns the
   * buffer, or null if a newer message superseded it.
   */
  async collect(conversationId, token) {
    if (await this.isSilenced(conversationId)) return null;

    const key = this._bufferKey(conversationId);
    const buffer = await this.store.get(key);

    if (buffer === null || buffer.token !== token) return null; // superseded

    await this.store.del(key);
    return buffer.messages.join('\n');
  }

  _silenceKey(id) {
    return `silence:${id}`;
  }

  _bufferKey(id) {
    return `debounce:${id}`;
  }
}

/**
 * In-memory store. Good enough for one process and for the tests; use
 * redisStore() as soon as there is more than one worker, because a second
 * worker with its own Map will happily answer over the first one.
 */
function memoryStore({ now = Date.now } = {}) {
  const data = new Map(); // key -> { value, expiresAt }

  return {
    async get(key) {
      const entry = data.get(key);
      if (entry === undefined) return null;
      if (entry.expiresAt <= now()) {
        data.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key, value, ttlMs) {
      data.set(key, { value, expiresAt: now() + ttlMs });
    },
    async del(key) {
      data.delete(key);
    },
  };
}

/**
 * The same interface over Redis, written against ioredis:
 *
 *   const store = redisStore(new Redis(process.env.REDIS_URL));
 *   const protocol = new SilenceProtocol(store);
 *
 * node-redis v4 takes its options as an object instead, so there `set` becomes
 * `client.set(key, value, { PX: ttlMs })`. Values are JSON so the buffer object
 * survives the round trip, and expiry is Redis's own, so nothing has to sweep
 * old conversations.
 *
 * Note the read-modify-write in received(): two workers handling two messages
 * of the same burst at the same instant can lose one. Fixing that properly
 * means RPUSH for the messages plus a separate token key, or one Lua script.
 * It is left out here to keep the pattern readable; see README.md.
 */
function redisStore(client, { prefix = 'agent:' } = {}) {
  return {
    async get(key) {
      const raw = await client.get(prefix + key);
      return raw === null ? null : JSON.parse(raw);
    },
    async set(key, value, ttlMs) {
      await client.set(prefix + key, JSON.stringify(value), 'PX', ttlMs);
    },
    async del(key) {
      await client.del(prefix + key);
    },
  };
}

module.exports = { SilenceProtocol, memoryStore, redisStore, DEFAULT_SILENCE_MS, DEFAULT_DEBOUNCE_MS };
