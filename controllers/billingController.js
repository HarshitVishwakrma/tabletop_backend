const pool = require("../config/db");

// Generate a bill for the current table session
const generateBill = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { account_id, branch_id, table_id, session_id } = req.customer;

    await client.query("BEGIN");

    // 1. Calculate subtotal and per-item GST from orders in this active session
    const itemsResult = await client.query(
      `SELECT
         COALESCE(SUM(oi.price * oi.quantity), 0)                        AS subtotal,
         COALESCE(SUM(oi.price * oi.quantity * oi.gst_rate / 200.0), 0) AS cgst,
         COALESCE(SUM(oi.price * oi.quantity * oi.gst_rate / 200.0), 0) AS sgst,
         COUNT(DISTINCT o.id)                                             AS order_count
       FROM orders o
       JOIN order_items oi ON o.id = oi.order_id
       WHERE o.session_id = $1 AND o.status != 'cancelled'`,
      [session_id]
    );

    const subtotal   = parseFloat(itemsResult.rows[0].subtotal)    || 0;
    const orderCount = parseInt(itemsResult.rows[0].order_count, 10);

    if (orderCount === 0 || subtotal === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "No billable orders found for this table session." });
    }

    // 2. GST split: each item's gst_rate is split equally into CGST + SGST
    const cgst  = parseFloat(parseFloat(itemsResult.rows[0].cgst).toFixed(2));
    const sgst  = parseFloat(parseFloat(itemsResult.rows[0].sgst).toFixed(2));
    const total = parseFloat((subtotal + cgst + sgst).toFixed(2));

    // 3. Upsert into bills table (1 bill per session)
    const billResult = await client.query(
      `INSERT INTO bills (account_id, branch_id, session_id, subtotal, cgst, sgst, total, payment_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
       ON CONFLICT (session_id) 
       DO UPDATE SET 
         subtotal = EXCLUDED.subtotal, 
         cgst = EXCLUDED.cgst, 
         sgst = EXCLUDED.sgst, 
         total = EXCLUDED.total,
         updated_at = NOW()
       RETURNING *`,
      [account_id, branch_id, session_id, subtotal, cgst, sgst, total]
    );
    const bill = billResult.rows[0];

    // 4. Update table_session status
    await client.query(
      "UPDATE table_sessions SET status = 'payment_pending', last_activity_at = NOW() WHERE id = $1",
      [session_id]
    );

    // 5. Fetch Partner's GST Number and business name
    const accountResult = await client.query(
      "SELECT gst_number, name as business_name FROM accounts WHERE id = $1",
      [account_id]
    );

    await client.query("COMMIT");

    const receipt = {
      ...bill,
      table_id,
      business_name: accountResult.rows[0]?.business_name || "Restaurant",
      gst_number: accountResult.rows[0]?.gst_number || "Not Provided"
    };

    // Notify kitchen/staff that table requested bill
    if (req.io) {
      req.io.to('branch_' + branch_id).emit('bill_requested', receipt);
    }

    res.status(201).json({
      message: "Bill generated successfully",
      receipt
    });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
};

// Pay the bill and close the table session
const payBill = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { account_id, branch_id, table_id, session_id } = req.customer;
    const { bill_id } = req.params;
    const { payment_method } = req.body; // 'cash', 'upi', 'card', 'online'

    await client.query("BEGIN");

    // Verify bill exists for this session
    const billCheck = await client.query(
      "SELECT id, total, payment_status FROM bills WHERE id = $1 AND session_id = $2",
      [bill_id, session_id]
    );

    if (billCheck.rows.length === 0) {
      throw new Error("Bill not found for this session");
    }
    if (billCheck.rows[0].payment_status === 'paid') {
      throw new Error("Bill is already paid");
    }

    const bill = billCheck.rows[0];
    const method = ['cash', 'upi', 'card', 'online'].includes(payment_method) ? payment_method : 'online';

    // 1. Mark bill as paid
    await client.query(
      "UPDATE bills SET payment_status = 'paid', finalized_at = NOW(), updated_at = NOW() WHERE id = $1",
      [bill_id]
    );

    // 2. Insert payment record
    await client.query(
      `INSERT INTO payments (account_id, bill_id, method, amount, status) 
       VALUES ($1, $2, $3, $4, 'success')`,
      [account_id, bill_id, method, bill.total]
    );

    // 3. Mark all active orders for this session as served
    await client.query(
      "UPDATE orders SET status = 'served', updated_at = NOW(), served_at = NOW() WHERE session_id = $1 AND status NOT IN ('served', 'cancelled')",
      [session_id]
    );

    // 4. Close the session
    await client.query(
      "UPDATE table_sessions SET status = 'closed', ended_at = NOW(), ended_by = 'customer' WHERE id = $1",
      [session_id]
    );

    await client.query("COMMIT");

    // Notify frontend to reset table state
    if (req.io) {
      req.io.to('branch_' + branch_id).emit('table_session_closed', { table_id, bill_id });
    }

    res.json({ message: "Bill paid successfully. Session closed." });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.message.includes("not found") || error.message.includes("already paid")) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  } finally {
    client.release();
  }
};

