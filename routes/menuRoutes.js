const express = require("express");
const router = express.Router();
const { getMenu } = require("../controllers/menuController");
const { authCustomer } = require("../middlewares/auth");

router.get("/", authCustomer, getMenu);

module.exports = router;
