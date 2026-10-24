const express = require("express");
const router = express.Router();
const { upload } = require("../config/cloudinary");
const { authStaff, requireRole } = require("../middlewares/auth");
const { 
  createIngredient, 
  createMenuItem, 
  updateMenuItem,
  deleteMenuItem,
  getCategories,
  linkIngredient, 
  getIngredients, 
  getMenuItems, 
  toggleItemAvailability 
} = require("../controllers/adminMenuController");

// All these routes require staff authentication (partner token + x-branch-id)

// Category Routes
router.get("/categories", authStaff, getCategories);

// Ingredient Routes
router.get("/ingredients", authStaff, getIngredients);
router.post("/ingredients", authStaff, requireRole(["owner", "manager"]), createIngredient);

// Menu Item Routes (uses Multer upload middleware)
router.get("/items", authStaff, getMenuItems);
router.post("/items", authStaff, requireRole(["owner", "manager"]), upload.single("image"), createMenuItem);
router.put("/items/:itemId", authStaff, requireRole(["owner", "manager"]), upload.single("image"), updateMenuItem);
router.patch("/items/:itemId", authStaff, requireRole(["owner", "manager"]), upload.single("image"), updateMenuItem);
router.delete("/items/:itemId", authStaff, requireRole(["owner", "manager"]), deleteMenuItem);
router.patch("/items/:itemId/availability", authStaff, toggleItemAvailability);

// Link Ingredient to Menu Item
router.post("/items/:itemId/ingredients/:ingredientId", authStaff, requireRole(["owner", "manager"]), linkIngredient);

module.exports = router;
