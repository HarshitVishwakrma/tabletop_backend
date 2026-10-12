const express = require("express");
const router = express.Router();
const { startSession } = require("../controllers/sessionController");

router.post("/start", startSession);

module.exports = router;
