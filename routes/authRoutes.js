const express = require("express");
const router = express.Router();
const { registerPartner, loginPartner } = require("../controllers/authController");

router.post("/register", registerPartner);
router.post("/login", loginPartner);

module.exports = router;
