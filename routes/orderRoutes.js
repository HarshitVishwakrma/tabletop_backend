const express = require("express");
const router = express.Router();
const { placeOrder, getTableOrders, getBranchOrders, updateOrderStatus, cancelCustomerOrder } = require("../controllers/orderController");
const { authCustomer, authStaff } = require("../middlewares/auth");

// Customer-facing routes (requires table session)
router.post("/", authCustomer, placeOrder);
router.get("/", authCustomer, getTableOrders);
router.patch("/:id/cancel", authCustomer, cancelCustomerOrder);
router.post("/:id/cancel", authCustomer, cancelCustomerOrder);

module.exports = router;
