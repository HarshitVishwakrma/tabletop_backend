const express = require("express");
const router = express.Router();

const authRoutes = require("./authRoutes");
const adminRoutes = require("./adminRoutes");
const adminMenuRoutes = require("./adminMenuRoutes");
const menuRoutes = require("./menuRoutes");
const ingredientRoutes = require("./ingredientRoutes");
const sessionRoutes = require("./sessionRoutes");
const orderRoutes = require("./orderRoutes");
const billingRoutes = require("./billingRoutes");
const teamRoutes = require("./teamRoutes");

router.use("/auth", authRoutes);
router.use("/admin/menu", adminMenuRoutes);
router.use("/admin/team", teamRoutes);
router.use("/admin", adminRoutes);
router.use("/menu", menuRoutes);
router.use("/ingredients", ingredientRoutes);
router.use("/sessions", sessionRoutes);
router.use("/orders", orderRoutes);
router.use("/billing", billingRoutes);

module.exports = router;
