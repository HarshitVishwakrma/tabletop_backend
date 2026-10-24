const pool = require("../config/db");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const registerPartner = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { business_name, subdomain, user_name, email, password } = req.body;

    if (!business_name || !subdomain || !user_name || !email || !password) {
      return res.status(400).json({ error: "All fields are required" });
    }

    await client.query("BEGIN");

    // 1. Check if subdomain is taken
    const accountCheck = await client.query("SELECT id FROM accounts WHERE subdomain = $1", [subdomain]);
    if (accountCheck.rows.length > 0) {
      throw new Error("Subdomain is already taken");
    }

    // 2. Check if email is taken
    const emailCheck = await client.query("SELECT id FROM users WHERE email = $1", [email]);
    if (emailCheck.rows.length > 0) {
      throw new Error("Email is already registered");
    }

    // 3. Create Account
    const accountResult = await client.query(
      "INSERT INTO accounts (name, subdomain, status) VALUES ($1, $2, 'active') RETURNING id",
      [business_name, subdomain]
    );
    const accountId = accountResult.rows[0].id;

    // Attach to plan if available
    const planResult = await client.query("SELECT id FROM plans LIMIT 1");
    if (planResult.rows.length > 0) {
      await client.query(
        "INSERT INTO subscriptions (account_id, plan_id, status, current_period_start, current_period_end) VALUES ($1, $2, 'active', NOW(), NOW() + INTERVAL '30 days')",
        [accountId, planResult.rows[0].id]
      );
    }

    // 4. Create first default Branch
    const branchResult = await client.query(
      "INSERT INTO branches (account_id, name) VALUES ($1, $2) RETURNING id",
      [accountId, "Main Branch"]
    );
    const branchId = branchResult.rows[0].id;

    // 5. Create Owner User (role is 'owner' in new schema)
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const userResult = await client.query(
      "INSERT INTO users (account_id, name, email, password_hash, role) VALUES ($1, $2, $3, $4, 'owner') RETURNING id, name, email, role",
      [accountId, user_name, email, passwordHash]
    );
    const userId = userResult.rows[0].id;

    // 6. Link user to default branch
    await client.query(
      "INSERT INTO user_branches (user_id, branch_id) VALUES ($1, $2)",
      [userId, branchId]
    );

    await client.query("COMMIT");

    res.status(201).json({
      message: "Partner registered successfully",
      user: {
        ...userResult.rows[0],
        account_name: business_name,
        subdomain
      }
    });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.message === "Subdomain is already taken" || error.message === "Email is already registered") {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  } finally {
    client.release();
  }
};

const loginPartner = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const result = await pool.query(
      `SELECT u.id, u.account_id, u.name, u.password_hash, u.role, u.is_active, a.name as account_name, a.subdomain, a.status as account_status
       FROM users u 
       JOIN accounts a ON u.account_id = a.id 
       WHERE u.email = $1`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const user = result.rows[0];
    const isMatch = await bcrypt.compare(password, user.password_hash);

    if (!isMatch) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    if (user.is_active === false) {
      return res.status(403).json({ error: "Your account has been deactivated. Please contact your restaurant owner." });
    }

    if (user.account_status && user.account_status !== 'active') {
      return res.status(403).json({ error: "Restaurant account is suspended or inactive" });
    }

    // Generate Partner JWT
    const token = jwt.sign(
      { user_id: user.id, account_id: user.account_id, role: user.role },
      process.env.JWT_SECRET || 'supersecret_fallback',
      { expiresIn: '24h' }
    );

    res.json({
      message: "Logged in successfully",
      token,
      user: {
        id: user.id,
        name: user.name,
        role: user.role,
        account_id: user.account_id,
        account_name: user.account_name,
        subdomain: user.subdomain
      }
    });
  } catch (error) {
    next(error);
  }
};

const verifyPartnerToken = async (req, res, next) => {
  try {
    const { user_id, account_id } = req.partner;

    const result = await pool.query(
      `SELECT u.id, u.account_id, u.name, u.email, u.role, u.is_active, a.name as account_name, a.subdomain, a.status as account_status
       FROM users u 
       JOIN accounts a ON u.account_id = a.id 
       WHERE u.id = $1 AND u.account_id = $2`,
      [user_id, account_id]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "User no longer exists" });
    }

    const user = result.rows[0];
    if (user.is_active === false) {
      return res.status(401).json({ error: "Account has been deactivated" });
    }

    if (user.account_status && user.account_status !== 'active') {
      return res.status(403).json({ error: "Account is suspended or inactive" });
    }

    res.json({
      valid: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        account_id: user.account_id,
        account_name: user.account_name,
        subdomain: user.subdomain
      }
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  registerPartner,
  loginPartner,
  verifyPartnerToken
};
