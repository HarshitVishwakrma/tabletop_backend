const pool = require("./db");

// ==========================================
// DATABASE INITIALIZATION (SCHEMA DDL)
// ==========================================
// Runs on backend start. Everything is idempotent (IF NOT EXISTS /
// CREATE OR REPLACE), so restarting the server is safe.
//
// NOTE: IF NOT EXISTS cannot upgrade tables that already exist with the OLD
// structure. If your dev DB still has the old tables, start the backend once
// with DB_RESET=true (dev only, it DROPS ALL DATA), then remove the variable:
//
//   DB_RESET=true node index.js
//
// For production, switch to a proper migration tool (Prisma Migrate,
// node-pg-migrate, Knex) once you have real tenants.

const RESET_SQL = `
  DROP VIEW IF EXISTS branch_menu;
  DROP TABLE IF EXISTS
    payments, bills, order_items, orders, table_sessions,
    branch_ingredient_stock, branch_menu_items, item_ingredients,
    item_variants, ingredients, menu_items, categories, tables,
    user_branches, branch_requests, users, branches,
    subscriptions, accounts, plans
  CASCADE;
`;

const SCHEMA_SQL = `
  -- ---------------------------------------------------------------------
  -- Shared helper: auto-maintain updated_at
  -- ---------------------------------------------------------------------
  CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
  BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  -- ---------------------------------------------------------------------
  -- 1. PLANS & TENANTS
  -- ---------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS plans (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(100) NOT NULL UNIQUE,
    price           DECIMAL(10,2) NOT NULL,
    billing_period  VARCHAR(20) NOT NULL DEFAULT 'monthly'
                    CHECK (billing_period IN ('monthly', 'quarterly', 'yearly')),
    max_branches    INTEGER NOT NULL DEFAULT 1,
    max_tables      INTEGER,
    features        JSONB NOT NULL DEFAULT '{}',
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS accounts (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    subdomain       VARCHAR(63) UNIQUE NOT NULL
                    CHECK (subdomain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'),
    custom_domain   VARCHAR(255) UNIQUE,
    gst_number      VARCHAR(50),
    logo_url        TEXT,
    theme_color     VARCHAR(20),
    status          VARCHAR(20) NOT NULL DEFAULT 'trial'
                    CHECK (status IN ('trial', 'active', 'past_due', 'suspended', 'closed')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    id                        SERIAL PRIMARY KEY,
    account_id                INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    plan_id                   INTEGER NOT NULL REFERENCES plans(id),
    status                    VARCHAR(20) NOT NULL DEFAULT 'trialing'
                              CHECK (status IN ('trialing', 'active', 'past_due', 'cancelled', 'expired')),
    current_period_start      TIMESTAMPTZ NOT NULL,
    current_period_end        TIMESTAMPTZ NOT NULL,
    cancel_at_period_end      BOOLEAN NOT NULL DEFAULT FALSE,
    gateway_subscription_id   VARCHAR(255),
    created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_live_subscription_per_account
    ON subscriptions(account_id) WHERE status IN ('trialing', 'active', 'past_due');

  -- ---------------------------------------------------------------------
  -- 2. BRANCHES, USERS, STAFF ACCESS
  -- ---------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS branches (
    id          SERIAL PRIMARY KEY,
    account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name        VARCHAR(255) NOT NULL,
    address     TEXT,
    phone       VARCHAR(30),
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_branches_account ON branches(account_id);

  CREATE TABLE IF NOT EXISTS users (
    id             SERIAL PRIMARY KEY,
    account_id     INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name           VARCHAR(255) NOT NULL,
    email          VARCHAR(255) UNIQUE NOT NULL,
    password_hash  VARCHAR(255) NOT NULL,
    role           VARCHAR(20) NOT NULL DEFAULT 'owner'
                   CHECK (role IN ('owner', 'manager', 'waiter', 'kitchen')),
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_users_account ON users(account_id);

  -- Business asks for a new branch; platform admin approves
  CREATE TABLE IF NOT EXISTS branch_requests (
    id            SERIAL PRIMARY KEY,
    account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    branch_name   VARCHAR(255) NOT NULL,
    address       TEXT,
    status        VARCHAR(20) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'rejected')),
    requested_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reviewed_by   VARCHAR(255),
    review_note   TEXT,
    requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_at   TIMESTAMPTZ
  );

  -- Which branches a manager/waiter/kitchen user may access (owners see all)
  CREATE TABLE IF NOT EXISTS user_branches (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    branch_id  INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, branch_id)
  );

  -- ---------------------------------------------------------------------
  -- 3. TABLES (QR) & SESSIONS
  -- ---------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS tables (
    id            SERIAL PRIMARY KEY,
    account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    branch_id     INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    table_number  VARCHAR(50) NOT NULL,
    qr_token      UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (branch_id, table_number)
  );
  CREATE INDEX IF NOT EXISTS idx_tables_account ON tables(account_id);

  CREATE TABLE IF NOT EXISTS table_sessions (
    id                SERIAL PRIMARY KEY,
    account_id        INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    branch_id         INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    table_id          INTEGER NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
    session_token     UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    status            VARCHAR(20) NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'payment_pending', 'closed')),
    started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_activity_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at          TIMESTAMPTZ,
    ended_by          VARCHAR(20) CHECK (ended_by IN ('customer', 'staff', 'system'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_open_session_per_table
    ON table_sessions(table_id) WHERE status <> 'closed';
  CREATE INDEX IF NOT EXISTS idx_sessions_branch_status ON table_sessions(branch_id, status);

  -- ---------------------------------------------------------------------
  -- 4. MENU CATALOG (account-level) + BRANCH CONTROLS
  -- ---------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS categories (
    id          SERIAL PRIMARY KEY,
    account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name        VARCHAR(255) NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (account_id, name)
  );

  CREATE TABLE IF NOT EXISTS menu_items (
    id            SERIAL PRIMARY KEY,
    account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    category_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    name          VARCHAR(255) NOT NULL,
    description   TEXT,
    price         DECIMAL(10,2) NOT NULL CHECK (price >= 0),
    gst_rate      DECIMAL(5,2) NOT NULL DEFAULT 5.00,
    is_veg        BOOLEAN,
    image_url     TEXT,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    is_available  BOOLEAN NOT NULL DEFAULT TRUE,
    deleted_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_menu_items_account ON menu_items(account_id) WHERE deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_menu_items_category ON menu_items(category_id);

  CREATE TABLE IF NOT EXISTS item_variants (
    id            SERIAL PRIMARY KEY,
    menu_item_id  INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
    name          VARCHAR(100) NOT NULL,
    price         DECIMAL(10,2) NOT NULL CHECK (price >= 0),
    is_available  BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE (menu_item_id, name)
  );

  CREATE TABLE IF NOT EXISTS ingredients (
    id          SERIAL PRIMARY KEY,
    account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name        VARCHAR(255) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (account_id, name)
  );

  CREATE TABLE IF NOT EXISTS item_ingredients (
    menu_item_id   INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
    ingredient_id  INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
    PRIMARY KEY (menu_item_id, ingredient_id)
  );

  CREATE TABLE IF NOT EXISTS branch_menu_items (
    branch_id       INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    menu_item_id    INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
    is_available    BOOLEAN NOT NULL DEFAULT TRUE,
    price_override  DECIMAL(10,2) CHECK (price_override >= 0),
    PRIMARY KEY (branch_id, menu_item_id)
  );

  -- Missing row = in stock
  CREATE TABLE IF NOT EXISTS branch_ingredient_stock (
    branch_id      INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    ingredient_id  INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
    is_in_stock    BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (branch_id, ingredient_id)
  );

  -- Effective menu per branch: availability is DERIVED, never stored.
  -- Every non-deleted catalog item of the account appears for every branch.
  -- A missing branch_menu_items row means "available at this branch".
  CREATE OR REPLACE VIEW branch_menu AS
  SELECT
    b.id AS branch_id,
    mi.id AS menu_item_id,
    mi.account_id,
    mi.category_id,
    mi.name,
    mi.description,
    mi.image_url,
    mi.is_veg,
    mi.gst_rate,
    mi.sort_order,
    COALESCE(bmi.price_override, mi.price) AS price,
    (
      mi.is_available
      AND COALESCE(bmi.is_available, TRUE)
      AND NOT EXISTS (
        SELECT 1
        FROM item_ingredients ii
        JOIN branch_ingredient_stock s
          ON s.ingredient_id = ii.ingredient_id
         AND s.branch_id = b.id
        WHERE ii.menu_item_id = mi.id
          AND s.is_in_stock = FALSE
      )
    ) AS is_orderable
  FROM branches b
  JOIN menu_items mi
    ON mi.account_id = b.account_id
   AND mi.deleted_at IS NULL
  LEFT JOIN branch_menu_items bmi
    ON bmi.branch_id = b.id
   AND bmi.menu_item_id = mi.id;

  -- ---------------------------------------------------------------------
  -- 5. ORDERS (kitchen tickets), belong to a SESSION
  -- ---------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS orders (
    id                SERIAL PRIMARY KEY,
    account_id        INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    branch_id         INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    session_id        INTEGER NOT NULL REFERENCES table_sessions(id) ON DELETE RESTRICT,
    table_id          INTEGER REFERENCES tables(id) ON DELETE SET NULL,
    status            VARCHAR(20) NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'accepted', 'preparing', 'ready', 'served', 'cancelled')),
    customer_note     TEXT,
    placed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    accepted_at       TIMESTAMPTZ,
    ready_at          TIMESTAMPTZ,
    served_at         TIMESTAMPTZ,
    cancelled_at      TIMESTAMPTZ,
    cancelled_by      VARCHAR(20) CHECK (cancelled_by IN ('customer', 'staff', 'system')),
    cancelled_reason  TEXT,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_orders_session ON orders(session_id);
  CREATE INDEX IF NOT EXISTS idx_orders_branch_status ON orders(branch_id, status);
  CREATE INDEX IF NOT EXISTS idx_orders_account_placed ON orders(account_id, placed_at);

  CREATE TABLE IF NOT EXISTS order_items (
    id            SERIAL PRIMARY KEY,
    order_id      INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    menu_item_id  INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE RESTRICT,
    variant_id    INTEGER REFERENCES item_variants(id) ON DELETE SET NULL,
    item_name     VARCHAR(255) NOT NULL,
    variant_name  VARCHAR(100),
    price         DECIMAL(10,2) NOT NULL CHECK (price >= 0),
    gst_rate      DECIMAL(5,2) NOT NULL DEFAULT 5.00,
    quantity      INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
    notes         TEXT,
    status        VARCHAR(20) NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'cancelled', 'unavailable'))
  );
  CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
  CREATE INDEX IF NOT EXISTS idx_order_items_menu_item ON order_items(menu_item_id);

  -- ---------------------------------------------------------------------
  -- 6. BILLS & PAYMENTS, one bill per session
  -- ---------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS bills (
    id              SERIAL PRIMARY KEY,
    account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    branch_id       INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    session_id      INTEGER NOT NULL UNIQUE REFERENCES table_sessions(id) ON DELETE RESTRICT,
    financial_year  VARCHAR(9),
    bill_number     INTEGER,
    subtotal        DECIMAL(10,2) NOT NULL,
    discount        DECIMAL(10,2) NOT NULL DEFAULT 0,
    service_charge  DECIMAL(10,2) NOT NULL DEFAULT 0,
    cgst            DECIMAL(10,2) NOT NULL,
    sgst            DECIMAL(10,2) NOT NULL,
    rounding        DECIMAL(10,2) NOT NULL DEFAULT 0,
    total           DECIMAL(10,2) NOT NULL,
    payment_status  VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (payment_status IN ('pending', 'partial', 'paid', 'refunded', 'void')),
    finalized_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (branch_id, financial_year, bill_number)
  );
  CREATE INDEX IF NOT EXISTS idx_bills_branch_created ON bills(branch_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_bills_account_created ON bills(account_id, created_at);

  CREATE TABLE IF NOT EXISTS payments (
    id           SERIAL PRIMARY KEY,
    account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    bill_id      INTEGER NOT NULL REFERENCES bills(id) ON DELETE RESTRICT,
    method       VARCHAR(20) NOT NULL CHECK (method IN ('cash', 'upi', 'card', 'online', 'other')),
    amount       DECIMAL(10,2) NOT NULL CHECK (amount > 0),
    status       VARCHAR(20) NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'success', 'failed', 'refunded')),
    gateway_ref  VARCHAR(255),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_payments_bill ON payments(bill_id);

  -- ---------------------------------------------------------------------
  -- 7. updated_at triggers
  -- ---------------------------------------------------------------------
  DO $$
  DECLARE t TEXT;
  BEGIN
    FOREACH t IN ARRAY ARRAY[
      'plans', 'accounts', 'subscriptions', 'branches', 'users', 'tables',
      'categories', 'menu_items', 'orders', 'bills', 'payments'
    ]
    LOOP
      EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_updated_at ON %I', t, t);
      EXECUTE format(
        'CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON %I
         FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
    END LOOP;
  END $$;

  -- ---------------------------------------------------------------------
  -- 8. Seed a default plan (registration attaches new accounts to it).
  -- Edit limits/price or add your real plans; ON CONFLICT keeps reruns safe.
  -- ---------------------------------------------------------------------
  INSERT INTO plans (name, price, billing_period, max_branches, max_tables)
  VALUES ('Free Trial', 0, 'monthly', 1, 10)
  ON CONFLICT (name) DO NOTHING;
`;

const initDB = async () => {
  const client = await pool.connect();
  try {
    // Dev-only: wipe everything and rebuild from scratch
    if (process.env.DB_RESET === "true") {
      console.warn("DB_RESET=true: dropping all tables...");
      await client.query(RESET_SQL);
    }

    // Detect the OLD schema (accounts table exists but has no `status` column).
    // IF NOT EXISTS would silently skip it and leave a broken half-migrated DB.
    const legacy = await client.query(`
      SELECT 1
      FROM information_schema.tables t
      WHERE t.table_schema = current_schema() AND t.table_name = 'accounts'
        AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns c
          WHERE c.table_schema = current_schema()
            AND c.table_name = 'accounts' AND c.column_name = 'status'
        )
    `);
    if (legacy.rowCount > 0) {
      throw new Error(
        "Old database schema detected. Start once with DB_RESET=true " +
          "(dev only, deletes all data) to rebuild with the new schema."
      );
    }

    await client.query("BEGIN");
    await client.query(SCHEMA_SQL);
    await client.query("COMMIT");
    console.log("Database schema verified/initialized.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Database initialization failed:", error);
    throw error; // don't let the server start on a broken schema
  } finally {
    client.release();
  }
};

module.exports = initDB;