/**
 * seedDummy.js
 * ============
 * Inserts one fully-featured restaurant ("The Grand Thali") into the DB:
 *   - 1 account + subscription
 *   - 1 branch ("Main Branch")
 *   - 1 owner + 1 manager + 1 waiter + 1 kitchen user
 *   - 10 tables (Table 1–10)
 *   - 5 menu categories with 18 items, variants, and ingredients
 *
 * Usage:
 *   node seedDummy.js
 *
 * The script is idempotent via ON CONFLICT; re-running it will skip
 * already-existing rows and print a summary at the end.
 */

require("dotenv").config();
const pool = require("./config/db");
const bcrypt = require("bcryptjs");

const seedDummy = async () => {
  const client = await pool.connect();
  try {
    console.log("🌱  Starting dummy seed for 'The Grand Thali'...\n");
    await client.query("BEGIN");

    // ------------------------------------------------------------------ //
    //  0. Plan (reuse existing Free Trial or create Pro)
    // ------------------------------------------------------------------ //
    const planRes = await client.query(`
      INSERT INTO plans (name, price, billing_period, max_branches, max_tables, features)
      VALUES ('Pro Partner', 2999.00, 'monthly', 5, 100, '{"kds":true,"inventory":true,"qr":true}'::jsonb)
      ON CONFLICT (name) DO UPDATE SET price = EXCLUDED.price
      RETURNING id
    `);
    const planId = planRes.rows[0].id;

    // ------------------------------------------------------------------ //
    //  1. Account
    // ------------------------------------------------------------------ //
    const accRes = await client.query(`
      INSERT INTO accounts (name, subdomain, gst_number, theme_color, status)
      VALUES ('The Grand Thali', 'grandthali', '27AABCT1234F1ZC', '#d97706', 'active')
      ON CONFLICT (subdomain) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `);
    const accountId = accRes.rows[0].id;

    // ------------------------------------------------------------------ //
    //  2. Subscription
    // ------------------------------------------------------------------ //
    await client.query(`
      INSERT INTO subscriptions
        (account_id, plan_id, status, current_period_start, current_period_end)
      VALUES ($1, $2, 'active', NOW(), NOW() + INTERVAL '1 year')
      ON CONFLICT DO NOTHING
    `, [accountId, planId]);

    // ------------------------------------------------------------------ //
    //  3. Branch
    // ------------------------------------------------------------------ //
    const branchRes = await client.query(`
      INSERT INTO branches (account_id, name, address, phone)
      VALUES ($1, 'Main Branch', '42, MG Road, Bengaluru, Karnataka 560001', '9880001234')
      RETURNING id
    `, [accountId]);
    const branchId = branchRes.rows[0].id;

    // ------------------------------------------------------------------ //
    //  4. Users  (owner / manager / waiter / kitchen)
    // ------------------------------------------------------------------ //
    const salt = await bcrypt.genSalt(10);

    const usersToCreate = [
      { name: "Rajan Mehta",   email: "owner@grandthali.in",   password: "owner123",   role: "owner"   },
      { name: "Priya Sharma",  email: "manager@grandthali.in", password: "mgr123",     role: "manager" },
      { name: "Arjun Verma",   email: "waiter@grandthali.in",  password: "waiter123",  role: "waiter"  },
      { name: "Kiran Patil",   email: "kitchen@grandthali.in", password: "kitchen123", role: "kitchen" },
    ];

    const createdUsers = [];
    for (const u of usersToCreate) {
      const hash = await bcrypt.hash(u.password, salt);
      const r = await client.query(`
        INSERT INTO users (account_id, name, email, password_hash, role)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
        RETURNING id, role
      `, [accountId, u.name, u.email, hash, u.role]);
      createdUsers.push({ ...r.rows[0], password: u.password, email: u.email });
    }

    // Link all users to the branch
    for (const u of createdUsers) {
      await client.query(`
        INSERT INTO user_branches (user_id, branch_id) VALUES ($1, $2)
        ON CONFLICT DO NOTHING
      `, [u.id, branchId]);
    }

    // ------------------------------------------------------------------ //
    //  5. Tables  (10 tables)
    // ------------------------------------------------------------------ //
    const tableNumbers = Array.from({ length: 10 }, (_, i) => `T${i + 1}`);
    const tableRows = [];
    for (const tn of tableNumbers) {
      const r = await client.query(`
        INSERT INTO tables (account_id, branch_id, table_number)
        VALUES ($1, $2, $3)
        ON CONFLICT (branch_id, table_number) DO UPDATE SET table_number = EXCLUDED.table_number
        RETURNING id, table_number, qr_token
      `, [accountId, branchId, tn]);
      tableRows.push(r.rows[0]);
    }

    // ------------------------------------------------------------------ //
    //  6. Categories
    // ------------------------------------------------------------------ //
    const categoryData = [
      { name: "Starters",      sort_order: 1 },
      { name: "Mains",         sort_order: 2 },
      { name: "Breads",        sort_order: 3 },
      { name: "Desserts",      sort_order: 4 },
      { name: "Beverages",     sort_order: 5 },
    ];

    const catMap = {};
    for (const c of categoryData) {
      const r = await client.query(`
        INSERT INTO categories (account_id, name, sort_order)
        VALUES ($1, $2, $3)
        ON CONFLICT (account_id, name) DO UPDATE SET sort_order = EXCLUDED.sort_order
        RETURNING id, name
      `, [accountId, c.name, c.sort_order]);
      catMap[c.name] = r.rows[0].id;
    }

    // ------------------------------------------------------------------ //
    //  7. Ingredients
    // ------------------------------------------------------------------ //
    const ingredientNames = [
      "Paneer", "Chicken", "Mutton", "Dal (Lentils)", "Basmati Rice",
      "Cream", "Ghee", "Onion", "Tomato", "Ginger-Garlic Paste",
      "Spice Mix", "Atta (Wheat Flour)", "Maida (Refined Flour)",
      "Sugar", "Milk", "Saffron", "Cashews", "Cardamom",
    ];

    const ingMap = {};
    for (const name of ingredientNames) {
      const r = await client.query(`
        INSERT INTO ingredients (account_id, name)
        VALUES ($1, $2)
        ON CONFLICT (account_id, name) DO UPDATE SET name = EXCLUDED.name
        RETURNING id, name
      `, [accountId, name]);
      ingMap[name] = r.rows[0].id;

      // Mark all ingredients as in stock for the branch
      await client.query(`
        INSERT INTO branch_ingredient_stock (branch_id, ingredient_id, is_in_stock)
        VALUES ($1, $2, TRUE)
        ON CONFLICT DO NOTHING
      `, [branchId, r.rows[0].id]);
    }

    // ------------------------------------------------------------------ //
    //  8. Menu Items
    // ------------------------------------------------------------------ //
    // Helper: insert a menu item, link to branch, add variants, add ingredients
    const addItem = async ({ catName, name, desc, price, gstRate = 5.00, isVeg, ingredients = [], variants = [], sortOrder = 0 }) => {
      const itemRes = await client.query(`
        INSERT INTO menu_items
          (account_id, category_id, name, description, price, gst_rate, is_veg, sort_order)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id
      `, [accountId, catMap[catName], name, desc, price, gstRate, isVeg, sortOrder]);
      const itemId = itemRes.rows[0].id;

      // Link to branch (available by default)
      await client.query(`
        INSERT INTO branch_menu_items (branch_id, menu_item_id, is_available)
        VALUES ($1, $2, TRUE)
        ON CONFLICT DO NOTHING
      `, [branchId, itemId]);

      // Variants
      for (const v of variants) {
        await client.query(`
          INSERT INTO item_variants (menu_item_id, name, price)
          VALUES ($1, $2, $3)
          ON CONFLICT (menu_item_id, name) DO NOTHING
        `, [itemId, v.name, v.price]);
      }

      // Ingredients
      for (const ing of ingredients) {
        if (ingMap[ing]) {
          await client.query(`
            INSERT INTO item_ingredients (menu_item_id, ingredient_id)
            VALUES ($1, $2)
            ON CONFLICT DO NOTHING
          `, [itemId, ingMap[ing]]);
        }
      }

      return itemId;
    };

    // ── Starters ──────────────────────────────────────────────────────── //
    await addItem({
      catName: "Starters", name: "Paneer Tikka", sortOrder: 1,
      desc: "Succulent cottage cheese marinated in spiced yogurt and grilled in a tandoor.",
      price: 280, isVeg: true,
      ingredients: ["Paneer", "Spice Mix", "Cream"],
      variants: [{ name: "Half Plate", price: 160 }, { name: "Full Plate", price: 280 }],
    });

    await addItem({
      catName: "Starters", name: "Chicken Tikka", sortOrder: 2,
      desc: "Tender chicken cubes marinated overnight and flame-grilled to perfection.",
      price: 350, isVeg: false,
      ingredients: ["Chicken", "Spice Mix", "Ginger-Garlic Paste"],
      variants: [{ name: "Half Plate", price: 200 }, { name: "Full Plate", price: 350 }],
    });

    await addItem({
      catName: "Starters", name: "Veg Spring Rolls", sortOrder: 3,
      desc: "Crispy golden rolls stuffed with seasoned vegetables.",
      price: 180, isVeg: true,
      ingredients: ["Maida (Refined Flour)", "Onion"],
    });

    await addItem({
      catName: "Starters", name: "Mutton Seekh Kebab", sortOrder: 4,
      desc: "Minced mutton mixed with aromatic herbs and grilled on skewers.",
      price: 420, isVeg: false,
      ingredients: ["Mutton", "Spice Mix", "Ginger-Garlic Paste"],
    });

    // ── Mains ─────────────────────────────────────────────────────────── //
    await addItem({
      catName: "Mains", name: "Paneer Butter Masala", sortOrder: 1,
      desc: "Creamy tomato-based curry with golden-fried paneer cubes.",
      price: 320, isVeg: true,
      ingredients: ["Paneer", "Tomato", "Cream", "Ghee", "Onion"],
    });

    await addItem({
      catName: "Mains", name: "Dal Makhani", sortOrder: 2,
      desc: "Slow-cooked black lentils simmered overnight with butter and cream.",
      price: 260, isVeg: true,
      ingredients: ["Dal (Lentils)", "Cream", "Ghee", "Tomato"],
    });

    await addItem({
      catName: "Mains", name: "Chicken Tikka Masala", sortOrder: 3,
      desc: "Grilled chicken in a rich, smoky tomato-cream curry sauce.",
      price: 390, isVeg: false,
      ingredients: ["Chicken", "Tomato", "Cream", "Spice Mix", "Ginger-Garlic Paste"],
    });

    await addItem({
      catName: "Mains", name: "Mutton Rogan Josh", sortOrder: 4,
      desc: "A Kashmiri classic — slow-braised mutton in a bold aromatic gravy.",
      price: 490, gstRate: 12.00, isVeg: false,
      ingredients: ["Mutton", "Spice Mix", "Onion", "Ginger-Garlic Paste"],
    });

    await addItem({
      catName: "Mains", name: "Veg Biryani", sortOrder: 5,
      desc: "Fragrant basmati rice layered with spiced vegetables and fried onions.",
      price: 280, isVeg: true,
      ingredients: ["Basmati Rice", "Spice Mix", "Ghee", "Onion"],
      variants: [{ name: "Regular", price: 280 }, { name: "Large", price: 420 }],
    });

    await addItem({
      catName: "Mains", name: "Chicken Biryani", sortOrder: 6,
      desc: "Dum-cooked chicken biryani with whole spices and saffron-infused rice.",
      price: 350, gstRate: 12.00, isVeg: false,
      ingredients: ["Basmati Rice", "Chicken", "Spice Mix", "Ghee", "Saffron"],
      variants: [{ name: "Regular", price: 350 }, { name: "Large", price: 500 }],
    });

    // ── Breads ────────────────────────────────────────────────────────── //
    await addItem({
      catName: "Breads", name: "Butter Naan", sortOrder: 1,
      desc: "Soft leavened flatbread baked in a tandoor and brushed with butter.",
      price: 55, isVeg: true,
      ingredients: ["Maida (Refined Flour)", "Ghee"],
    });

    await addItem({
      catName: "Breads", name: "Garlic Naan", sortOrder: 2,
      desc: "Tandoor-baked naan topped with minced garlic and coriander.",
      price: 70, isVeg: true,
      ingredients: ["Maida (Refined Flour)", "Ghee"],
    });

    await addItem({
      catName: "Breads", name: "Tandoori Roti", sortOrder: 3,
      desc: "Whole-wheat flatbread baked fresh in the tandoor.",
      price: 40, isVeg: true,
      ingredients: ["Atta (Wheat Flour)"],
    });

    await addItem({
      catName: "Breads", name: "Laccha Paratha", sortOrder: 4,
      desc: "Layered, flaky whole-wheat paratha cooked on a griddle with ghee.",
      price: 65, isVeg: true,
      ingredients: ["Atta (Wheat Flour)", "Ghee"],
    });

    // ── Desserts ──────────────────────────────────────────────────────── //
    await addItem({
      catName: "Desserts", name: "Gulab Jamun", sortOrder: 1,
      desc: "Soft milk-solid dumplings soaked in rose-flavoured sugar syrup.",
      price: 120, isVeg: true,
      ingredients: ["Milk", "Maida (Refined Flour)", "Sugar"],
      variants: [{ name: "2 Pieces", price: 120 }, { name: "4 Pieces", price: 220 }],
    });

    await addItem({
      catName: "Desserts", name: "Kesar Phirni", sortOrder: 2,
      desc: "Chilled rice pudding flavoured with saffron, cardamom, and pistachios.",
      price: 150, isVeg: true,
      ingredients: ["Milk", "Basmati Rice", "Sugar", "Saffron", "Cardamom"],
    });

    await addItem({
      catName: "Desserts", name: "Kaju Katli", sortOrder: 3,
      desc: "Diamond-shaped cashew fudge, a classic Indian sweet.",
      price: 200, isVeg: true,
      ingredients: ["Cashews", "Sugar"],
    });

    // ── Beverages ─────────────────────────────────────────────────────── //
    await addItem({
      catName: "Beverages", name: "Masala Chai", sortOrder: 1,
      desc: "Aromatic spiced tea brewed with ginger, cardamom, and milk.",
      price: 60, isVeg: true,
      ingredients: ["Milk", "Cardamom"],
      variants: [{ name: "Regular", price: 60 }, { name: "Large", price: 90 }],
    });

    await addItem({
      catName: "Beverages", name: "Mango Lassi", sortOrder: 2,
      desc: "Chilled yoghurt drink blended with ripe Alphonso mangoes.",
      price: 120, isVeg: true,
      ingredients: ["Milk", "Sugar"],
    });

    await addItem({
      catName: "Beverages", name: "Fresh Lime Soda", sortOrder: 3,
      desc: "Refreshing lime juice with chilled soda — sweet, salted, or mixed.",
      price: 80, isVeg: true,
    });

    // ------------------------------------------------------------------ //
    //  Done
    // ------------------------------------------------------------------ //
    await client.query("COMMIT");

    console.log("✅  Dummy data seeded successfully!\n");
    console.log("═══════════════════════════════════════════════════════════");
    console.log("  BUSINESS : The Grand Thali");
    console.log("  SUBDOMAIN: grandthali");
    console.log("  BRANCH   : Main Branch  (ID: " + branchId + ")");
    console.log("  TABLES   : " + tableRows.map(t => t.table_number).join(", "));
    console.log("───────────────────────────────────────────────────────────");
    console.log("  CREDENTIALS");
    for (const u of createdUsers) {
      console.log(`  [${u.role.padEnd(7)}] ${u.email.padEnd(28)} / ${u.password}`);
    }
    console.log("───────────────────────────────────────────────────────────");
    console.log("  QR TOKENS (sample — first 3 tables)");
    for (const t of tableRows.slice(0, 3)) {
      console.log(`  ${t.table_number}: ${t.qr_token}`);
    }
    console.log("═══════════════════════════════════════════════════════════\n");

  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("❌  Seeding failed:", err.message);
    console.error(err);
    process.exit(1);
  } finally {
    client.release();
    process.exit(0);
  }
};

seedDummy();

