const { createClient } = require('redis');
require('dotenv').config();

let client = null;
let connected = false;

function createRedisClient() {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';

  const c = createClient({
    url,
    socket: {
      reconnectStrategy: (retries) => {
        if (retries > 3) {
          console.warn(`[redis] giving up reconnect after ${retries} attempts; operating in no-cache mode`);
          connected = false;
          return new Error('Redis reconnect exhausted');
        }
        console.warn(`[redis] reconnect attempt ${retries}...`);
        return Math.min(retries * 500, 3000);
      },
    },
  });

  c.on('error', (err) => {
    console.warn('[redis] client error:', err.message || String(err));
    connected = false;
  });

  c.on('ready', () => {
    console.log('[redis] ready');
    connected = true;
  });

  c.on('end', () => {
    connected = false;
  });

  return c;
}

async function connect() {
  if (client) return client;
  client = createRedisClient();
  try {
    await client.connect();
    connected = true;
  } catch (err) {
    console.warn('[redis] failed to connect, cache disabled:', err.message);
    connected = false;
  }
  return client;
}

function isReady() {
  return connected && client && client.isReady;
}

async function get(key) {
  if (!isReady()) return null;
  try {
    return await client.get(key);
  } catch (err) {
    console.warn('[redis] get error:', err.message);
    return null;
  }
}

async function set(key, value, ttlSec) {
  if (!isReady()) return false;
  try {
    if (ttlSec !== undefined && ttlSec !== null) {
      await client.set(key, value, { EX: ttlSec });
    } else {
      await client.set(key, value);
    }
    return true;
  } catch (err) {
    console.warn('[redis] set error:', err.message);
    return false;
  }
}

async function del(key) {
  if (!isReady()) return 0;
  try {
    return await client.del(key);
  } catch (err) {
    console.warn('[redis] del error:', err.message);
    return 0;
  }
}

async function delPattern(pattern) {
  if (!isReady()) return 0;
  try {
    let cursor = 0;
    let deleted = 0;
    do {
      const { cursor: nextCursor, keys } = await client.scan(cursor, { MATCH: pattern, COUNT: 100 });
      cursor = nextCursor;
      if (keys.length > 0) {
        deleted += await client.del(keys);
      }
    } while (cursor !== 0);
    return deleted;
  } catch (err) {
    console.warn('[redis] delPattern error:', err.message);
    return 0;
  }
}

module.exports = {
  connect,
  get,
  set,
  del,
  delPattern,
  isReady,
};
