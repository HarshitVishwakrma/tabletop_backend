const pool = require("../config/db");

// Place a new order from the cart
const placeOrder = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { account_id, branch_id, table_id, session_id } = req.customer;
    const { items } = req.body; // Expects an array: [{ menu_item_id, quantity, notes }]

    if (!items || items.length === 0) {
      return res.status(400).json({ error: "Order must contain at least one item" });
    }

    await client.query("BEGIN");

    // 1. Create the order ticket belonging to this active session
    const orderResult = await client.query(
      `INSERT INTO orders (account_id, branch_id, session_id, table_id, status) 
       VALUES ($1, $2, $3, $4, 'pending') RETURNING id`,
      [account_id, branch_id, session_id, table_id]
    );
    const orderId = orderResult.rows[0].id;

    // 2. Insert items safely by fetching current branch menu prices
    for (const item of items) {
      const { menu_item_id, quantity, notes } = item;

      const menuResult = await client.query(
        `SELECT mi.name, COALESCE(bmi.price_override, mi.price) as price, mi.is_available 
         FROM menu_items mi
         LEFT JOIN branch_menu_items bmi ON bmi.menu_item_id = mi.id AND bmi.branch_id = $2
         WHERE mi.id = $1 AND mi.account_id = $3 AND mi.deleted_at IS NULL`,
        [menu_item_id, branch_id, account_id]
      );

      if (menuResult.rows.length === 0) {
        throw new Error(`Menu item ${menu_item_id} not found`);
      }

      const { name, price, is_available } = menuResult.rows[0];
      if (!is_available) {
        throw new Error(`Menu item "${name}" is currently unavailable`);
      }

      await client.query(
        `INSERT INTO order_items (order_id, menu_item_id, item_name, price, quantity, notes, status) 
         VALUES ($1, $2, $3, $4, $5, $6, 'active')`,
        [orderId, menu_item_id, name, price, quantity || 1, notes || ""]
      );
    }

    await client.query("COMMIT");

    // Fetch full order details to notify the kitchen
    const newOrderResult = await pool.query(`
      SELECT 
        o.id as order_id, o.status, o.placed_at as created_at, t.table_number,
        COALESCE(SUM(oi.price * oi.quantity), 0) as total_amount,
        json_agg(
          json_build_object('name', oi.item_name, 'quantity', oi.quantity, 'notes', oi.notes, 'price', oi.price)
        ) as items
      FROM orders o
      LEFT JOIN tables t ON o.table_id = t.id
      JOIN order_items oi ON o.id = oi.order_id
      WHERE o.id = $1
      GROUP BY o.id, t.table_number
    `, [orderId]);

    if (newOrderResult.rows.length > 0 && req.io) {
      const orderPayload = { ...newOrderResult.rows[0], session_id };
      req.io.to('branch_' + branch_id).emit('new_order', orderPayload);
      req.io.to('session_' + session_id).emit('new_order', orderPayload);
    }

    res.status(201).json({ 
      message: "Order placed successfully", 
      order_id: orderId 
    });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.message.includes("not found") || error.message.includes("unavailable")) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  } finally {
    client.release();
  }
};