// Customer requests receipt / finalized bill
const getCustomerBill = async (req, res, next) => {
  try {
    const { account_id, branch_id, session_id } = req.customer;

    const sessionRes = await pool.query(
      `SELECT
         ts.id AS session_id,
         ts.status AS session_status,
         ts.started_at,
         ts.ended_at,
         ts.ended_by,
         t.table_number,
         b.id AS branch_id,
         b.name AS branch_name,
         b.address AS branch_address,
         b.phone AS branch_phone,
         a.id AS account_id,
         a.name AS business_name,
         a.gst_number
       FROM table_sessions ts
       JOIN tables t ON t.id = ts.table_id
       JOIN branches b ON b.id = ts.branch_id
       JOIN accounts a ON a.id = ts.account_id
       WHERE ts.id = $1 AND ts.branch_id = $2 AND ts.account_id = $3`,
      [session_id, branch_id, account_id]
    );

    if (sessionRes.rows.length === 0) {
      return res.status(404).json({ error: "Session not found" });
    }

    const sInfo = sessionRes.rows[0];

    const billRes = await pool.query(
      `SELECT id, financial_year, bill_number, subtotal, discount, service_charge, cgst, sgst, rounding, total, payment_status, finalized_at, created_at
       FROM bills
       WHERE session_id = $1`,
      [session_id]
    );
    const bill = billRes.rows[0] || null;

    let payment = null;
    if (bill) {
      const payRes = await pool.query(
        `SELECT method, amount, status, created_at
         FROM payments
         WHERE bill_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [bill.id]
      );
      payment = payRes.rows[0] || null;
    }

    const itemsRes = await pool.query(
      `SELECT
         oi.id,
         oi.order_id,
         oi.item_name AS name,
         oi.quantity,
         oi.price,
         oi.gst_rate,
         (oi.price * oi.quantity) AS total_price,
         o.status AS order_status
       FROM orders o
       JOIN order_items oi ON o.id = oi.order_id
       WHERE o.session_id = $1 AND o.status != 'cancelled'
       ORDER BY o.placed_at ASC, oi.id ASC`,
      [session_id]
    );

    let subtotal = 0;
    let cgst = 0;
    let sgst = 0;
    let total = 0;

    if (bill) {
      subtotal = parseFloat(bill.subtotal) || 0;
      cgst = parseFloat(bill.cgst) || 0;
      sgst = parseFloat(bill.sgst) || 0;
      total = parseFloat(bill.total) || 0;
    } else {
      subtotal = itemsRes.rows.reduce((sum, item) => sum + (parseFloat(item.total_price) || 0), 0);
      cgst = parseFloat((subtotal * 0.025).toFixed(2));
      sgst = parseFloat((subtotal * 0.025).toFixed(2));
      total = parseFloat((subtotal + cgst + sgst).toFixed(2));
    }

    const invoiceNumber = bill && bill.financial_year && bill.bill_number
      ? `${bill.financial_year}-${bill.bill_number}`
      : (bill ? `BILL-${bill.id}` : `DRAFT-${session_id}`);

    res.json({
      receipt: {
        session_id: sInfo.session_id,
        session_status: sInfo.session_status,
        started_at: sInfo.started_at,
        ended_at: sInfo.ended_at,
        table_number: sInfo.table_number,
        branch_name: sInfo.branch_name,
        branch_address: sInfo.branch_address,
        branch_phone: sInfo.branch_phone,
        business_name: sInfo.business_name,
        gst_number: sInfo.gst_number || "Not Provided",
        invoice_number: invoiceNumber,
        bill_id: bill ? bill.id : null,
        subtotal,
        cgst,
        sgst,
        total,
        payment_status: bill ? bill.payment_status : 'unpaid',
        payment_method: payment ? payment.method : (bill?.payment_status === 'paid' ? 'cash' : null),
        finalized_at: bill?.finalized_at || sInfo.ended_at || null,
        items: itemsRes.rows
      }
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  generateBill,
  payBill,
  getCustomerBill
};
