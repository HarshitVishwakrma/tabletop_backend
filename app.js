// index.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const http = require("http");
const { Server } = require("socket.io");

const initDB = require("./config/initDb");
const tenantResolver = require("./middlewares/tenantResolver");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // allow all for MVP
  },
});

// Middleware to inject io into requests
app.use((req, res, next) => {
  req.io = io;
  next();
});

// Socket.io connection logic
io.on("connection", (socket) => {
  console.log("A user connected:", socket.id);
  
  // Kitchen staff or customer joins a branch-specific room
  socket.on("join_branch", (branch_id) => {
    socket.join(`branch_${branch_id}`);
    console.log(`Socket ${socket.id} joined branch_${branch_id}`);
  });

  // Customer joins their session-specific room to receive session lifecycle events
  socket.on("join_session", (session_id) => {
    socket.join(`session_${session_id}`);
    console.log(`Socket ${socket.id} joined session_${session_id}`);
  });

  // Staff user joins their user-specific room for account events
  socket.on("join_user", (user_id) => {
    socket.join(`user_${user_id}`);
    console.log(`Socket ${socket.id} joined user_${user_id}`);
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });
});

app.use(helmet());
app.use(cors());
app.use(express.json());

// Apply tenantResolver to customer-facing routes only. 
// Admin and Auth routes do not require a tenant subdomain context.
app.use("/api", (req, res, next) => {
  if (req.originalUrl.startsWith('/api/auth') || req.originalUrl.startsWith('/api/admin')) {
    return next();
  }
  return tenantResolver(req, res, next);
});

app.use("/api", require("./routes"));

// ==========================================
// 5. ERROR HANDLING MIDDLEWARE
// ==========================================
app.use((err, req, res, next) => {
  console.log(err);
  res.status(500).json({
    error: "Internal Server Error",
    message:
      process.env.NODE_ENV === "development"
        ? err.message
        : "Something went wrong",
  });
});

// ==========================================
// 6. SERVER STARTUP
// ==========================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  await initDB();
  console.log(`Server is running on port ${PORT}`);
});

module.exports = { app, server };
