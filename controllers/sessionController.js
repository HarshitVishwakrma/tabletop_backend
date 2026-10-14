const pool = require("../config/db");
const jwt = require("jsonwebtoken");

const startSession = async (req, res, next) => {
  try {
    const { qr_code } = req.body;
    const { account_id } = req.tenant;

    if (!qr_code) {
      return res.status(400).json({ error: "qr_code is required to start a session" });
    }

    // Verify the table belongs to this tenant by qr_token or table_number fallback
    const tableResult = await pool.query(
      `SELECT t.id, t.account_id, t.branch_id, t.table_number, t.qr_token, b.name as branch_name 
       FROM tables t
       JOIN branches b ON t.branch_id = b.id
       WHERE (t.qr_token::text = $1 OR t.table_number ILIKE $1) 
         AND t.account_id = $2 
         AND t.is_active = TRUE`,
      [qr_code.trim(), account_id]
    );

    if (tableResult.rows.length === 0) {
      return res.status(404).json({ error: "Table not found or invalid QR." });
    }

    const table = tableResult.rows[0];

    // Find or create an active table session
    const sessionResult = await pool.query(
      `INSERT INTO table_sessions (account_id, branch_id, table_id, status) 
       VALUES ($1, $2, $3, 'active') 
       ON CONFLICT (table_id) WHERE status <> 'closed' 
       DO UPDATE SET last_activity_at = NOW() 
       RETURNING id, session_token, status`,
      [table.account_id, table.branch_id, table.id]
    );
    const session = sessionResult.rows[0];

    // Create a JWT session token for the customer
    const token = jwt.sign(
      { 
        account_id: table.account_id, 
        branch_id: table.branch_id, 
        table_id: table.id,
        session_id: session.id,
        session_token: session.session_token 
      }, 
      process.env.JWT_SECRET || 'supersecret_fallback', 
      { expiresIn: '8h' }
    );

    res.json({ 
      message: "Session started successfully", 
      token, 
      session_id: session.id,
      session_status: session.status,   // 'active' | 'payment_pending' — lets client restore state
      branch_id: table.branch_id, 
      branch_name: table.branch_name, 
      table_number: table.table_number 
    });
  } catch(error) {
    next(error);
  }
};

module.exports = {
  startSession
};
