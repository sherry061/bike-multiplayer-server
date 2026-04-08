require("dotenv").config();
const express = require("express");
const http = require("http");
const cors = require("cors");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

// ========================================
// CONFIG
// ========================================

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "change-this-in-production";
const OAUTH_TOKEN_URL = process.env.OAUTH_TOKEN_URL;
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID;
const OAUTH_REDIRECT_URI = process.env.OAUTH_REDIRECT_URI;
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || null;

// ========================================
// IN-MEMORY STORES
// ========================================

const users = {}; // userId -> { userId, username, providerUserId, ... }
const players = {}; // socketId -> player runtime state
const rooms = {}; // roomCode -> room object

// ========================================
// HEALTH CHECK
// ========================================

app.get("/", (req, res) => {
  res.json({
    status: "running",
    service: "Bike Multiplayer Server",
    timestamp: new Date().toISOString()
  });
});

// ========================================
// AUTH ENDPOINT
// ========================================

app.post("/auth/exchange", async (req, res) => {
  try {
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({ error: "Missing authorization code" });
    }

    console.log("[AUTH] Exchanging code:", code.substring(0, 10) + "...");

    // Build token exchange request
    const params = new URLSearchParams();
    params.append("grant_type", "authorization_code");
    params.append("code", code);
    params.append("client_id", OAUTH_CLIENT_ID);
    params.append("redirect_uri", OAUTH_REDIRECT_URI);

    // Add client secret if required
    if (OAUTH_CLIENT_SECRET) {
      params.append("client_secret", OAUTH_CLIENT_SECRET);
    }

    // Exchange code for tokens
    const tokenResp = await axios.post(OAUTH_TOKEN_URL, params, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    });

    const providerTokens = tokenResp.data;
    console.log("[AUTH] Provider tokens received");

    // Extract user info from token response
    // Adjust these fields based on what your provider returns
    const providerUserId = providerTokens.user_id || providerTokens.sub || "unknown";
    const username = providerTokens.username || providerTokens.name || "Player";

    // Create or update user in our DB (in-memory for now)
    let user = Object.values(users).find(u => u.providerUserId === providerUserId);

    if (!user) {
      const userId = `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      user = {
        userId,
        providerUserId,
        username,
        createdAt: new Date().toISOString()
      };
      users[userId] = user;
      console.log("[AUTH] New user created:", userId);
    } else {
      user.username = username;
      user.lastLogin = new Date().toISOString();
      console.log("[AUTH] Existing user logged in:", user.userId);
    }

    // Create our own JWT
    const sessionToken = jwt.sign(
      {
        userId: user.userId,
        username: user.username,
        providerUserId: user.providerUserId
      },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      success: true,
      token: sessionToken,
      user: {
        userId: user.userId,
        username: user.username
      }
    });

  } catch (err) {
    console.error("[AUTH] Exchange error:", err.response?.data || err.message);
    res.status(500).json({
      error: "Authentication failed",
      details: err.response?.data || err.message
    });
  }
});

// ========================================
// SOCKET.IO WITH AUTH
// ========================================

const io = new Server(server, {
  cors: { origin: "*" }
});

// Middleware: Verify JWT on connection
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;

    if (!token) {
      console.log("[SOCKET] Connection rejected: no token");
      return next(new Error("Authentication required"));
    }

    const payload = jwt.verify(token, JWT_SECRET);

    socket.user = {
      userId: payload.userId,
      username: payload.username,
      providerUserId: payload.providerUserId
    };

    console.log("[SOCKET] Auth success:", socket.user.username);
    next();

  } catch (err) {
    console.log("[SOCKET] Auth failed:", err.message);
    next(new Error("Invalid or expired token"));
  }
});

// ========================================
// SOCKET HANDLERS
// ========================================

io.on("connection", (socket) => {
  console.log(`[CONNECT] ${socket.user.username} (${socket.id})`);

  // Initialize player state
  players[socket.id] = {
    socketId: socket.id,
    userId: socket.user.userId,
    username: socket.user.username,
    x: 0,
    y: 0,
    z: 0,
    rotY: 0,
    roomCode: null
  };

  socket.emit("welcome", {
    myId: socket.id,
    userId: socket.user.userId,
    username: socket.user.username
  });

  // ========================================
  // CREATE ROOM
  // ========================================

  socket.on("createRoom", () => {
    try {
      const userId = socket.user.userId;
      const username = socket.user.username;
      const roomCode = createUniqueRoomCode();

      players[socket.id].roomCode = roomCode;

      rooms[roomCode] = {
        roomCode,
        hostSocketId: socket.id,
        hostUserId: userId,
        hostUsername: username,
        selectedScene: "",
        players: [
          {
            socketId: socket.id,
            userId,
            username
          }
        ],
        readyPlayers: new Set()
      };

      socket.join(roomCode);

      console.log(`[ROOM CREATED] ${roomCode} by ${username}`);

      socket.emit("roomCreated", getRoomStateDto(roomCode));
      io.to(roomCode).emit("roomUpdate", getRoomStateDto(roomCode));

    } catch (err) {
      console.error("[CREATE ROOM ERROR]", err);
      socket.emit("joinError", "Failed to create room");
    }
  });

  // ========================================
  // JOIN ROOM
  // ========================================

  socket.on("joinRoom", (data) => {
    try {
      const roomCode = data?.roomCode;
      const userId = socket.user.userId;
      const username = socket.user.username;

      if (!roomCode || !rooms[roomCode]) {
        socket.emit("joinError", "Room not found");
        return;
      }

      const room = rooms[roomCode];

      players[socket.id].roomCode = roomCode;

      const alreadyInRoom = room.players.some(p => p.socketId === socket.id);
      if (!alreadyInRoom) {
        room.players.push({
          socketId: socket.id,
          userId,
          username
        });
      }

      room.readyPlayers = room.readyPlayers || new Set();
      socket.join(roomCode);

      console.log(`[ROOM JOINED] ${username} → ${roomCode}`);

      socket.emit("roomJoined", getRoomStateDto(roomCode));
      io.to(roomCode).emit("roomUpdate", getRoomStateDto(roomCode));

    } catch (err) {
      console.error("[JOIN ROOM ERROR]", err);
      socket.emit("joinError", "Failed to join room");
    }
  });

  // ========================================
  // SELECT MAP
  // ========================================

  socket.on("selectMap", (data) => {
    try {
      const roomCode = players[socket.id]?.roomCode;
      if (!roomCode || !rooms[roomCode]) return;

      const room = rooms[roomCode];

      // Only host can select map
      if (room.hostSocketId !== socket.id) {
        console.log(`[SELECT MAP] Rejected: ${socket.user.username} is not host`);
        return;
      }

      room.selectedScene = data?.sceneName || "";

      console.log(`[MAP SELECTED] ${roomCode} → ${room.selectedScene}`);

      io.to(roomCode).emit("mapSelected", {
        sceneName: room.selectedScene
      });

      io.to(roomCode).emit("roomUpdate", getRoomStateDto(roomCode));

    } catch (err) {
      console.error("[SELECT MAP ERROR]", err);
    }
  });

  // ========================================
  // START GAME
  // ========================================

  socket.on("startGame", () => {
    try {
      const roomCode = players[socket.id]?.roomCode;
      if (!roomCode || !rooms[roomCode]) return;

      const room = rooms[roomCode];

      // Only host can start
      if (room.hostSocketId !== socket.id) return;

      if (room.players.length < 2) {
        socket.emit("startError", "Need at least 2 players");
        return;
      }

      if (!room.selectedScene) {
        socket.emit("startError", "No map selected");
        return;
      }

      const startAt = Date.now() + 8000;

      io.to(roomCode).emit("gameStarting", {
        sceneName: room.selectedScene,
        startAt
      });

      console.log(`[GAME STARTING] ${roomCode} → ${room.selectedScene} at ${startAt}`);

    } catch (err) {
      console.error("[START GAME ERROR]", err);
    }
  });

  // ========================================
  // BIKE READY
  // ========================================

  socket.on("bikeReady", (data) => {
    try {
      const roomCode = data?.roomCode || players[socket.id]?.roomCode;
      if (!roomCode || !rooms[roomCode]) return;

      const room = rooms[roomCode];
      const userId = socket.user.userId;

      room.readyPlayers = room.readyPlayers || new Set();
      room.readyPlayers.add(userId);

      console.log(
        `[BIKE READY] ${socket.user.username} in ${roomCode} (${room.readyPlayers.size}/${room.players.length})`
      );

      if (room.readyPlayers.size >= room.players.length) {
        const startAt = Date.now() + 3000;

        io.to(roomCode).emit("allBikesReady", { startAt });
        console.log(`[ALL BIKES READY] ${roomCode} → ${startAt}`);

        room.readyPlayers.clear();
      }

    } catch (err) {
      console.error("[BIKE READY ERROR]", err);
    }
  });

  // ========================================
  // LEAVE ROOM
  // ========================================

  socket.on("leaveRoom", () => {
    handleLeaveRoom(socket);
  });

  // ========================================
  // PLAYER MOVE
  // ========================================

  socket.on("playerMove", (data) => {
    const player = players[socket.id];
    if (!player) return;

    player.x = data?.x ?? player.x;
    player.y = data?.y ?? player.y;
    player.z = data?.z ?? player.z;
    player.rotY = data?.rotY ?? player.rotY;
  });

  // ========================================
  // DISCONNECT
  // ========================================

  socket.on("disconnect", () => {
    console.log(`[DISCONNECT] ${socket.user.username} (${socket.id})`);
    handleLeaveRoom(socket);
    delete players[socket.id];
  });
});

// ========================================
// HELPER FUNCTIONS
// ========================================

function generateRoomCode(length = 6) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function createUniqueRoomCode() {
  let code;
  do {
    code = generateRoomCode();
  } while (rooms[code]);
  return code;
}

function getRoomStateDto(roomCode) {
  const room = rooms[roomCode];
  if (!room) return null;

  return {
    roomCode: room.roomCode,
    hostId: room.hostUserId,
    hostUsername: room.hostUsername,
    selectedScene: room.selectedScene,
    players: room.players.map(p => ({
      userId: p.userId,
      username: p.username
    }))
  };
}

function handleLeaveRoom(socket) {
  const player = players[socket.id];
  if (!player) return;

  const roomCode = player.roomCode;
  if (!roomCode || !rooms[roomCode]) return;

  const room = rooms[roomCode];

  if (room.readyPlayers && player.userId) {
    room.readyPlayers.delete(player.userId);
  }

  room.players = room.players.filter(p => p.socketId !== socket.id);
  socket.leave(roomCode);

  // Transfer host if host left
  if (room.hostSocketId === socket.id && room.players.length > 0) {
    room.hostSocketId = room.players[0].socketId;
    room.hostUserId = room.players[0].userId;
    room.hostUsername = room.players[0].username;
  }

  players[socket.id].roomCode = null;

  console.log(`[LEAVE ROOM] ${player.username} left ${roomCode}`);

  if (room.players.length === 0) {
    delete rooms[roomCode];
    console.log(`[ROOM DELETED] ${roomCode}`);
  } else {
    io.to(roomCode).emit("roomUpdate", getRoomStateDto(roomCode));
  }
}

// ========================================
// POSITION BROADCAST
// ========================================

let lastBroadcastDebugAt = 0;

setInterval(() => {
  const now = Date.now();
  const shouldDebug = now - lastBroadcastDebugAt >= 5000;

  for (const roomCode in rooms) {
    const room = rooms[roomCode];
    const roomPlayers = {};

    for (const p of room.players) {
      const socketId = p.socketId;

      if (players[socketId]) {
        roomPlayers[p.userId] = {
          username: p.username,
          x: players[socketId].x,
          y: players[socketId].y,
          z: players[socketId].z,
          rotY: players[socketId].rotY
        };
      }
    }

    if (shouldDebug && Object.keys(roomPlayers).length > 0) {
      console.log(`[BROADCAST] ${roomCode} → ${Object.keys(roomPlayers).length} players`);
    }

    io.to(roomCode).emit("playerPositions", roomPlayers);
  }

  if (shouldDebug) {
    lastBroadcastDebugAt = now;
  }
}, 50); // 20 Hz

// ========================================
// START SERVER
// ========================================

server.listen(PORT, "0.0.0.0", () => {
  console.log(`
╔════════════════════════════════════════╗
║  Bike Multiplayer Server              ║
║  Port: ${PORT}                           ║
║  Auth: Enabled                        ║
║  Status: Running                      ║
╚════════════════════════════════════════╝
  `);
});