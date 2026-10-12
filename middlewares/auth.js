const jwt = require("jsonwebtoken");

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
const authPartner = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "Authorization header required" });

  const token = authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Token required" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'supersecret_fallback');
    // decoded has { user_id, account_id, role }
    req.partner = decoded;
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

module.exports = {
  authCustomer,
  authPartner,
  authStaff
};
