const express = require("express");
const router = express.Router();
const { registerPartner, loginPartner, verifyPartnerToken } = require("../controllers/authController");
const { authPartner } = require("../middlewares/auth");

router.post("/register", registerPartner);
router.post("/login", loginPartner);
router.get("/verify", authPartner, verifyPartnerToken);
router.get("/me", authPartner, verifyPartnerToken);

module.exports = router;
