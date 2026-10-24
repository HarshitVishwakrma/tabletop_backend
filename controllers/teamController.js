const pool = require("../config/db");
const bcrypt = require("bcryptjs");

// Page slugs that can be permission-gated (owner always sees all)
const ALL_PAGES = ["overview", "orders", "billing", "menu", "inventory", "branches", "settings"];

// Default page grants per role for new accounts
const DEFAULT_PERMISSIONS = {
  manager: ["overview", "orders", "billing", "menu", "inventory", "branches"],
  waiter:  ["orders", "billing"],
  kitchen: ["orders"],
};

// -----------------------------------------------------------------
// Ensure default permissions exist for all non-owner roles in acct
// -----------------------------------------------------------------
async function seedDefaultPermissions(client, accountId) {
  for (const [role, pages] of Object.entries(DEFAULT_PERMISSIONS)) {
    for (const page of pages) {
      await client.query(
        `INSERT INTO role_permissions (account_id, role, page)
         VALUES ($1, $2, $3)
         ON CONFLICT (account_id, role, page) DO NOTHING`,
        [accountId, role, page]
      );
    }
  }
}

// -----------------------------------------------------------------
// 1. GET /admin/team/users — list all users in the account
// -----------------------------------------------------------------
const getTeamUsers = async (req, res, next) => {
  try {
    const { account_id } = req.partner;

    const result = await pool.query(
      `SELECT id, name, email, role, is_active, created_at
       FROM users
       WHERE account_id = $1
       ORDER BY CASE role WHEN 'owner' THEN 1 WHEN 'manager' THEN 2 WHEN 'waiter' THEN 3 WHEN 'kitchen' THEN 4 END, id ASC`,
      [account_id]
    );

    res.json(result.rows);
  } catch (error) {
    next(error);
  }
};

// -----------------------------------------------------------------
// 2. GET /admin/team/permissions — get role permissions for account
// -----------------------------------------------------------------
const getRolePermissions = async (req, res, next) => {
  try {
    const { account_id } = req.partner;

    // Ensure defaults are seeded
    const client = await pool.connect();
    try {
      // Check if any permissions exist for this account
      const existing = await client.query(
        "SELECT COUNT(*) FROM role_permissions WHERE account_id = $1",
        [account_id]
      );
      if (parseInt(existing.rows[0].count, 10) === 0) {
        await client.query("BEGIN");
        await seedDefaultPermissions(client, account_id);
        await client.query("COMMIT");
      }
    } finally {
      client.release();
    }

    const result = await pool.query(
      "SELECT role, page FROM role_permissions WHERE account_id = $1 ORDER BY role, page",
      [account_id]
    );

    // Group by role
    const permissions = { manager: [], waiter: [], kitchen: [] };
    for (const row of result.rows) {
      if (permissions[row.role]) {
        permissions[row.role].push(row.page);
      }
    }

    res.json({ permissions, available_pages: ALL_PAGES });
  } catch (error) {
    next(error);
  }
};

// -----------------------------------------------------------------
// 3. PUT /admin/team/permissions — update permissions for a role
// -----------------------------------------------------------------
const updateRolePermissions = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { account_id } = req.partner;
    const { role, pages } = req.body;

    if (!role || !["manager", "waiter", "kitchen"].includes(role)) {
      return res.status(400).json({ error: "Invalid role. Must be manager, waiter, or kitchen." });
    }

    if (!Array.isArray(pages)) {
      return res.status(400).json({ error: "pages must be an array of page slugs" });
    }

    // Validate page slugs
    const validPages = pages.filter(p => ALL_PAGES.includes(p));

    await client.query("BEGIN");

    // Delete existing permissions for this role in this account
    await client.query(
      "DELETE FROM role_permissions WHERE account_id = $1 AND role = $2",
      [account_id, role]
    );

    // Insert new permissions
    for (const page of validPages) {
      await client.query(
        "INSERT INTO role_permissions (account_id, role, page) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        [account_id, role, page]
      );
    }

    await client.query("COMMIT");

    // Return updated permissions
    const result = await pool.query(
      "SELECT role, page FROM role_permissions WHERE account_id = $1 ORDER BY role, page",
      [account_id]
    );
    const permissions = { manager: [], waiter: [], kitchen: [] };
    for (const row of result.rows) {
      if (permissions[row.role]) permissions[row.role].push(row.page);
    }

    if (req.io) {
      req.io.emit("role_permissions_updated", { role, pages: validPages });
    }

    res.json({ message: `Permissions for ${role} updated.`, permissions });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    next(error);
  } finally {
    client.release();
  }
};

