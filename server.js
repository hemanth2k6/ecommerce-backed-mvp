require('dotenv').config();
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('./db');
const cache = require('./redis');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const PRODUCTS_CACHE_TTL = parseInt(process.env.PRODUCTS_CACHE_TTL_SEC || 30, 10);
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-key-change-me-in-production';

const PRODUCTS_CACHE_KEY_PREFIX = 'products:list:';

function productsCacheKey(req) {
  const qs = new URLSearchParams({
    page: req.query.page || '',
    per_page: req.query.per_page || '',
    search: req.query.search || '',
    min_price: req.query.min_price || '',
    max_price: req.query.max_price || '',
    sort: req.query.sort || '',
  }).toString();
  return `${PRODUCTS_CACHE_KEY_PREFIX}${qs}`;
}

async function invalidateProductsCache() {
  try {
    const n = await cache.delPattern(`${PRODUCTS_CACHE_KEY_PREFIX}*`);
    if (n > 0) {
      console.log(`[cache] invalidated ${n} product-list cache keys`);
    }
  } catch (_) {
  }
}

function authenticateUser(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid token' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'unauthorized', message: 'Invalid or expired token' });
  }
}

app.get('/api/v1/health', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT NOW() AS now');
    res.json({
      status: 'ok',
      db_time: rows[0].now,
      cache_ready: cache.isReady(),
    });
  } catch (err) {
    res.status(500).json({ 
      status: 'error', 
      message: err.message || String(err), 
      stack: err.stack,
      cache_ready: cache.isReady() 
    });
  }
});

app.post('/api/v1/users/register', async (req, res) => {
  const { email, password, first_name, last_name, address } = req.body;
  if (!email || !password || !first_name || !last_name) {
    return res.status(400).json({ error: 'missing_fields', message: 'email, password, first_name, and last_name are required' });
  }
  try {
    const password_hash = await bcrypt.hash(password, 10);
    const { rows } = await db.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, address)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, first_name, last_name, role, created_at`,
      [email, password_hash, first_name, last_name, address || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'conflict', message: 'Email already exists' });
    }
    res.status(500).json({ error: 'server_error', message: err.message });
  }
});

app.post('/api/v1/users/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'missing_fields', message: 'email and password are required' });
  }
  try {
    const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    if (rows.length === 0) {
      return res.status(401).json({ error: 'unauthorized', message: 'Invalid credentials' });
    }
    const user = rows[0];
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'unauthorized', message: 'Invalid credentials' });
    }
    const token = jwt.sign({ id: user.id, role: user.role, email: user.email }, JWT_SECRET, { expiresIn: '1d' });
    res.json({ token, user: { id: user.id, email: user.email, first_name: user.first_name, last_name: user.last_name, role: user.role } });
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: err.message });
  }
});

app.post('/api/v1/products', async (req, res) => {
  const { name, description, sku, price, stock_qty, image_url } = req.body;

  if (!name || !sku || price === undefined || price === null) {
    return res.status(400).json({
      error: 'missing_fields',
      message: 'name, sku, and price are required',
    });
  }

  if (Number(price) < 0) {
    return res.status(400).json({
      error: 'invalid_price',
      message: 'price must be >= 0',
    });
  }

  const stock = stock_qty === undefined || stock_qty === null ? 0 : Number(stock_qty);
  if (stock < 0) {
    return res.status(400).json({
      error: 'invalid_stock',
      message: 'stock_qty must be >= 0',
    });
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO products (name, description, sku, price, stock_qty, image_url)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, description, sku,
                 price::text, stock_qty, is_active, image_url, created_at`,
      [name, description || null, sku, Number(price), stock, image_url || null]
    );

    await invalidateProductsCache();

    return res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        error: 'duplicate_sku',
        message: `sku '${sku}' already exists`,
      });
    }
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

