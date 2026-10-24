const express = require("express");
const router = express.Router();
const { upload } = require("../config/cloudinary");
const { authStaff } = require("../middlewares/auth");
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
router.post("/ingredients", authStaff, createIngredient);

// Menu Item Routes (uses Multer upload middleware)
router.get("/items", authStaff, getMenuItems);
router.post("/items", authStaff, upload.single("image"), createMenuItem);
router.put("/items/:itemId", authStaff, upload.single("image"), updateMenuItem);
router.patch("/items/:itemId", authStaff, upload.single("image"), updateMenuItem);
router.delete("/items/:itemId", authStaff, deleteMenuItem);
router.patch("/items/:itemId/availability", authStaff, toggleItemAvailability);

// Link Ingredient to Menu Item
router.post("/items/:itemId/ingredients/:ingredientId", authStaff, linkIngredient);

module.exports = router;
