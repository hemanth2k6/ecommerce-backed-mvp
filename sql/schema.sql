CREATE TABLE IF NOT EXISTS users (
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (email);

CREATE TABLE IF NOT EXISTS products (
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_sku    ON products (sku);
CREATE        INDEX IF NOT EXISTS idx_products_active ON products (is_active);
CREATE        INDEX IF NOT EXISTS idx_products_name   ON products (name);

CREATE TABLE IF NOT EXISTS orders (
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_order_number ON orders (order_number);
CREATE        INDEX IF NOT EXISTS idx_orders_user_id      ON orders (user_id);
CREATE        INDEX IF NOT EXISTS idx_orders_status       ON orders (status);
CREATE        INDEX IF NOT EXISTS idx_orders_created_at   ON orders (created_at);

CREATE TABLE IF NOT EXISTS order_items (
    id            BIGSERIAL PRIMARY KEY,
    order_id      BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id    BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    product_name  VARCHAR(255) NOT NULL,
    unit_price    NUMERIC(10, 2) NOT NULL CHECK (unit_price >= 0),
    quantity      INTEGER NOT NULL CHECK (quantity > 0),
    line_total    NUMERIC(12, 2) NOT NULL CHECK (line_total >= 0)
);

CREATE INDEX IF NOT EXISTS idx_order_items_order_id   ON order_items (order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product_id ON order_items (product_id);

CREATE OR REPLACE FUNCTION trigger_set_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_timestamp_users ON users;
CREATE TRIGGER set_timestamp_users
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();

DROP TRIGGER IF EXISTS set_timestamp_products ON products;
CREATE TRIGGER set_timestamp_products
BEFORE UPDATE ON products
FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();

DROP TRIGGER IF EXISTS set_timestamp_orders ON orders;
CREATE TRIGGER set_timestamp_orders
BEFORE UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();

INSERT INTO users (email, password_hash, first_name, last_name, address)
VALUES (
    'demo@example.com',
    '$2b$12$placeholderplaceholders0000000000000000000000000000',
    'Demo',
    'User',
    '1 Demo St, Testville, TS 00000'
)
ON CONFLICT (email) DO NOTHING;
