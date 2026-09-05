# E-Commerce Backend MVP — System Design Document

- Status: Draft
- Date: 2026-09-05
- Scope: MVP (Users, Products, Orders only)

---

## 1. Overview

A minimal viable E-commerce backend supporting customer accounts, a product catalog, and order placement. Target stack: **PostgreSQL + REST API**.

### 1.1 Goals (MVP)

- Register and authenticate customers (JWT).
- Serve a browsable, searchable product catalog.
- Accept orders with multiple line items, atomically decrementing stock.
- Let customers view their own order history.

### 1.2 Non-Goals (Out of MVP Scope)

- Payment gateway integration (Stripe, PayPal — `payment_status` is a state machine only).
- Shipping/tax calculation rules (flat sum of line items for `total_amount`).
- Admin CRUD for Products (admin role reserved, endpoints not specified yet).
- Persistent server-side cart (client holds items, sends list at checkout).
- Wishlists, reviews, coupons, multi-currency, refunds workflows.

---

## 2. PostgreSQL Schema

Four tables: **Users**, **Products**, **Orders**, and **OrderItems** (join table).

Monetary columns use `NUMERIC(precision, scale)` to prevent floating-point rounding errors. All timestamps are `TIMESTAMPTZ` (timezone-aware).

### 2.1 Users Table

Registered customers. Passwords are hashed at the application layer before insert.

```sql
CREATE TABLE users (
    id              BIGSERIAL PRIMARY KEY,
    email           VARCHAR(255) UNIQUE NOT NULL,
    password_hash   VARCHAR(255) NOT NULL,
    first_name      VARCHAR(100) NOT NULL,
    last_name       VARCHAR(100) NOT NULL,
    address         TEXT NULL,
    role            VARCHAR(20)  NOT NULL DEFAULT 'customer',
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_users_email ON users (email);
```

**Column notes:**
- `role` values: `customer`, `admin`. Defaults to `customer`.
- `password_hash` stores the bcrypt output string (e.g. `$2b$12$...`). **Never store plaintext.**
- `address` is nullable; required at checkout time (stored per-order then).

---

### 2.2 Products Table

Catalog items.

```sql
CREATE TABLE products (
    id          BIGSERIAL PRIMARY KEY,
    name        VARCHAR(255) NOT NULL,
    description TEXT NULL,
    sku         VARCHAR(50) UNIQUE NOT NULL,
    price       NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
    stock_qty   INTEGER NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    image_url   VARCHAR(500) NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_products_sku   ON products (sku);
CREATE        INDEX idx_products_active ON products (is_active);
CREATE        INDEX idx_products_name   ON products (name);
```

**Column notes:**
- `sku` (Stock Keeping Unit) — unique internal identifier, separate from `id`.
- `is_active` — soft toggle for catalog visibility. Soft-deleted/archived products get `is_active = FALSE` rather than `DELETE`.
- `stock_qty` — available inventory; decremented atomically on successful order placement.

---

### 2.3 Orders Table

Header record for a purchase.

```sql
CREATE TABLE orders (
    id                BIGSERIAL PRIMARY KEY,
    user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    order_number      VARCHAR(32) UNIQUE NOT NULL,
    status            VARCHAR(20) NOT NULL DEFAULT 'pending',
    total_amount      NUMERIC(12, 2) NOT NULL CHECK (total_amount >= 0),
    shipping_address  TEXT NOT NULL,
    billing_address   TEXT NOT NULL,
    payment_status    VARCHAR(20) NOT NULL DEFAULT 'unpaid',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_orders_order_number ON orders (order_number);
CREATE        INDEX idx_orders_user_id      ON orders (user_id);
CREATE        INDEX idx_orders_status       ON orders (status);
CREATE        INDEX idx_orders_created_at   ON orders (created_at);
```

**State machines:**
- `status`: `pending` → `confirmed` → `shipped` → `delivered`
  - Alternative terminal state: `cancelled` (can be set from `pending` / `confirmed`)
- `payment_status`: `unpaid` → `paid` | `failed` → (optionally) `refunded`

