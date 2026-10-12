const express = require("express");
const router = express.Router();
const { getBranches, createBranch, getTables, createTable } = require("../controllers/adminController");
const { authPartner, authStaff } = require("../middlewares/auth");

// Account level management (requires partner JWT, but no specific branch)
router.get("/branches", authPartner, getBranches);
router.post("/branches", authPartner, createBranch);

// Branch level management (requires partner JWT AND x-branch-id header)
router.get("/tables", authStaff, getTables);
router.post("/tables", authStaff, createTable);

// Orders management (staff)
const { getBranchOrders, updateOrderStatus } = require("../controllers/orderController");
router.get("/orders", authStaff, getBranchOrders);
router.patch("/orders/:id/status", authStaff, updateOrderStatus);

module.exports = router;