app.get('/api/v1/products', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(req.query.per_page, 10) || 20));
  const offset = (page - 1) * perPage;

  const whereClauses = ['is_active = TRUE'];
  const params = [];

  if (req.query.search) {
    params.push(`%${req.query.search}%`);
    whereClauses.push(`name ILIKE $${params.length}`);
  }

  if (req.query.min_price !== undefined) {
    params.push(Number(req.query.min_price));
    whereClauses.push(`price >= $${params.length}`);
  }

  if (req.query.max_price !== undefined) {
    params.push(Number(req.query.max_price));
    whereClauses.push(`price <= $${params.length}`);
  }

  let orderBy = 'created_at DESC';
  switch (req.query.sort) {
    case 'price_asc':
      orderBy = 'price ASC';
      break;
    case 'price_desc':
      orderBy = 'price DESC';
      break;
    case 'newest':
    default:
      orderBy = 'created_at DESC';
  }

  const cacheKey = productsCacheKey(req);
  const cachedRaw = await cache.get(cacheKey);
  if (cachedRaw) {
    try {
      const cached = JSON.parse(cachedRaw);
      return res.setHeader('X-Cache', 'HIT').json(cached);
    } catch (_) {
      cache.del(cacheKey).catch(() => { });
    }
  }

  try {
    const where = whereClauses.join(' AND ');

    const countResult = await db.query(
      `SELECT COUNT(*)::int AS total FROM products WHERE ${where}`,
      params
    );
    const total = countResult.rows[0].total;

    const itemsParams = [...params, perPage, offset];
    const itemsResult = await db.query(
      `SELECT id, name, description, sku,
              price::text, stock_qty, is_active, image_url, created_at
       FROM products
       WHERE ${where}
       ORDER BY ${orderBy}
       LIMIT $${itemsParams.length - 1} OFFSET $${itemsParams.length}`,
      itemsParams
    );

    const body = {
      page,
      per_page: perPage,
      total,
      total_pages: Math.ceil(total / perPage) || 0,
      items: itemsResult.rows,
    };

    cache.set(cacheKey, JSON.stringify(body), PRODUCTS_CACHE_TTL).catch(() => { });

    return res.setHeader('X-Cache', 'MISS').json(body);
  } catch (err) {
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

app.get('/api/v1/products/:id', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM products WHERE id = $1 AND is_active = TRUE', [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'Product not found' });
    }
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: err.message });
  }
});

app.get('/api/v1/orders', authenticateUser, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: err.message });
  }
});

function stockErrorBody(product_id, requested, available) {
  const isOutOfStock = available === 0;
  return {
    error: isOutOfStock ? 'out_of_stock' : 'insufficient_stock',
    message: isOutOfStock
      ? `product_id ${product_id} is out of stock`
      : `product_id ${product_id} has insufficient quantity: requested ${requested}, available ${available}`,
    items: [{ product_id, requested, available }],
  };
}

