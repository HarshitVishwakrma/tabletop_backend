const express = require("express");
const router = express.Router();
const { generateBill, payBill } = require("../controllers/billingController");
const { authCustomer } = require("../middlewares/auth");

// Customer requests bill
router.post("/generate", authCustomer, generateBill);

// Customer (or mock payment gateway) pays the bill
router.post("/:bill_id/pay", authCustomer, payBill);

module.exports = router;
