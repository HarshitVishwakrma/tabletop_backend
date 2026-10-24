const express = require("express");
const router = express.Router();
const { getBranches, createBranch, getTables, createTable } = require("../controllers/adminController");
const { authPartner, authStaff, requireRole } = require("../middlewares/auth");
const { getSessions, settleSession, resumeSession, closeEmptySession, voidSession } = require("../controllers/adminSessionController");
const { getBranchOrders, updateOrderStatus } = require("../controllers/orderController");

// Account level management (requires partner JWT, but no specific branch)
router.get("/branches", authPartner, getBranches);
router.post("/branches", authPartner, requireRole(["owner"]), createBranch);

// Branch level management (requires partner JWT AND x-branch-id header)
router.get("/tables", authStaff, getTables);
router.post("/tables", authStaff, requireRole(["owner", "manager"]), createTable);

// Orders management (staff)
router.get("/orders", authStaff, getBranchOrders);
router.patch("/orders/:id/status", authStaff, updateOrderStatus);

// Session management (staff)
router.get("/sessions", authStaff, getSessions);
router.post("/sessions/:id/settle", authStaff, requireRole(["owner", "manager", "waiter"]), settleSession);
router.post("/sessions/:id/resume", authStaff, requireRole(["owner", "manager"]), resumeSession);
router.post("/sessions/:id/close-empty", authStaff, requireRole(["owner", "manager"]), closeEmptySession);
router.post("/sessions/:id/void", authStaff, requireRole(["owner", "manager"]), voidSession);

module.exports = router;

