const express = require("express");
const router = express.Router();
const { getBranches, createBranch, getTables, createTable } = require("../controllers/adminController");
const { authPartner, authStaff } = require("../middlewares/auth");
const { getSessions, settleSession, resumeSession, closeEmptySession, voidSession } = require("../controllers/adminSessionController");
const { getBranchOrders, updateOrderStatus } = require("../controllers/orderController");

// Account level management (requires partner JWT, but no specific branch)
router.get("/branches", authPartner, getBranches);
router.post("/branches", authPartner, createBranch);

// Branch level management (requires partner JWT AND x-branch-id header)
router.get("/tables", authStaff, getTables);
router.post("/tables", authStaff, createTable);

// Orders management (staff)
router.get("/orders", authStaff, getBranchOrders);
router.patch("/orders/:id/status", authStaff, updateOrderStatus);

// Session management (staff)
router.get("/sessions", authStaff, getSessions);
router.post("/sessions/:id/settle", authStaff, settleSession);
router.post("/sessions/:id/resume", authStaff, resumeSession);
router.post("/sessions/:id/close-empty", authStaff, closeEmptySession);
router.post("/sessions/:id/void", authStaff, voidSession);

module.exports = router;

