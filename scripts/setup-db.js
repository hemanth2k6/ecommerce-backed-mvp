require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const targetDB = process.env.PGDATABASE || 'ecommerce_mvp';

function makeClient(dbOverride) {
  return new Client({
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || 5432, 10),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    database: dbOverride || targetDB,
  });
}

async function ensureDatabase() {
  let admin;
  try {
    admin = makeClient('postgres');
    await admin.connect();
  } catch (e1) {
    try {
      admin = makeClient('template1');
      await admin.connect();
    } catch (e2) {
      console.error('[setup] cannot connect to postgres/template1 admin DB. User:', process.env.PGUSER, 'Host:', process.env.PGHOST, 'Port:', process.env.PGPORT);
      console.error('[setup] connect error (postgres):', e1.message);
      console.error('[setup] connect error (template1):', e2.message);
      process.exit(2);
    }
  }

  try {
    const res = await admin.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [targetDB]
    );
    if (res.rowCount === 0) {
      console.log(`[setup] creating database ${targetDB} ...`);
      await admin.query(`CREATE DATABASE "${targetDB}"`);
      console.log(`[setup] database ${targetDB} created`);
    } else {
      console.log(`[setup] database ${targetDB} already exists`);
    }
  } finally {
    await admin.end();
  }
}

async function applySchema() {
  const client = makeClient();
  await client.connect();
  const sqlPath = path.join(__dirname, '..', 'sql', 'schema.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  console.log('[setup] applying schema.sql ...');
  await client.query(sql);
  console.log('[setup] schema applied');

  const products = [
    { name: 'Wireless Headphones', sku: 'AUD-WH-001', price: 199.99, stock_qty: 50,
      description: 'Over-ear noise cancelling wireless headphones.', image_url: 'https://cdn.example.com/wh001.jpg' },
    { name: 'USB-C Cable 1m', sku: 'CAB-UC-001', price: 14.99, stock_qty: 1,
      description: 'Braided 1 meter USB-C to USB-C cable (LAST ONE IN STOCK).', image_url: 'https://cdn.example.com/uc001.jpg' },
    { name: 'Mechanical Keyboard', sku: 'KEY-MK-001', price: 129.00, stock_qty: 25,
      description: 'Tactile 75% mechanical keyboard with RGB.', image_url: 'https://cdn.example.com/mk001.jpg' },
  ];

  for (const p of products) {
    const r = await client.query(
      `INSERT INTO products (name, description, sku, price, stock_qty, image_url)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (sku) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         price = EXCLUDED.price,
         stock_qty = EXCLUDED.stock_qty,
         image_url = EXCLUDED.image_url
       RETURNING id, sku, stock_qty`,
      [p.name, p.description, p.sku, p.price, p.stock_qty, p.image_url]
    );
    console.log(`[setup] upserted product sku=${r.rows[0].sku} id=${r.rows[0].id} stock=${r.rows[0].stock_qty}`);
  }

  await client.end();
  console.log('[setup] done');
}

(async () => {
  await ensureDatabase();
  await applySchema();
})().catch(err => {
  console.error('[setup] FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