**Column notes:**
- `order_number` — human-friendly reference shown to user. Recommended format: `ORD-YYYYMMDD-<zero-padded-id>` or a UUID7-style short string. Must be unique.
- `shipping_address` / `billing_address` — **snapshots** stored as text. We do NOT reference `users.address` because a user's default address may change later.
- `ON DELETE RESTRICT` on `user_id` — prevent deletion of users who have placed orders (preserves audit trail).

---

### 2.4 OrderItems Table (Join Table)

Each line in an order.

```sql
CREATE TABLE order_items (
    id            BIGSERIAL PRIMARY KEY,
    order_id      BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id    BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    product_name  VARCHAR(255) NOT NULL,
    unit_price    NUMERIC(10, 2) NOT NULL CHECK (unit_price >= 0),
    quantity      INTEGER NOT NULL CHECK (quantity > 0),
    line_total    NUMERIC(12, 2) NOT NULL CHECK (line_total >= 0)
);

CREATE INDEX idx_order_items_order_id   ON order_items (order_id);
CREATE INDEX idx_order_items_product_id ON order_items (product_id);
```

**Why the snapshot columns (`product_name`, `unit_price`, `line_total`)?**
If the product is renamed or repriced next month, historical invoices and receipts must reflect the exact values the customer agreed to pay at checkout. The `product_id` FK remains for audit/analytics.

**Denormalization of `line_total`:**
`line_total` should always equal `unit_price * quantity`. It is stored redundantly so that order-level `SUM(line_total)` queries do not have to recalculate, and as a guard against logic bugs (application can assert the invariant).

---

### 2.5 Entity Relationship (ER) Diagram

```
┌────────────┐       ┌─────────────┐       ┌───────────────┐       ┌────────────┐
│   Users    │1    ∞│   Orders    │1    ∞│  OrderItems   │∞    1│  Products  │
├────────────┤       ├─────────────┤       ├───────────────┤       ├────────────┤
│ PK id      │───────│ PK id       │───────│ PK id         │───────│ PK id      │
│ UQ email   │       │ FK user_id  │       │ FK order_id   │       │ UQ sku     │
│ password   │       │ UQ order#   │       │ FK product_id │       │ price      │
│ first/last │       │ status      │       │ product_name  │       │ stock_qty  │
│ address    │       │ total_amount│       │ unit_price    │       │ is_active  │
│ role       │       │ ship/bill   │       │ quantity      │       │ ...        │
│ ts         │       │ pay_status  │       │ line_total    │       │ ts         │
└────────────┘       │ ts          │       └───────────────┘       └────────────┘
                     └─────────────┘
```

Cardinality:
- `Users` 1 — ∞ `Orders` (a user has zero or more orders)
- `Orders` 1 — ∞ `OrderItems` (an order has at least one line)
- `Products` 1 — ∞ `OrderItems` (a product can appear in many order lines over time)

---

## 3. Data Integrity & Transactional Guarantees

### 3.1 Order Placement (critical transaction)

The **Place Order** endpoint MUST run the following inside a **single SQL transaction**:

```
BEGIN;

  -- 1. For each item, SELECT ... FOR UPDATE (row lock) and validate stock:
  SELECT id, price, name, stock_qty FROM products
  WHERE id = $1 AND is_active = TRUE
  FOR UPDATE;

  -- If stock_qty < requested quantity → ROLLBACK, return 409.

  -- 2. Decrement stock atomically:
  UPDATE products SET stock_qty = stock_qty - $qty WHERE id = $1;

  -- 3. INSERT orders row (compute total_amount).
  -- 4. INSERT order_items rows (with snapshot name/price/line_total).

COMMIT;
```

**Why `SELECT ... FOR UPDATE`?** Prevents the classic race where two concurrent orders both read stock_qty = 1 and both try to buy the same last unit. The row-lock serializes access.

**Why `ON DELETE CASCADE` only on `order_items → orders`?** Deleting an order (rare, e.g. admin cleanup) should also delete its lines. Deleting a product or user should never silently destroy order history — hence `RESTRICT`.

### 3.2 `updated_at` maintenance

