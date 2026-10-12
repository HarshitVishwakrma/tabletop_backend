const pool = require("./config/db");
const bcrypt = require("bcryptjs");

const seedDatabase = async () => {
  const client = await pool.connect();
  try {
    console.log("Starting database seeding for new schema...");
    await client.query("BEGIN");

    // ==========================================
    // 0. PLANS
    // ==========================================
    const planResult = await client.query(`
      INSERT INTO plans (name, price, billing_period, max_branches, max_tables, features)
      VALUES ('Pro Partner', 2999.00, 'monthly', 5, 50, '{"kds": true, "inventory": true}'::jsonb)
      ON CONFLICT (name) DO UPDATE SET price = EXCLUDED.price
      RETURNING id
    `);
    const planId = planResult.rows[0].id;

    // ==========================================
    // 1. PARTNER 1: SPICY TABLE
    // ==========================================
    const p1Acc = await client.query(
      "INSERT INTO accounts (name, subdomain, gst_number, status) VALUES ($1, $2, $3, 'active') RETURNING id",
      ["Spicy Table", "spicytable", "29ABCDE1234F1Z5"]
    );
    const p1Id = p1Acc.rows[0].id;

    await client.query(
      "INSERT INTO subscriptions (account_id, plan_id, status, current_period_start, current_period_end) VALUES ($1, $2, 'active', NOW(), NOW() + INTERVAL '30 days')",
      [p1Id, planId]
    );

    const p1Branch = await client.query(
      "INSERT INTO branches (account_id, name, address, phone) VALUES ($1, $2, $3, $4) RETURNING id",
      [p1Id, "Downtown Hub", "123 Food Street, Downtown", "9876543210"]
    );
    const p1BranchId = p1Branch.rows[0].id;

    const salt = await bcrypt.genSalt(10);
    const p1Pass = await bcrypt.hash("password123", salt);
    const p1User = await client.query(
      "INSERT INTO users (account_id, name, email, password_hash, role) VALUES ($1, $2, $3, $4, 'owner') RETURNING id",
      [p1Id, "Admin Spicy", "admin@spicytable.in", p1Pass]
    );
    await client.query(
      "INSERT INTO user_branches (user_id, branch_id) VALUES ($1, $2)",
      [p1User.rows[0].id, p1BranchId]
    );

    // Tables
    const p1Tables = await client.query(
      "INSERT INTO tables (account_id, branch_id, table_number) VALUES ($1, $2, 'Table 1'), ($1, $2, 'Table 2') RETURNING id, table_number, qr_token",
      [p1Id, p1BranchId]
    );
    const p1qr1 = p1Tables.rows[0].qr_token;
    const p1qr2 = p1Tables.rows[1].qr_token;

    // Categories
    const p1Cats = await client.query(
      "INSERT INTO categories (account_id, name, sort_order) VALUES ($1, 'Mains', 1), ($1, 'Drinks', 2) RETURNING id, name",
      [p1Id]
    );
    const mainsCatId = p1Cats.rows.find(c => c.name === 'Mains').id;

    // Ingredients & branch stock
    const paneer = await client.query("INSERT INTO ingredients (account_id, name) VALUES ($1, 'Paneer') RETURNING id", [p1Id]);
    const chicken = await client.query("INSERT INTO ingredients (account_id, name) VALUES ($1, 'Chicken') RETURNING id", [p1Id]);
    const spices = await client.query("INSERT INTO ingredients (account_id, name) VALUES ($1, 'Tikka Spices') RETURNING id", [p1Id]);

    await client.query(
      "INSERT INTO branch_ingredient_stock (branch_id, ingredient_id, is_in_stock) VALUES ($1, $2, TRUE), ($1, $3, TRUE), ($1, $4, TRUE)",
      [p1BranchId, paneer.rows[0].id, chicken.rows[0].id, spices.rows[0].id]
    );

    // Menu Items & branch link
    const m1 = await client.query(
      "INSERT INTO menu_items (account_id, category_id, name, description, price, is_veg, image_url) VALUES ($1, $2, $3, $4, $5, TRUE, $6) RETURNING id",
      [p1Id, mainsCatId, "Paneer Tikka", "Spicy grilled cottage cheese", 250.00, "https://res.cloudinary.com/demo/image/upload/v1612345678/paneer_tikka.jpg"]
    );
    const m2 = await client.query(
      "INSERT INTO menu_items (account_id, category_id, name, description, price, is_veg, image_url) VALUES ($1, $2, $3, $4, $5, FALSE, $6) RETURNING id",
      [p1Id, mainsCatId, "Chicken Tikka", "Spicy grilled chicken", 350.00, "https://res.cloudinary.com/demo/image/upload/v1612345678/chicken_tikka.jpg"]
    );

    await client.query(
      "INSERT INTO branch_menu_items (branch_id, menu_item_id, is_available) VALUES ($1, $2, TRUE), ($1, $3, TRUE)",
      [p1BranchId, m1.rows[0].id, m2.rows[0].id]
    );

    await client.query(
      "INSERT INTO item_ingredients (menu_item_id, ingredient_id) VALUES ($1, $2), ($1, $3), ($4, $5), ($4, $3)",
      [m1.rows[0].id, paneer.rows[0].id, spices.rows[0].id, m2.rows[0].id, chicken.rows[0].id]
    );

    // ==========================================
    // 2. PARTNER 2: CAFE MOCHA
    // ==========================================
    const p2Acc = await client.query(
      "INSERT INTO accounts (name, subdomain, gst_number, status) VALUES ($1, $2, $3, 'active') RETURNING id",
      ["Cafe Mocha", "cafemocha", "27XYZDE5678F1Z9"]
    );
    const p2Id = p2Acc.rows[0].id;

    await client.query(
      "INSERT INTO subscriptions (account_id, plan_id, status, current_period_start, current_period_end) VALUES ($1, $2, 'active', NOW(), NOW() + INTERVAL '30 days')",
      [p2Id, planId]
    );

    const p2Branch = await client.query(
      "INSERT INTO branches (account_id, name, address, phone) VALUES ($1, $2, $3, $4) RETURNING id",
      [p2Id, "Bandra West", "45 Coffee Lane, Bandra", "9123456789"]
    );
    const p2BranchId = p2Branch.rows[0].id;

    const p2Pass = await bcrypt.hash("coffee123", salt);
    const p2User = await client.query(
      "INSERT INTO users (account_id, name, email, password_hash, role) VALUES ($1, $2, $3, $4, 'owner') RETURNING id",
      [p2Id, "Mocha Manager", "admin@cafemocha.in", p2Pass]
    );
    await client.query(
      "INSERT INTO user_branches (user_id, branch_id) VALUES ($1, $2)",
      [p2User.rows[0].id, p2BranchId]
    );

    const p2Tables = await client.query(
      "INSERT INTO tables (account_id, branch_id, table_number) VALUES ($1, $2, 'Patio 1') RETURNING id, table_number, qr_token",
      [p2Id, p2BranchId]
    );
    const p2qr1 = p2Tables.rows[0].qr_token;

    const p2Cats = await client.query(
      "INSERT INTO categories (account_id, name, sort_order) VALUES ($1, 'Coffee', 1) RETURNING id, name",
      [p2Id]
    );
    const coffeeCatId = p2Cats.rows[0].id;

    const coffeeBeans = await client.query("INSERT INTO ingredients (account_id, name) VALUES ($1, 'Arabica Beans') RETURNING id", [p2Id]);
    const milk = await client.query("INSERT INTO ingredients (account_id, name) VALUES ($1, 'Oat Milk') RETURNING id", [p2Id]);

    await client.query(
      "INSERT INTO branch_ingredient_stock (branch_id, ingredient_id, is_in_stock) VALUES ($1, $2, TRUE), ($1, $3, TRUE)",
      [p2BranchId, coffeeBeans.rows[0].id, milk.rows[0].id]
    );

    const m3 = await client.query(
      "INSERT INTO menu_items (account_id, category_id, name, description, price, is_veg, image_url) VALUES ($1, $2, $3, $4, $5, TRUE, $6) RETURNING id",
      [p2Id, coffeeCatId, "Oat Latte", "Creamy oat milk latte", 180.00, "https://res.cloudinary.com/demo/image/upload/v1612345678/latte.jpg"]
    );

    await client.query(
      "INSERT INTO branch_menu_items (branch_id, menu_item_id, is_available) VALUES ($1, $2, TRUE)",
      [p2BranchId, m3.rows[0].id]
    );

    await client.query(
      "INSERT INTO item_ingredients (menu_item_id, ingredient_id) VALUES ($1, $2), ($1, $3)",
      [m3.rows[0].id, coffeeBeans.rows[0].id, milk.rows[0].id]
    );

    await client.query("COMMIT");
    console.log("Database seeded successfully with new schema!");
    console.log("\n--- TEST CREDENTIALS ---");
    console.log("Partner 1 (Spicy Table)");
    console.log("Subdomain : spicytable");
    console.log("Email     : admin@spicytable.in");
    console.log("Password  : password123");
    console.log("Branch ID : " + p1BranchId);
    console.log("Table 1 QR (UUID): " + p1qr1);
    console.log("Table 2 QR (UUID): " + p1qr2);
    
    console.log("\nPartner 2 (Cafe Mocha)");
    console.log("Subdomain : cafemocha");
    console.log("Email     : admin@cafemocha.in");
    console.log("Password  : coffee123");
    console.log("Branch ID : " + p2BranchId);
    console.log("Patio 1 QR (UUID): " + p2qr1);
    console.log("------------------------\n");
    
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Seeding failed:", error);
  } finally {
    client.release();
    process.exit(0);
  }
};

seedDatabase();
