require('dotenv').config();
const express = require('express');
const db = require('./db');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

app.get('/api/v1/health', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT NOW() AS now');
    res.json({ status: 'ok', db_time: rows[0].now });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
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

    return res.json({
      page,
      per_page: perPage,
      total,
      total_pages: Math.ceil(total / perPage) || 0,
      items: itemsResult.rows,
    });
  } catch (err) {
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

app.post('/api/v1/orders', async (req, res) => {
  const { user_id, items, shipping_address, billing_address } = req.body;

  if (!user_id) {
    return res.status(400).json({ error: 'missing_fields', message: 'user_id is required' });
  }
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
    await client.query('BEGIN');

    const userCheck = await client.query(
      'SELECT id FROM users WHERE id = $1',
      [user_id]
    );
    if (userCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'invalid_user', message: `user_id ${user_id} does not exist` });
    }

    const lineItems = [];
    let totalAmount = 0;

    for (const it of items) {
      const productResult = await client.query(
        `SELECT id, name, price, stock_qty, is_active
         FROM products WHERE id = $1 FOR UPDATE`,
        [it.product_id]
      );

      if (productResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({
          error: 'product_not_found',
          message: `product_id ${it.product_id} not found`,
        });
      }

      const product = productResult.rows[0];
      if (!product.is_active) {
        await client.query('ROLLBACK');
        return res.status(404).json({
          error: 'product_inactive',
          message: `product_id ${it.product_id} is not available`,
        });
      }

      const qty = Number(it.quantity);
      if (product.stock_qty < qty) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'insufficient_stock',
          items: [{ product_id: product.id, requested: qty, available: product.stock_qty }],
        });
      }

      await client.query(
        'UPDATE products SET stock_qty = stock_qty - $1 WHERE id = $2',
        [qty, product.id]
      );

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

    const date = new Date();
    const yyyymmdd = date.toISOString().slice(0, 10).replace(/-/g, '');
    const orderNumber = `ORD-${yyyymmdd}-${String(Date.now()).slice(-6)}`;

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
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    return res.status(500).json({ error: 'server_error', message: err.message });
  } finally {
    if (client) {
      try { client.release(); } catch (_) {}
    }
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/api/v1/health`);
  });
}

module.exports = app;