Every table has an `updated_at` column. Keep it current either via:
- Application-level code (always include `updated_at = NOW()` in UPDATEs), or
- A PostgreSQL trigger, e.g.:
  ```sql
  CREATE OR REPLACE FUNCTION trigger_set_timestamp()
  RETURNS TRIGGER AS $$
  BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
  $$ LANGUAGE plpgsql;

  CREATE TRIGGER set_timestamp BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();
  -- repeat for products, orders
  ```

---

## 4. Core API Endpoints (5)

Base URL prefix: `/api/v1`
Auth scheme: `Authorization: Bearer <jwt>` on protected routes. 🔒 denotes required.

### 4.1 User Signup / Registration

| Method | Path            | Auth | Description                          |
|--------|-----------------|------|--------------------------------------|
| POST   | `/auth/register`| ❌   | Create a new customer account        |

**Request:**
```json
{
  "email": "alice@example.com",
  "password": "StrongPass123!",
  "first_name": "Alice",
  "last_name": "Smith",
  "address": "123 Main St, NY 10001"
}
```

**Response `201 Created`:**
```json
{
  "id": 42,
  "email": "alice@example.com",
  "first_name": "Alice",
  "last_name": "Smith",
  "created_at": "2026-09-05T10:30:00Z"
}
```

**Error responses:**
- `400 Bad Request` — missing required field, email format invalid, password too short/weak.
- `409 Conflict` — a user with that email already exists.

**Application logic:**
- Validate inputs server-side (never trust client).
- Hash password with bcrypt (cost factor ≥ 12). Do NOT return `password_hash` in any response.

---

### 4.2 User Login (Issue JWT)

| Method | Path         | Auth | Description                              |
|--------|--------------|------|------------------------------------------|
| POST   | `/auth/login`| ❌   | Validate credentials, return JWT token   |

**Request:**
```json
{
  "email": "alice@example.com",
  "password": "StrongPass123!"
}
```

