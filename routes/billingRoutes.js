const express = require("express");
const router = express.Router();
const { generateBill, payBill } = require("../controllers/billingController");
const { authCustomer } = require("../middlewares/auth");

// Customer requests bill (transitions session → payment_pending, notifies staff)
router.post("/generate", authCustomer, generateBill);

// NOTE: Bill settlement (marking paid + closing the session) is now exclusively
// handled by staff via POST /api/admin/sessions/:id/settle
// The payBill customer endpoint has been intentionally removed.

module.exports = router;