app.post('/api/v1/orders', authenticateUser, async (req, res) => {
  const { items, shipping_address, billing_address } = req.body;
  const user_id = req.user.id;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'missing_fields', message: 'items array is required and must not be empty' });
  }
  if (!shipping_address || !billing_address) {
    return res.status(400).json({ error: 'missing_fields', message: 'shipping_address and billing_address are required' });
  }

  for (const it of items) {
    if (!it.product_id || !it.quantity) {
      return res.status(400).json({
        error: 'invalid_item',
        message: 'each item must have product_id and quantity',
      });
    }
    if (Number(it.quantity) <= 0) {
      return res.status(400).json({
        error: 'invalid_item',
        message: 'quantity must be > 0',
      });
    }
  }

  let client;
  try {
    client = await db.getClient();
    try {
      await client.query('BEGIN');
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');

      const userCheck = await client.query(
        'SELECT id FROM users WHERE id = $1',
        [user_id]
      );
      if (userCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'invalid_user', message: `user_id ${user_id} does not exist` });
      }

      // Aggregate quantities for duplicate product_ids to prevent multiple locks/deductions on the same row
      const aggregatedItemsMap = new Map();
      for (const it of items) {
        const pid = String(it.product_id);
        const qty = Number(it.quantity);
        if (aggregatedItemsMap.has(pid)) {
          aggregatedItemsMap.get(pid).quantity += qty;
        } else {
          aggregatedItemsMap.set(pid, { product_id: pid, quantity: qty });
        }
      }
      
      const aggregatedItems = Array.from(aggregatedItemsMap.values());
      const sortedItems = aggregatedItems.sort((a, b) => Number(a.product_id) - Number(b.product_id));

      const lineItems = [];
      let totalAmount = 0;

      for (const it of sortedItems) {
        const qty = Number(it.quantity);

        const lockResult = await client.query(
          `SELECT id, name, price, stock_qty, is_active
           FROM products WHERE id = $1 FOR UPDATE`,
          [it.product_id]
        );

        if (lockResult.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({
            error: 'product_not_found',
            message: `product_id ${it.product_id} not found`,
          });
        }

        const product = lockResult.rows[0];
        if (!product.is_active) {
          await client.query('ROLLBACK');
          return res.status(404).json({
            error: 'product_inactive',
            message: `product_id ${it.product_id} is not available`,
          });
        }

        if (product.stock_qty < qty) {
          await client.query('ROLLBACK');
          return res.status(409).json(stockErrorBody(product.id, qty, product.stock_qty));
        }

        const updateResult = await client.query(
          `UPDATE products
           SET stock_qty = stock_qty - $1
           WHERE id = $2 AND stock_qty >= $1
           RETURNING stock_qty AS new_stock`,
          [qty, product.id]
        );

        if (updateResult.rowCount === 0) {
          const recheck = await client.query(
            'SELECT stock_qty FROM products WHERE id = $1',
            [product.id]
          );
          const available = recheck.rows[0] ? recheck.rows[0].stock_qty : 0;
          await client.query('ROLLBACK');
          return res.status(409).json(stockErrorBody(product.id, qty, available));
        }

        const unitPrice = Number(product.price);
        const lineTotal = unitPrice * qty;
        totalAmount += lineTotal;

        lineItems.push({
          product_id: product.id,
          product_name: product.name,
          unit_price: unitPrice.toFixed(2),
          quantity: qty,
          line_total: lineTotal.toFixed(2),
        });
      }

      // Generate a UUID to prevent race conditions on unique index
      const orderNumber = `ORD-${crypto.randomUUID()}`;

      const orderResult = await client.query(
        `INSERT INTO orders
           (user_id, order_number, status, total_amount, shipping_address, billing_address, payment_status)
         VALUES ($1, $2, 'pending', $3, $4, $5, 'unpaid')
         RETURNING id, order_number, status, total_amount::text,
                   payment_status, shipping_address, billing_address, created_at`,
        [user_id, orderNumber, totalAmount.toFixed(2), shipping_address, billing_address]
      );
      const order = orderResult.rows[0];

      const savedItems = [];
      for (const li of lineItems) {
        const r = await client.query(
          `INSERT INTO order_items
             (order_id, product_id, product_name, unit_price, quantity, line_total)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING product_id, product_name, unit_price::text, quantity, line_total::text`,
          [order.id, li.product_id, li.product_name, li.unit_price, li.quantity, li.line_total]
        );
        savedItems.push(r.rows[0]);
      }

      await client.query('COMMIT');

      await invalidateProductsCache();

      return res.status(201).json({
        id: order.id,
        order_number: order.order_number,
        status: order.status,
        total_amount: order.total_amount,
        payment_status: order.payment_status,
        shipping_address: order.shipping_address,
        billing_address: order.billing_address,
        created_at: order.created_at,
        items: savedItems,
      });
    } catch (txErr) {
      try { await client.query('ROLLBACK'); } catch (_) { }
      throw txErr;
    }
  } catch (err) {
    return res.status(500).json({ error: 'server_error', message: err.message });
  } finally {
    if (client) {
      try { client.release(); } catch (_) { }
    }
  }
});

async function boot() {
  if (process.env.REDIS_DISABLED !== '1') {
    await cache.connect();
  }
  if (require.main === module) {
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/api/v1/health`);
      console.log(`Redis cache ready: ${cache.isReady()}`);
    });
  }
}

boot();

module.exports = app;
