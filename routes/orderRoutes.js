const express = require("express");
const router = express.Router();
const { placeOrder, getTableOrders, getBranchOrders, updateOrderStatus } = require("../controllers/orderController");
const { authCustomer, authStaff } = require("../middlewares/auth");

// Customer-facing routes (requires table session)
router.post("/", authCustomer, placeOrder);
router.get("/", authCustomer, getTableOrders);

module.exports = router;
