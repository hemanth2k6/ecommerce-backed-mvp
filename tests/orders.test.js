const request = require('supertest');
const app = require('../server');
const db = require('../db');

describe('Orders API - Inventory Race Condition', () => {
  let testUserId;
  let testProductId;

  beforeAll(async () => {
    // Insert a test user
    const userRes = await db.query(
      `INSERT INTO users (email, password_hash, first_name, last_name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`,
      [`test_${Date.now()}@example.com`, 'hash', 'Test', 'User']
    );
    testUserId = userRes.rows[0].id;
  });

  afterAll(async () => {
    await db.pool.end();
  });

  it('should correctly handle concurrent orders without overselling', async () => {
    const initialStock = 5;
    const concurrentRequests = 10;

    // Create a product with limited stock
    const sku = `TEST-SKU-${Date.now()}`;
    const productRes = await db.query(
      `INSERT INTO products (name, sku, price, stock_qty)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      ['Test Product', sku, 10.00, initialStock]
    );
    testProductId = productRes.rows[0].id;

    const orderPayload = {
      user_id: testUserId,
      items: [{ product_id: testProductId, quantity: 1 }],
      shipping_address: '123 Test St',
      billing_address: '123 Test St',
    };

    // Send multiple concurrent requests to buy the product
    const requests = Array.from({ length: concurrentRequests }).map(() =>
      request(app).post('/api/v1/orders').send(orderPayload)
    );

    const responses = await Promise.all(requests);

    let successCount = 0;
    let conflictCount = 0;

    responses.forEach(res => {
      if (res.status === 201) {
        successCount++;
      } else if (res.status === 409) {
        conflictCount++;
      }
    });

    // We only have initialStock, so exactly initialStock requests should succeed.
    expect(successCount).toBe(initialStock);
    expect(conflictCount).toBe(concurrentRequests - initialStock);

    // Verify stock is exactly 0 in the database
    const finalStockRes = await db.query('SELECT stock_qty FROM products WHERE id = $1', [testProductId]);
    expect(finalStockRes.rows[0].stock_qty).toBe(0);
  });
});