**Response `200 OK`:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOjQyLCJlbWFpbCI6ImFsaWNlQGV4YW1wbGUuY29tIiwicm9sZSI6ImN1c3RvbWVyIiwiZXhwIjoxNzI1NTM3ODAwfQ.signature",
  "expires_in": 86400,
  "user": {
    "id": 42,
    "email": "alice@example.com",
    "role": "customer"
  }
}
```

**JWT claims (recommended):**
- `sub` = `users.id`
- `email`
- `role`
- `iat` (issued-at) and `exp` (expiration, e.g. 24h = 86400s from issuance)

**Error responses:**
- `401 Unauthorized` — no such user OR password mismatch. Do NOT leak which one (security). Return generic message: `"Invalid email or password"`.
- `400 Bad Request` — missing email/password fields.

---

### 4.3 List Products (Catalog)

| Method | Path        | Auth | Description                                          |
|--------|-------------|------|------------------------------------------------------|
| GET    | `/products` | ❌   | Paginated, filterable, searchable catalog of active products |

**Query parameters:**
| Name       | Type    | Default | Notes                                               |
|------------|---------|---------|-----------------------------------------------------|
| `page`     | integer | 1       | 1-based page number                                 |
| `per_page` | integer | 20      | Min: 1, Max: 100                                    |
| `search`   | string  | (none)  | Case-insensitive substring match on `name`          |
| `min_price`| numeric | (none)  | Inclusive lower bound on `price`                    |
| `max_price`| numeric | (none)  | Inclusive upper bound on `price`                    |
| `sort`     | string  | `newest`| One of: `price_asc`, `price_desc`, `newest`         |

**Response `200 OK`:**
```json
{
  "page": 1,
  "per_page": 20,
  "total": 156,
  "total_pages": 8,
  "items": [
    {
      "id": 7,
      "name": "Wireless Headphones",
      "description": "Noise-cancelling over-ear...",
      "sku": "WH-001",
      "price": "199.99",
      "stock_qty": 42,
      "image_url": "https://cdn.example.com/wh001.jpg"
    }
  ]
}
```

**Notes:**
- Always filter by `is_active = TRUE` — do not expose archived products.
- Monetary values should serialize as **strings** (JSON `"199.99"`), not JS floats, to prevent IEEE-754 drift when client parses them.

**Error responses:**
- `400 Bad Request` — `page` < 1, `per_page` outside range, `min_price > max_price`, unknown `sort`.

---

### 4.4 Place a New Order 🔒

| Method | Path     | Auth | Description                                           |
|--------|----------|------|-------------------------------------------------------|
| POST   | `/orders`| 🔒   | Create an order from items + addresses; deduct stock. |

**JWT requirement:** `sub` claim used as `user_id`.

**Request:**
```json
{
  "items": [
    { "product_id": 7, "quantity": 1 },
    { "product_id": 3, "quantity": 2 }
  ],
  "shipping_address": "123 Main St, New York, NY 10001",
  "billing_address":  "123 Main St, New York, NY 10001"
}
```

**Server-side flow (inside 1 transaction, per §3.1):**
1. Validate:
   - `items` is non-empty.
   - All `quantity` > 0.
   - Both address fields present & non-empty.
2. For each item:
   - Load product row with `FOR UPDATE` (lock).
   - Ensure product `is_active = TRUE`. If not → 404.
   - Ensure `stock_qty >= quantity`. If not → 409 with `{ product_id, requested, available }`.
   - Capture `name`, `price` snapshot.
   - Compute `line_total = price * quantity`.
3. Sum all `line_total` → `total_amount`.
4. `UPDATE products SET stock_qty = stock_qty - qty WHERE id = $1` for each.
5. Generate unique `order_number`.
6. `INSERT INTO orders (user_id, order_number, status, total_amount, shipping_address, billing_address, payment_status) VALUES ...` with `status = 'pending'`, `payment_status = 'unpaid'`.
7. `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, line_total) VALUES ...` for each line.
8. Commit.

**Response `201 Created`:**
```json
{
  "id": 1001,
  "order_number": "ORD-20260905-001001",
  "status": "pending",
  "total_amount": "299.97",
  "payment_status": "unpaid",
  "shipping_address": "123 Main St, New York, NY 10001",
  "billing_address":  "123 Main St, New York, NY 10001",
  "created_at": "2026-09-05T11:00:00Z",
  "items": [
    { "product_id": 7, "product_name": "Wireless Headphones",
      "unit_price": "199.99", "quantity": 1, "line_total": "199.99" },
    { "product_id": 3, "product_name": "USB-C Cable 1m",
      "unit_price": "49.99",  "quantity": 2, "line_total": "99.98"  }
  ]
}
```

**Error responses:**
- `401 Unauthorized` — JWT missing, expired, or invalid signature.
- `400 Bad Request` — empty items, non-positive quantity, missing address, unknown product_id format.
- `404 Not Found` — one or more `product_id`s do not exist OR `is_active = FALSE`.
- `409 Conflict` — insufficient stock for one or more products. Example body:
  ```json
  { "error": "insufficient_stock",
    "items": [ { "product_id": 7, "requested": 5, "available": 2 } ] }
  ```

---

### 4.5 Get My Orders (Order History) 🔒

| Method | Path        | Auth | Description                                         |
|--------|-------------|------|-----------------------------------------------------|
| GET    | `/orders/me`| 🔒   | Paginated list of orders for the authenticated user |

**Query parameters:**
| Name       | Type    | Default | Notes                                              |
|------------|---------|---------|----------------------------------------------------|
| `page`     | integer | 1       | 1-based                                            |
| `per_page` | integer | 10      | Min: 1, Max: 50                                    |
| `status`   | string  | (all)   | Filter by `status`: `pending / confirmed / shipped / delivered / cancelled` |

**Critical security:** The DB query **must** include `WHERE orders.user_id = $1` with `$1` bound from the JWT `sub` claim. Never accept `user_id` from the URL or body for this endpoint — classic IDOR vector.

**Response `200 OK`:**
```json
{
  "page": 1,
  "per_page": 10,
  "total": 7,
  "total_pages": 1,
  "orders": [
    {
      "id": 1001,
      "order_number": "ORD-20260905-001001",
      "status": "pending",
      "payment_status": "unpaid",
      "total_amount": "299.97",
      "shipping_address": "123 Main St, New York, NY 10001",
      "item_count": 2,
      "created_at": "2026-09-05T11:00:00Z"
    }
  ]
}
```

**Optional companion endpoint** (recommended, same auth rules):

| Method | Path           | Auth | Description                                         |
|--------|----------------|------|-----------------------------------------------------|
| GET    | `/orders/:id`  | 🔒   | Single order detail with full `order_items`. Access allowed only if `orders.user_id == jwt.sub` OR caller has `role = admin`. |

**Error responses:**
- `401 Unauthorized` — missing/invalid JWT.
- `400 Bad Request` — invalid pagination / unknown status value.
- `404 Not Found` — for `/orders/:id`: order does not exist OR user is not its owner (and not admin). Return 404 in both cases (do not leak "exists but not yours").

---

## 5. Authentication & Authorization Details

### 5.1 Passwords

- **Hashing:** `bcrypt` with cost factor ≥ 12.
- **Storage:** Write only the resulting hash string into `users.password_hash`.
- **Verification:** On login, use `bcrypt.compare(plaintext, stored_hash)` — constant-time comparison. Never implement your own compare.
- **Exposure:** `password_hash` (or password) MUST NEVER appear in any API response, log message, or exception detail.

### 5.2 JWT

| Setting       | Recommendation                                                 |
|---------------|----------------------------------------------------------------|
| Algorithm     | `HS256` (HMAC-SHA256) — symmetric; for MVP simplicity.        |
| Secret        | Long random value from env. ≥ 32 bytes. Never commit to VCS.   |
| Expiry        | `24 h` for access tokens (MVP). Add refresh tokens later if needed. |
| Claims        | `sub` = `users.id`, `email`, `role`, `iat`, `exp`              |
| Verification  | Always check signature, `exp`, and that algorithm header is what you expect (prevent "alg:none" attacks via your JWT library's strict mode). |

### 5.3 Access Control Matrix

| Endpoint          | customer | admin | anonymous |
|-------------------|----------|-------|-----------|
| POST /auth/register |  ✅*    |  ✅*   |  ✅       | (* creation, identity not yet required)
| POST /auth/login    |  ✅*    |  ✅*   |  ✅       | (* anyone may attempt; role in DB determines claims)
| GET  /products      |  ✅     |  ✅    |  ✅       |
| POST /orders        |  ✅     |  ✅    |  ❌       |
| GET  /orders/me     |  ✅ (own orders) | ✅ |  ❌      |
| GET  /orders/:id    |  ✅ (own only)     | ✅ (all) | ❌ |

**IDOR check pattern** (for endpoints with an entity ID in path):
```
entity = db_query_with_id(...)
if entity is None: return 404
if jwt.role != 'admin' and entity.user_id != jwt.sub: return 404
```
Returning 404 for both "not found" and "forbidden" prevents enumeration attacks.

---

## 6. Open Questions / Follow-ups (Non-blocking for MVP)

1. **Tax & shipping logic** — `total_amount` is currently just the sum of `line_total`. Do we need a flat shipping fee, or per-region/weight rules?
2. **Payment provider integration** — Stripe? PayPal? Braintree? The `payment_status` state machine is in place; the gateway webhook handler and PCI-compliant flow are not. This is typically the next endpoint batch after the MVP 5.
3. **Persistent server-side cart** — MVP assumes the client holds the cart as items in memory/localStorage and posts them to `POST /orders`. For multi-device cart sync, add a `carts` + `cart_items` table.
4. **Admin CRUD for Products** — `POST/PUT/DELETE /products` endpoints, gated on `role = admin`. Not required for MVP (seed DB directly).
5. **Soft-delete pattern** — Currently `products.is_active` exists. Consider adding `deleted_at TIMESTAMPTZ NULL` to `users` and `products`, and use application-level scopes (`WHERE deleted_at IS NULL`) instead of `DELETE`.
6. **Concurrency on hot items** — `SELECT ... FOR UPDATE` is the baseline. For flash-sales with huge spike traffic, evaluate: `stock_qty = stock_qty - q` with `stock_qty >= q` as `WHERE` predicate (single round-trip), or optimistic locking with a version column.
7. **Observability** — Structured logging, request IDs, basic metrics (orders per hour, out-of-stock rate, avg. basket size). MVP can skip, but worth reserving fields/shape early.
