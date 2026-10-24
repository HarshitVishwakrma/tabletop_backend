const express = require("express");
const router = express.Router();
const { authPartner } = require("../middlewares/auth");
const {
  getTeamUsers,
  getRolePermissions,
  updateRolePermissions,
  createTeamUser,
  updateTeamUser,
  deleteTeamUser,
  getMyPermissions,
} = require("../controllers/teamController");

// Middleware: Owner-only guard
const requireOwner = (req, res, next) => {
  if (!req.partner || req.partner.role !== "owner") {
    return res.status(403).json({ error: "Only the account owner can manage team and permissions" });
  }
  next();
};

// Any authenticated staff can fetch their own permissions
router.get("/my-permissions", authPartner, getMyPermissions);

// Owner-only routes
router.get("/users", authPartner, requireOwner, getTeamUsers);
router.post("/users", authPartner, requireOwner, createTeamUser);
router.patch("/users/:userId", authPartner, requireOwner, updateTeamUser);
router.put("/users/:userId", authPartner, requireOwner, updateTeamUser);
router.delete("/users/:userId", authPartner, requireOwner, deleteTeamUser);

router.get("/permissions", authPartner, requireOwner, getRolePermissions);
router.put("/permissions", authPartner, requireOwner, updateRolePermissions);

module.exports = router;

