const pool = require("../config/db");

// --- Helpers ---
const getFinancialYear = (date = new Date()) => {
  const year = date.getFullYear();
  const month = date.getMonth(); // 0-indexed, 3 = April
  return month >= 3 
    ? `${year}-${(year + 1).toString().slice(-2)}` 
    : `${year - 1}-${year.toString().slice(-2)}`;
};

const computeTotals = async (client, sessionId) => {
  const { rows } = await client.query(
    `SELECT
       COALESCE(SUM(oi.price * oi.quantity), 0)                        AS subtotal,
       COALESCE(SUM(oi.price * oi.quantity * oi.gst_rate / 200.0), 0) AS cgst,
       COALESCE(SUM(oi.price * oi.quantity * oi.gst_rate / 200.0), 0) AS sgst
     FROM orders o
     JOIN order_items oi ON o.id = oi.order_id
     WHERE o.session_id = $1 AND o.status != 'cancelled'`,
    [sessionId]
  );
  const subtotal = parseFloat(rows[0].subtotal) || 0;
  const cgst    = parseFloat(parseFloat(rows[0].cgst).toFixed(2));
  const sgst    = parseFloat(parseFloat(rows[0].sgst).toFixed(2));
  return { subtotal, cgst, sgst, total: parseFloat((subtotal + cgst + sgst).toFixed(2)) };
};

// --- Lifecycle Actions ---

// 1. payment_pending ──(staff confirms cash)──▶ closed
const settleSession = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { account_id, branch_id, user_id } = req.staff;
    const { id } = req.params;
    const { force, method = 'cash' } = req.body;

    const VALID_METHODS = ['cash', 'upi', 'card', 'other'];
    const paymentMethod = VALID_METHODS.includes(method) ? method : 'cash';

    await client.query("BEGIN");

    const { rows: [session] } = await client.query(
      "SELECT * FROM table_sessions WHERE id = \$1 FOR UPDATE", 
      [id]
    );

    if (!session || session.account_id !== account_id || session.branch_id !== branch_id) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Session not found" });
    }
    if (session.status === "closed") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Session is already closed" });
    }
    if (session.status !== "payment_pending") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Bill hasn't been requested yet" });
    }

    // Verify totals haven't changed since the bill was requested
    const totals = await computeTotals(client, id);
    const { rows: [bill] } = await client.query(
      "SELECT * FROM bills WHERE session_id = \$1 FOR UPDATE", 
      [id]
    );

    if (!bill || Math.abs(totals.total - Number(bill.total)) > 0.01) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Bill changed since it was generated. Please refresh the bill." });
    }

    // Prevent settlement if food is still preparing (unless forced)
    const { rows: [{ pending_count }] } = await client.query(
      "SELECT COUNT(*)::int as pending_count FROM orders WHERE session_id=\$1 AND status IN ('pending','accepted','preparing')", 
      [id]
    );
    if (pending_count > 0 && !force) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Some orders are still being prepared." });
    }

    // Generate gap-free invoice number
    const fy = getFinancialYear(new Date());
    await client.query("SELECT pg_advisory_xact_lock(\$1)", [branch_id]);
    const { rows: [{ next_bill }] } = await client.query(
      "SELECT COALESCE(MAX(bill_number), 0) + 1 AS next_bill FROM bills WHERE branch_id=\$1 AND financial_year=\$2",
      [branch_id, fy]
    );

    // Update records
    await client.query(
      `UPDATE bills SET payment_status='paid', financial_year=$2, bill_number=$3, finalized_at=NOW() WHERE id=$1`, 
      [bill.id, fy, next_bill]
    );
    
    await client.query(
      "INSERT INTO payments (account_id, bill_id, method, amount, status) VALUES (\$1, \$2, \$3, \$4, 'success')",
      [account_id, bill.id, paymentMethod, bill.total]
    );
    
    await client.query(
      `UPDATE table_sessions 
       SET status='closed', ended_at=NOW(), ended_by='staff' 
       WHERE id=$1`, 
      [id]
    );

    // Mark all orders as served 
    await client.query(
      "UPDATE orders SET status = 'served', updated_at = NOW(), served_at = NOW() WHERE session_id = \$1 AND status NOT IN ('served', 'cancelled')",
      [id]
    );

    await client.query("COMMIT");

    if (req.io) {
      const closedPayload = { table_id: session.table_id, session_id: id };
      req.io.to('branch_' + branch_id).emit('table_session_closed', closedPayload);
      req.io.to('session_' + id).emit('table_session_closed', closedPayload);
    }

    res.json({ message: "Session settled successfully", bill_number: `${fy}-${next_bill}` });
  } catch (e) {
    await client.query("ROLLBACK");
    next(e);
  } finally {
    client.release();
  }
};

