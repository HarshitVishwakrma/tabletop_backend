# Tabletop Backend API & Integration Guide

Welcome to the Tabletop SaaS Backend! This document explains how to connect your frontend (React, Vue, or Mobile) to the backend API, handle multi-tenancy, manage authentication, and use real-time WebSockets.

---

## 1. Multi-Tenancy (The Subdomain Rule)
The backend identifies which restaurant (tenant) the user is interacting with by looking at the **`Host` header** of the HTTP request. 
For example, if a request is made to `spicytable.tabletop.in`, the backend automatically resolves the tenant as "Spicy Table".

**Frontend Dev Tip:** 
When developing locally (e.g., your frontend is on `localhost:5173`), the browser sends `Host: localhost:5173`. To test a specific tenant like `spicytable`, you should configure your frontend Axios/Fetch instance to override the headers, or use a local proxy.

---

## 2. Authentication Contexts
There are three distinct layers of authentication in this system. Always include the token in the `Authorization: Bearer <token>` header.

| Role | How to Get Token | Required Headers | What it Accesses |
| :--- | :--- | :--- | :--- |
| **Partner (Admin)** | `POST /api/auth/login` | `Authorization: Bearer <token>` | Account-level settings, viewing branches. |
| **Staff (Kitchen/Manager)**| Same as Partner | `Authorization: Bearer <token>`<br/>`x-branch-id: <branch_id>` | Branch KDS, Inventory, Table creation. |
| **Customer (Diner)** | `POST /api/sessions/start`| `Authorization: Bearer <token>` | Fetching the menu, placing orders, billing. |

---

## 3. Customer Flow (The Diner's Experience)

### Step 1: Scan QR & Start Session
When a customer scans a table QR code, the frontend extracts the `qr` hash from the URL and starts a session.
*   **Endpoint:** `POST /api/sessions/start`
*   **Body:** `{ "qr_code": "d751968ccc05eb9a1002e933cfd23066" }`
*   **Response:** Returns a JWT `token`. Save this in `localStorage` or memory.

### Step 2: View Menu
*   **Endpoint:** `GET /api/menu`
*   **Headers:** `Authorization: Bearer <customer_token>`
*   **Behavior:** Returns the branch menu. Dishes auto-hide (`effective_available: false`) if linked ingredients are out of stock.

### Step 3: Place Order (Cart Checkout)
*   **Endpoint:** `POST /api/orders`
*   **Headers:** `Authorization: Bearer <customer_token>`
*   **Body:** `{ "items": [{ "menu_item_id": 1, "quantity": 2, "notes": "No onions" }] }`
*   **Behavior:** Creates a ticket and fires a WebSocket event to the kitchen.

### Step 4: Request Bill & Checkout
*   **Endpoint:** `POST /api/billing/generate`
*   **Behavior:** Sums unbilled orders, applies 5% GST, returns receipt, and pings the kitchen.
*   **Endpoint:** `POST /api/billing/:bill_id/pay`
*   **Behavior:** Marks the bill paid, archives orders, and resets the table session.

---

## 4. Partner/Staff Flow (Dashboard & KDS)

### Step 1: Login
*   **Endpoint:** `POST /api/auth/login`
*   **Body:** `{ "email": "admin@spicytable.in", "password": "password123" }`
*   **Response:** Returns the Partner JWT `token`.

### Step 2: Dashboard Initialization
*   **Endpoint:** `GET /api/admin/branches` (Requires Auth Header)
*   *Frontend logic:* Ask the user to select which branch they are managing today from the returned list. Save the selected `branch_id` in context/state. **Attach `x-branch-id: <branch_id>` to all subsequent staff requests.**

### Step 3: Kitchen Display System (KDS)
*   **Endpoint:** `GET /api/orders/branch`
*   **Headers:** `Auth` + `x-branch-id`
*   **Behavior:** Fetches all active (unbilled) orders for the kitchen screen.
*   **Endpoint:** `PATCH /api/orders/:id/status`
*   **Body:** `{ "status": "preparing" }` (Valid: `pending`, `preparing`, `ready`, `delivered`)

### Step 4: Inventory Management
*   **Endpoint:** `PATCH /api/ingredients/:id/stock`
*   **Headers:** `Auth` + `x-branch-id`
*   **Body:** `{ "is_in_stock": false }`
*   **Behavior:** Instantly updates dish availability for all new customer menu loads.

---

## 5. Real-Time WebSockets (Socket.IO)

Both the Kitchen Dashboard and the Customer App should connect to WebSockets to avoid refreshing the page.

### Connection & Setup
```javascript
import { io } from "socket.io-client";

// Connect to backend
const socket = io("http://localhost:3000");

// Immediately join the specific branch room
// (Customers get branch_id from /api/sessions/start. Staff get it from their Dashboard selection)
socket.emit("join_branch", branch_id); 
```

### Events to Listen For (Frontend `socket.on(...)`)

| Event Name | Who Listens | Payload | Description |
| :--- | :--- | :--- | :--- |
| `new_order` | Kitchen | `{ order_id, items, table_number... }` | A customer just placed an order. Add ticket to KDS. |
| `order_updated` | Customer & Kitchen | `{ order_id, status }` | Kitchen moved ticket to "preparing" or "ready". Update UI. |
| `bill_requested` | Kitchen | `{ id, subtotal, total, table_id... }` | Customer requested the bill. Staff should process payment. |
| `table_session_closed`| Customer | `{ table_id, bill_id }` | Bill was paid. Customer UI should reset to the "Scan QR" screen. |

---

## 6. Menu Builder (Images via Cloudinary)
When a partner adds a new dish, you must send the data as `multipart/form-data` (not JSON) so the image file can be parsed by the backend and uploaded to Cloudinary.

*   **Endpoint:** `POST /api/admin/menu/items`
*   **Headers:** `Auth` + `x-branch-id` (Do NOT manually set Content-Type, let Axios/Fetch set it automatically with boundaries).
*   **Payload (FormData):**
    ```javascript
    const formData = new FormData();
    formData.append("name", "Paneer Tikka");
    formData.append("price", 250);
    formData.append("image", fileInput.files[0]); // The actual file object
    ```
