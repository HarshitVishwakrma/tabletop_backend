const pool = require("../config/db");

const getMenu = async (req, res, next) => {
  try {
    // The branch_id comes from the customer session (set by authCustomer middleware)
    const { branch_id } = req.customer;
    const query = `
      SELECT 
        bm.menu_item_id as id, 
        bm.name, 
        bm.description, 
        bm.price,
        bm.image_url,
        COALESCE(c.name, 'Mains') as category,
        bm.is_veg,
        bm.is_orderable AS is_available,
        bm.is_orderable AS effective_available
      FROM branch_menu bm
      LEFT JOIN categories c ON bm.category_id = c.id
      WHERE bm.branch_id = $1
      ORDER BY bm.sort_order ASC, bm.name ASC;
    `;
    const result = await pool.query(query, [branch_id]);
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getMenu,
};