// Get all orders for the current table session
const getTableOrders = async (req, res, next) => {
  try {
    const { session_id } = req.customer;

    const query = `
      SELECT 
        o.id as order_id,
        o.status,
        o.placed_at as created_at,
        json_agg(
          json_build_object(
            'item_id', oi.id,
            'menu_item_id', oi.menu_item_id,
            'name', oi.item_name,
            'quantity', oi.quantity,
            'price', oi.price,
            'notes', oi.notes
          )
        ) as items
      FROM orders o
      JOIN order_items oi ON o.id = oi.order_id
      WHERE o.session_id = $1
      GROUP BY o.id
      ORDER BY o.placed_at DESC;
    `;

    const result = await pool.query(query, [session_id]);
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
};

// Get all active orders for the kitchen display
const getBranchOrders = async (req, res, next) => {
  try {
    const { branch_id } = req.staff;

    const query = `
      SELECT 
        o.id as order_id, 
        o.status, 
        o.placed_at as created_at, 
        t.table_number,
        COALESCE(SUM(oi.price * oi.quantity), 0) as total_amount,
        json_agg(
          json_build_object('name', oi.item_name, 'quantity', oi.quantity, 'notes', oi.notes, 'price', oi.price)
        ) as items
      FROM orders o
      LEFT JOIN tables t ON o.table_id = t.id
      JOIN order_items oi ON o.id = oi.order_id
      WHERE o.branch_id = $1 AND o.status NOT IN ('served', 'cancelled')
      GROUP BY o.id, t.table_number
      ORDER BY o.placed_at ASC;
    `;

    const result = await pool.query(query, [branch_id]);
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
};

// Update order status (e.g. pending -> accepted -> preparing -> ready -> served)
const updateOrderStatus = async (req, res, next) => {
  try {
    const { branch_id } = req.staff;
    const { id } = req.params;
    let { status } = req.body;

    // Gracefully handle legacy status names from frontend (delivered -> served)
    if (status === 'delivered') status = 'served';

    const validStatuses = ['pending', 'accepted', 'preparing', 'ready', 'served', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Valid values: ${validStatuses.join(', ')}` });
    }

    // Set timestamps based on status
    const statusTimestampCol = 
      status === 'accepted' ? ', accepted_at = NOW()' :
      status === 'ready' ? ', ready_at = NOW()' :
      status === 'served' ? ', served_at = NOW()' :
      status === 'cancelled' ? ', cancelled_at = NOW()' : '';

    const result = await pool.query(
      `UPDATE orders 
       SET status = $1, updated_at = NOW() ${statusTimestampCol} 
       WHERE id = $2 AND branch_id = $3 
       RETURNING *`,
      [status, id, branch_id]
    );

    const updatedOrder = result.rows[0];

    if (!updatedOrder) {
      return res.status(404).json({ error: "Order not found" });
    }

    // Emit event to update kitchen and customer screens
    if (req.io) {
      const payload = { order_id: String(id), status, session_id: updatedOrder.session_id };
      req.io.to('branch_' + branch_id).emit('order_updated', payload);
      // Also notify the customer who placed this order
      req.io.to('session_' + updatedOrder.session_id).emit('order_updated', payload);
    }

    res.json({ message: "Status updated", order: updatedOrder });
  } catch (error) {
    next(error);
  }
};

// Customer cancels an order (only if not ready or served yet)
const cancelCustomerOrder = async (req, res, next) => {
  try {
    const { session_id, branch_id } = req.customer;
    const { id } = req.params;

    const existing = await pool.query(
      "SELECT id, status, session_id, branch_id FROM orders WHERE id = $1 AND session_id = $2",
      [id, session_id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "Order not found in this session" });
    }

    const order = existing.rows[0];

    if (order.status === "ready" || order.status === "served" || order.status === "delivered") {
      return res.status(400).json({ error: `Cannot cancel order #${id} because it is already ${order.status}` });
    }

    if (order.status === "cancelled") {
      return res.status(400).json({ error: "Order is already cancelled" });
    }

    const result = await pool.query(
      `UPDATE orders 
       SET status = 'cancelled', updated_at = NOW(), cancelled_at = NOW() 
       WHERE id = $1 AND session_id = $2 
       RETURNING *`,
      [id, session_id]
    );

    if (req.io) {
      const payload = { order_id: String(id), status: 'cancelled', session_id };
      req.io.to('branch_' + branch_id).emit('order_updated', payload);
      req.io.to('session_' + session_id).emit('order_updated', payload);
    }

    res.json({ message: "Order cancelled successfully", order: result.rows[0] });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  placeOrder,
  getTableOrders,
  getBranchOrders,
  updateOrderStatus,
  cancelCustomerOrder,
};
