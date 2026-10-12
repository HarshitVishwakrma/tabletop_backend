const pool = require("../config/db");

const updateStock = async (req, res, next) => {
  try {
    const { branch_id } = req.staff;
    const { id } = req.params;
    const { is_in_stock } = req.body;

    const result = await pool.query(
      `INSERT INTO branch_ingredient_stock (branch_id, ingredient_id, is_in_stock, updated_at) 
       VALUES ($1, $2, $3, NOW()) 
       ON CONFLICT (branch_id, ingredient_id) 
       DO UPDATE SET is_in_stock = $3, updated_at = NOW() 
       RETURNING *`,
      [branch_id, id, is_in_stock]
    );

    res.json({
      message: "Stock updated successfully",
      ingredient: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  updateStock,
};
