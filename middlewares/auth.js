const jwt = require("jsonwebtoken");
const pool = require("../config/db");

// Middleware for customer endpoints (requires an active table session)
const authCustomer = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: "Authorization header with session token required" });
  }

  const token = authHeader.split(" ")[1];
  if (!token) {
    return res.status(401).json({ error: "Session token required" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'supersecret_fallback');
    // decoded should contain { account_id, branch_id, table_id }
    
    // Ensure the customer session matches the requested tenant domain
    if (decoded.account_id !== req.tenant.account_id) {
      return res.status(403).json({ error: "Session invalid for this tenant" });
    }

    req.customer = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired session" });
  }
};

// Middleware for partner/admin endpoints (verifies staff JWT)
const authPartner = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "Authorization header required" });

  const token = authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Token required" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'supersecret_fallback');
    // decoded has { user_id, account_id, role }

    // Check if user exists and is active in database
    const userCheck = await pool.query(
      "SELECT id, role, is_active FROM users WHERE id = $1 AND account_id = $2",
      [decoded.user_id, decoded.account_id]
    );

    if (userCheck.rows.length === 0) {
      return res.status(401).json({ error: "User no longer exists" });
    }

    const user = userCheck.rows[0];
    if (user.is_active === false) {
      return res.status(401).json({ error: "Account has been deactivated" });
    }

    // Attach fresh role from database to req.partner
    req.partner = { ...decoded, role: user.role };
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};

// Middleware for branch-specific staff operations (combines authPartner and x-branch-id)
const authStaff = (req, res, next) => {
  // First ensure they are a valid authenticated partner user
  authPartner(req, res, () => {
    const branchId = req.headers['x-branch-id'];
    if (!branchId) {
      return res.status(400).json({ error: "x-branch-id header is required for staff operations" });
    }
    
    req.staff = { 
      user_id: req.partner.user_id,
      account_id: req.partner.account_id,
      role: req.partner.role,
      branch_id: parseInt(branchId, 10) 
    };
    next();
  });
};

// Middleware to restrict routes to specific roles (owners always bypass)
const requireRole = (allowedRoles = []) => (req, res, next) => {
  const role = req.partner?.role || req.staff?.role;
  if (!role) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (role === "owner" || allowedRoles.includes(role)) {
    return next();
  }
  return res.status(403).json({ error: `Access denied. Requires one of: ${allowedRoles.join(", ")}` });
};

module.exports = {
  authCustomer,
  authPartner,
  authStaff,
  requireRole
};
