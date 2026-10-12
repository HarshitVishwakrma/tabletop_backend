const pool = require("../config/db");

// ---------------------------
// BRANCH MANAGEMENT
// ---------------------------

// Get all branches for the logged-in partner
const getBranches = async (req, res, next) => {
  try {
    const { account_id } = req.partner;
    const result = await pool.query(
      `SELECT 
        b.id, 
        b.name, 
        b.address, 
        b.phone,
        b.is_active,
        (SELECT COUNT(*) FROM tables t WHERE t.branch_id = b.id)::int as tables_count,
        (SELECT COUNT(*) FROM orders o WHERE o.branch_id = b.id AND o.status NOT IN ('served', 'cancelled'))::int as active_orders
       FROM branches b 
       WHERE b.account_id = $1 
       ORDER BY b.id ASC`,
      [account_id]
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
};

// Create a new branch
const createBranch = async (req, res, next) => {
  try {
    const { account_id, user_id } = req.partner;
    const { name, address, phone } = req.body;

    if (!name) {
      return res.status(400).json({ error: "Branch name is required" });
    }

    const result = await pool.query(
      "INSERT INTO branches (account_id, name, address, phone) VALUES ($1, $2, $3, $4) RETURNING *",
      [account_id, name, address || null, phone || null]
    );

    const newBranch = result.rows[0];

    // Grant user access in user_branches
    if (user_id) {
      await pool.query(
        "INSERT INTO user_branches (user_id, branch_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [user_id, newBranch.id]
      );
    }

    res.status(201).json({
      message: "Branch created successfully",
      branch: newBranch
    });
  } catch (error) {
    next(error);
  }
};

// ---------------------------
// TABLE MANAGEMENT
// ---------------------------

// Get all tables for a specific branch
const getTables = async (req, res, next) => {
  try {
    const { branch_id, account_id } = req.staff; // provided by authStaff based on x-branch-id
    const result = await pool.query(
      `SELECT id, account_id, branch_id, table_number, qr_token, qr_token as qr_code_hash, is_active 
       FROM tables 
       WHERE branch_id = $1 AND account_id = $2 
       ORDER BY id ASC`,
      [branch_id, account_id]
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
};

// Create a new table and generate its unique QR code hash/token
const createTable = async (req, res, next) => {
  try {
    const { branch_id, account_id } = req.staff;
    const { table_number } = req.body;

    if (!table_number) {
      return res.status(400).json({ error: "Table number is required" });
    }

    const result = await pool.query(
      `INSERT INTO tables (account_id, branch_id, table_number) 
       VALUES ($1, $2, $3) 
       RETURNING id, account_id, branch_id, table_number, qr_token, qr_token as qr_code_hash, is_active`,
      [account_id, branch_id, table_number]
    );

    res.status(201).json({
      message: "Table created successfully",
      table: result.rows[0]
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getBranches,
  createBranch,
  getTables,
  createTable
};