// -----------------------------------------------------------------
// 4. POST /admin/team/users — invite / create a new staff user
// -----------------------------------------------------------------
const createTeamUser = async (req, res, next) => {
  try {
    const { account_id } = req.partner;
    const { name, email, password, role } = req.body;

    if (!name || !email || !password || !role) {
      return res.status(400).json({ error: "name, email, password, and role are required" });
    }
    if (!["manager", "waiter", "kitchen"].includes(role)) {
      return res.status(400).json({ error: "Role must be manager, waiter, or kitchen" });
    }

    // Check email not already taken
    const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "Email is already registered" });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const result = await pool.query(
      `INSERT INTO users (account_id, name, email, password_hash, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, email, role, is_active, created_at`,
      [account_id, name.trim(), email.toLowerCase().trim(), passwordHash, role]
    );

    res.status(201).json({ message: "Team member created", user: result.rows[0] });
  } catch (error) {
    next(error);
  }
};

// -----------------------------------------------------------------
// 5. PATCH /admin/team/users/:userId — update user role / active status
// -----------------------------------------------------------------
const updateTeamUser = async (req, res, next) => {
  try {
    const { account_id } = req.partner;
    const { userId } = req.params;
    const { role, is_active, name } = req.body;

    // Cannot modify yourself
    if (String(req.partner.user_id) === String(userId)) {
      return res.status(400).json({ error: "You cannot modify your own account" });
    }

    // Check the user belongs to this account and is not another owner
    const existing = await pool.query(
      "SELECT id, role FROM users WHERE id = $1 AND account_id = $2",
      [userId, account_id]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    if (existing.rows[0].role === "owner") {
      return res.status(403).json({ error: "Cannot modify another owner account" });
    }

    // Build update
    const updates = [];
    const values = [];
    let i = 1;

    if (name) { updates.push(`name = $${i++}`); values.push(name.trim()); }
    if (role && ["manager", "waiter", "kitchen"].includes(role)) {
      updates.push(`role = $${i++}`); values.push(role);
    }
    if (is_active !== undefined) { updates.push(`is_active = $${i++}`); values.push(Boolean(is_active)); }

    if (updates.length === 0) {
      return res.status(400).json({ error: "Nothing to update" });
    }

    updates.push(`updated_at = NOW()`);
    values.push(userId);
    values.push(account_id);

    const result = await pool.query(
      `UPDATE users SET ${updates.join(", ")} WHERE id = $${i++} AND account_id = $${i++} RETURNING id, name, email, role, is_active`,
      values
    );

    const updatedUser = result.rows[0];

    // Emit real-time event if user was deactivated or role updated
    if (req.io) {
      if (updatedUser && updatedUser.is_active === false) {
        req.io.to(`user_${userId}`).emit("account_deactivated", {
          user_id: parseInt(userId, 10),
          message: "Your account has been deactivated by the owner.",
        });
      } else if (role) {
        req.io.to(`user_${userId}`).emit("permissions_updated", {
          user_id: parseInt(userId, 10),
          role: updatedUser.role,
        });
      }
    }

    res.json({ message: "User updated", user: updatedUser });
  } catch (error) {
    next(error);
  }
};

// -----------------------------------------------------------------
// 6. DELETE /admin/team/users/:userId — deactivate / remove a staff user
// -----------------------------------------------------------------
const deleteTeamUser = async (req, res, next) => {
  try {
    const { account_id } = req.partner;
    const { userId } = req.params;

    if (String(req.partner.user_id) === String(userId)) {
      return res.status(400).json({ error: "You cannot delete your own account" });
    }

    const existing = await pool.query(
      "SELECT id, role FROM users WHERE id = $1 AND account_id = $2",
      [userId, account_id]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    if (existing.rows[0].role === "owner") {
      return res.status(403).json({ error: "Cannot delete an owner account" });
    }

    await pool.query("DELETE FROM users WHERE id = $1 AND account_id = $2", [userId, account_id]);

    if (req.io) {
      req.io.to(`user_${userId}`).emit("account_deactivated", {
        user_id: parseInt(userId, 10),
        message: "Your account has been deleted by the owner.",
      });
    }

    res.json({ message: "Team member removed" });
  } catch (error) {
    next(error);
  }
};

// -----------------------------------------------------------------
// 7. GET /admin/team/my-permissions — returns pages allowed for current user
//    (called on login for non-owner users)
// -----------------------------------------------------------------
const getMyPermissions = async (req, res, next) => {
  try {
    const { account_id, role } = req.partner;

    // Owner always gets all pages
    if (role === "owner") {
      return res.json({ role, pages: [...ALL_PAGES, "team"] });
    }

    const result = await pool.query(
      "SELECT page FROM role_permissions WHERE account_id = $1 AND role = $2",
      [account_id, role]
    );

    if (result.rows.length === 0) {
      // No permissions set for this role yet — seed defaults and return them
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await seedDefaultPermissions(client, account_id);
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      return res.json({
        role,
        pages: DEFAULT_PERMISSIONS[role] || [],
      });
    }

    res.json({ role, pages: result.rows.map(r => r.page) });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getTeamUsers,
  getRolePermissions,
  updateRolePermissions,
  createTeamUser,
  updateTeamUser,
  deleteTeamUser,
  getMyPermissions,
};

