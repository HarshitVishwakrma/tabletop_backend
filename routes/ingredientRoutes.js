const express = require("express");
const router = express.Router();
const { updateStock } = require("../controllers/ingredientController");
const { authStaff } = require("../middlewares/auth");

router.patch("/:id/stock", authStaff, updateStock);

module.exports = router;
