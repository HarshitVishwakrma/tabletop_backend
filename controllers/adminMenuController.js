const pool = require("../config/db");

// 1. Create a new ingredient for an account and mark branch stock
const createIngredient = async (req, res, next) => {
  try {
    const { branch_id, account_id } = req.staff;
    const { name, is_in_stock } = req.body;

    if (!name) return res.status(400).json({ error: "Ingredient name is required" });

    // Insert or fetch existing ingredient for this account
    const ingResult = await pool.query(
      `INSERT INTO ingredients (account_id, name) 
       VALUES ($1, $2) 
       ON CONFLICT (account_id, name) DO UPDATE SET name = EXCLUDED.name 
       RETURNING id, name`,
      [account_id, name.trim()]
    );
    const ingredient = ingResult.rows[0];

    // Set branch-specific stock
    const stockIn = is_in_stock !== undefined ? is_in_stock : true;
    await pool.query(
      `INSERT INTO branch_ingredient_stock (branch_id, ingredient_id, is_in_stock, updated_at) 
       VALUES ($1, $2, $3, NOW()) 
       ON CONFLICT (branch_id, ingredient_id) 
       DO UPDATE SET is_in_stock = EXCLUDED.is_in_stock, updated_at = NOW()`,
      [branch_id, ingredient.id, stockIn]
    );

    res.status(201).json({
      message: "Ingredient created",
      ingredient: {
        id: ingredient.id,
        name: ingredient.name,
        is_in_stock: stockIn
      }
    });
  } catch (error) {
    next(error);
  }
};

// 2. Create a new menu item (with image upload)
const createMenuItem = async (req, res, next) => {
  try {
    const { branch_id, account_id } = req.staff;
    const { name, description, price, is_available, category, is_veg } = req.body;

    if (!name || price === undefined) {
      return res.status(400).json({ error: "Name and price are required" });
    }

    // Optional category lookup or creation
    let categoryId = null;
    if (category && category.trim()) {
      const catResult = await pool.query(
        `INSERT INTO categories (account_id, name) 
         VALUES ($1, $2) 
         ON CONFLICT (account_id, name) DO UPDATE SET name = EXCLUDED.name 
         RETURNING id`,
        [account_id, category.trim()]
      );
      categoryId = catResult.rows[0].id;
    }

    let imageUrl = null;
    if (req.file && req.file.path) {
      imageUrl = req.file.path; // Cloudinary URL
    }

    const itemAvailable = is_available !== undefined ? (is_available === true || is_available === "true") : true;
    const itemIsVeg = is_veg !== undefined ? (is_veg === true || is_veg === "true") : null;

    // 1. Insert into menu_items (account level catalog)
    const result = await pool.query(
      `INSERT INTO menu_items (account_id, category_id, name, description, price, image_url, is_available, is_veg) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        account_id,
        categoryId,
        name.trim(),
        description || "",
        parseFloat(price),
        imageUrl,
        itemAvailable,
        itemIsVeg
      ]
    );
    const item = result.rows[0];

    // 2. Link to current branch
    await pool.query(
      `INSERT INTO branch_menu_items (branch_id, menu_item_id, is_available) 
       VALUES ($1, $2, $3) 
       ON CONFLICT (branch_id, menu_item_id) DO UPDATE SET is_available = EXCLUDED.is_available`,
      [branch_id, item.id, itemAvailable]
    );

    res.status(201).json({
      message: "Menu item created",
      item: {
        ...item,
        category: category || "Mains"
      }
    });
  } catch (error) {
    console.error("Error creating menu item:", error);
    next(error);
  }
};

// 3. Link an ingredient to a menu item
const linkIngredient = async (req, res, next) => {
  try {
    const { account_id } = req.staff;
    const { itemId, ingredientId } = req.params;

    // Verify both item and ingredient belong to this account
    const verifyQuery = `
      SELECT 
        (SELECT count(*) FROM menu_items WHERE id = $1 AND account_id = $3) as item_valid,
        (SELECT count(*) FROM ingredients WHERE id = $2 AND account_id = $3) as ingredient_valid
    `;
    const verifyResult = await pool.query(verifyQuery, [itemId, ingredientId, account_id]);

    if (verifyResult.rows[0].item_valid === "0" || verifyResult.rows[0].ingredient_valid === "0") {
      return res.status(403).json({ error: "Invalid item or ingredient for this account" });
    }

    await pool.query(
      "INSERT INTO item_ingredients (menu_item_id, ingredient_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [itemId, ingredientId]
    );

    res.json({ message: "Ingredient linked to menu item successfully" });
  } catch (error) {
    next(error);
  }
};

// 4. Get all ingredients for a branch
const getIngredients = async (req, res, next) => {
  try {
    const { branch_id, account_id } = req.staff;
    const result = await pool.query(
      `SELECT 
        i.id,
        i.name,
        COALESCE(bis.is_in_stock, TRUE) as is_in_stock
       FROM ingredients i
       LEFT JOIN branch_ingredient_stock bis ON bis.ingredient_id = i.id AND bis.branch_id = $2
       WHERE i.account_id = $1 
       ORDER BY i.id DESC`,
      [account_id, branch_id]
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
};

// 5. Get all menu items for a branch
const getMenuItems = async (req, res, next) => {
  try {
    const { branch_id, account_id } = req.staff;
    const result = await pool.query(
      `SELECT 
        mi.id,
        mi.name,
        mi.description,
        COALESCE(bmi.price_override, mi.price) as price,
        COALESCE(c.name, 'Mains') as category,
        mi.image_url,
        (mi.is_available AND COALESCE(bmi.is_available, TRUE)) as is_available,
        mi.is_veg
       FROM menu_items mi
       LEFT JOIN categories c ON mi.category_id = c.id
       LEFT JOIN branch_menu_items bmi ON bmi.menu_item_id = mi.id AND bmi.branch_id = $2
       WHERE mi.account_id = $1 AND mi.deleted_at IS NULL
       ORDER BY mi.id DESC`,
      [account_id, branch_id]
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
};

// 6. Toggle menu item availability
const toggleItemAvailability = async (req, res, next) => {
  try {
    const { branch_id } = req.staff;
    const { itemId } = req.params;
    const { is_available } = req.body;

    const result = await pool.query(
      `INSERT INTO branch_menu_items (branch_id, menu_item_id, is_available) 
       VALUES ($1, $2, $3) 
       ON CONFLICT (branch_id, menu_item_id) 
       DO UPDATE SET is_available = $3 
       RETURNING *`,
      [branch_id, itemId, is_available]
    );
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createIngredient,
  createMenuItem,
  linkIngredient,
  getIngredients,
  getMenuItems,
  toggleItemAvailability
};