// 2. payment_pending ──(customer/waiter taps "Keep ordering")──▶ active
const resumeSession = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { account_id, branch_id } = req.staff;
    const { id } = req.params;

    await client.query("BEGIN");

    const { rows: [session] } = await client.query(
      "SELECT status, table_id FROM table_sessions WHERE id = \$1 AND account_id = \$2 AND branch_id = \$3 FOR UPDATE",
      [id, account_id, branch_id]
    );

    if (!session || session.status !== 'payment_pending') {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Only sessions pending payment can be resumed." });
    }

    // Void the pending bill so a new one is generated next time
    await client.query(
      "UPDATE bills SET payment_status = 'void', updated_at = NOW() WHERE session_id = \$1 AND payment_status = 'pending'",
      [id]
    );

    const { rows: [updatedSession] } = await client.query(
      "UPDATE table_sessions SET status = 'active', last_activity_at = NOW() WHERE id = \$1 RETURNING *",
      [id]
    );

    await client.query("COMMIT");

    if (req.io) {
      const payload = { table_id: session.table_id, session_id: id };
      // Notify staff dashboard
      req.io.to('branch_' + branch_id).emit('session_resumed', payload);
      // Notify the customer's browser so it exits the "bill requested" state
      req.io.to('session_' + id).emit('session_resumed', payload);
    }

    res.json({ message: "Session resumed for ordering", session: updatedSession });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
};

// 3. active, no orders ──(staff/timeout)──▶ closed
const closeEmptySession = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { account_id, branch_id } = req.staff;
    const { id } = req.params;

    await client.query("BEGIN");

    const { rows: [session] } = await client.query(
      "SELECT status, table_id FROM table_sessions WHERE id = \$1 AND account_id = \$2 AND branch_id = \$3 FOR UPDATE",
      [id, account_id, branch_id]
    );

    if (!session || session.status === 'closed') {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Session is already closed or does not exist." });
    }

    const { rows: [{ order_count }] } = await client.query(
      "SELECT COUNT(*)::int as order_count FROM orders WHERE session_id = \$1",
      [id]
    );

    if (order_count > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Cannot silently close: This session has orders. Settle or void it instead." });
    }

    await client.query(
      "UPDATE table_sessions SET status = 'closed', ended_at = NOW(), ended_by = 'staff' WHERE id = \$1",
      [id]
    );

    await client.query("COMMIT");

    if (req.io) {
      req.io.to('branch_' + branch_id).emit('table_session_closed', { table_id: session.table_id, session_id: id });
    }

    res.json({ message: "Empty session closed securely." });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
};

// 4. any state ──(staff voids with reason)──▶ closed
const voidSession = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { account_id, branch_id } = req.staff;
    const { id } = req.params;
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({ error: "A reason is required to void a session." });
    }

    await client.query("BEGIN");

    const { rows: [session] } = await client.query(
      "SELECT status, table_id FROM table_sessions WHERE id = \$1 AND account_id = \$2 AND branch_id = \$3 FOR UPDATE",
      [id, account_id, branch_id]
    );

    if (!session || session.status === 'closed') {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Session is already closed or does not exist." });
    }

    // Cancel all active orders
    await client.query(
      "UPDATE orders SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = 'staff', cancelled_reason = \$2 WHERE session_id = \$1 AND status NOT IN ('served', 'cancelled')",
      [id, reason]
    );

    // Void pending bills
    await client.query(
      "UPDATE bills SET payment_status = 'void', updated_at = NOW() WHERE session_id = \$1 AND payment_status != 'paid'",
      [id]
    );

    // Close session
    await client.query(
      "UPDATE table_sessions SET status = 'closed', ended_at = NOW(), ended_by = 'staff' WHERE id = \$1",
      [id]
    );

    await client.query("COMMIT");

    if (req.io) {
      req.io.to('branch_' + branch_id).emit('table_session_closed', { table_id: session.table_id, session_id: id });
      req.io.to('branch_' + branch_id).emit('session_voided', { session_id: id, reason });
    }

    res.json({ message: "Session voided successfully." });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
};

// 5. GET all active / payment_pending sessions for a branch (admin billing panel)
const getSessions = async (req, res, next) => {
  try {
    const { account_id, branch_id } = req.staff;
    const { rows } = await pool.query(
      `SELECT
         ts.id          AS session_id,
         ts.table_id,
         ts.status,
         ts.started_at,
         t.table_number,
         b.id           AS bill_id,
         b.subtotal,
         b.cgst,
         b.sgst,
         b.total,
         b.payment_status
       FROM table_sessions ts
       JOIN tables t ON t.id = ts.table_id
       LEFT JOIN bills b ON b.session_id = ts.id
       WHERE ts.branch_id = $1
         AND ts.account_id = $2
         AND ts.status <> 'closed'
       ORDER BY ts.started_at ASC`,
      [branch_id, account_id]
    );
    res.json(rows);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getSessions,
  settleSession,
  resumeSession,
  closeEmptySession,
  voidSession
};