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
// AUTH - VALIDATE WGC TOKEN (NEW)
app.post("/auth/validate", async (req, res) => {
  try {
    const { access_token } = req.body;
    if (!access_token) return res.status(400).json({ error: "Missing access_token" });

    console.log(`[AUTH] Validating WGC access_token...`);

    // 🔥 Verify token by calling official WGC Profile API
    const profileResp = await axios.get("https://api.worldgamecommunity.com/Profile/basicinfo", {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    const profile = profileResp.data;
    console.log(`[AUTH] ✅ WGC verified user: ${profile.displayname || profile.username}`);
    const gems = profile.gems ?? 0;
    console.log(`[AUTH] ✅ WGC verified: ${profile.displayname} — gems: ${gems}`);

    // Create / reuse internal user
    // ✅ Use WGC profile.id directly as internal userId
const userId = String(profile.id);

let user = users[userId];

if (!user) {
  user = {
    userId: userId,                   // ✅ STABLE ID
    providerUserId: profile.id,
    username: profile.displayname || profile.username || "Player",
    createdAt: new Date().toISOString()
  };

  users[userId] = user;
} else {
  // ✅ Keep username updated
  user.username = profile.displayname || profile.username || user.username;
}
console.log(`[AUTH] Internal userId: ${user.userId} (WGC id: ${profile.id})`);
    const sessionToken = jwt.sign(
      {
        userId: user.userId,
        username: user.username,
        providerUserId: user.providerUserId,
        wgcAccessToken: access_token   // we can forward it if needed
      },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      success: true,
      token: sessionToken,           // ← Game server JWT for Socket.IO
      user: { userId: user.userId, username: user.username }
    });

  } catch (err) {
    console.error("[AUTH VALIDATE] Failed:", err.response?.data || err.message);
    res.status(401).json({ error: "Invalid or expired WGC token" });
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
      providerUserId: payload.providerUserId,
      wgcAccessToken: payload.wgcAccessToken   // ← THIS WAS MISSING
    };

    console.log("[SOCKET] Auth success:", socket.user.username);
    next();

  } catch (err) {
    console.log("[SOCKET] Auth failed:", err.message);
    next(new Error("Invalid or expired token"));
  }
});

// ========================================
// WAGER SYSTEM
// ========================================

const wagerModule = require("./wager.js");

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
  currentCheckpoint: 0,
  roomCode: null,
  lastUpdateAt: Date.now()
};

  socket.emit("welcome", {
    myId: socket.id,
    userId: socket.user.userId,
    username: socket.user.username
  });

  // Initialize wager handlers for this socket
  wagerModule.initializeWagerHandlers(io, socket, players, rooms);

// ========================================
// WGC PREMIUM CURRENCY HANDLERS (MISSING - THIS IS WHY BALANCE IS 0)
// ========================================

socket.on("requestWGCBalance", async (callback) => {
  try {
    const accessToken = socket.user?.wgcAccessToken;

if (!accessToken) {
  console.error("[WGC BALANCE] Missing WGC token for", socket.user?.username);
  return callback ? callback(null) : null;
}

    // ✅ FIX: gems live in /Profile/basicinfo, not /wallet/balance
    const resp = await axios.get("https://api.worldgamecommunity.com/Profile/basicinfo", {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    const gems = resp.data?.gems ?? 0;
    console.log(`[WGC BALANCE] ${socket.user.username} → ${gems} gems`);

    socket.emit("wgcBalanceResponse", { wgc: gems });
    if (callback) callback({ wgc: gems });

  } catch (err) {
    console.error("[WGC BALANCE ERROR]", err.message);
    if (callback) callback(null);
  }
});

socket.on("spendWGC", async (amount, callback) => {
  try {
    if (!amount || amount <= 0) throw new Error("Invalid amount");

    const accessToken = socket.user?.wgcAccessToken;
    if (!accessToken) throw new Error("No WGC token");

    const resp = await axios.post("https://api.worldgamecommunity.com/wallet/spend", {
      amount: parseFloat(amount),
      reason: "in-game-spend"
    }, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    const newBalance = resp.data?.newBalance ?? resp.data?.wgc ?? 0;

    console.log(`[WGC SPEND] ${socket.user.username} spent ${amount} → ${newBalance}`);

    socket.emit("wgcBalanceResponse", { wgc: newBalance });
    if (callback) callback({ success: true, newBalance });

  } catch (err) {
    console.error("[WGC SPEND ERROR]", err.message);
    if (callback) callback({ success: false, error: err.message });
  }
});


  // ========================================
  // CREATE ROOM
  // ========================================

  socket.on("createRoom", () => {
    try {
      const userId = socket.user.userId;
      const username = socket.user.username;
      const roomCode = createUniqueRoomCode();
      const roomName = username; // default room name

      players[socket.id].roomCode = roomCode;

      rooms[roomCode] = {
  roomCode,
  state: "WAITING", // WAITING | STARTING | RACING | FINISHED
  hostSocketId: socket.id,
    roomName, // ✅ ADD THIS
  hostUserId: userId,
  hostUsername: username,
  selectedScene: "",
  players: [
  {
    socketId: socket.id,
    userId,
    username,
    ready: false
  }
],
  readyPlayers: new Set(),
  raceStartAt: null,
  finishOrder: [],
  finishedPlayers: new Set()
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
    const roomName = data?.roomName; // only for private
    const userId = socket.user.userId;
    const username = socket.user.username;

    if (!roomCode || !rooms[roomCode]) {
      socket.emit("joinError", "Room not found");
      return;
    }

    const room = rooms[roomCode];

    // ✅ If private join (roomName provided), validate name
    if (roomName) {
      if (room.hostUsername !== roomName) {
        socket.emit("joinError", "Room name does not match");
        return;
      }
    }

    if (room.state !== "WAITING") {
      socket.emit("joinError", "Room already started");
      return;
    }

    if (room.players.length >= 6) {
      socket.emit("joinError", "Room is full");
      return;
    }

players[socket.id].roomCode = roomCode;
const alreadyInRoom = room.players.some(p => p.socketId === socket.id);
if (!alreadyInRoom) {
  room.players.push({
    socketId: socket.id,
    userId,
    username,
    ready: false
  });
}
    socket.join(roomCode);

    socket.emit("roomJoined", getRoomStateDto(roomCode));
    io.to(roomCode).emit("roomUpdate", getRoomStateDto(roomCode));

    console.log(`[ROOM JOINED] ${username} → ${roomCode}`);

  } catch (err) {
    console.error("[JOIN ROOM ERROR]", err);
    socket.emit("joinError", "Failed to join room");
  }
});

// ========================================
// TOGGLE READY
// ========================================
socket.on("toggleReady", () => {
  const player = players[socket.id];
  if (!player) return;

  const roomCode = player.roomCode;
  if (!roomCode || !rooms[roomCode]) return;

  const room = rooms[roomCode];

  const roomPlayer = room.players.find(p => p.socketId === socket.id);
  if (!roomPlayer) return;

  roomPlayer.ready = !roomPlayer.ready;

  io.to(roomCode).emit("roomUpdate", getRoomStateDto(roomCode));
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
// UPDATE ROOM NAME (Host Only)
// ========================================
socket.on("updateRoomName", (data) => {
  const player = players[socket.id];
  if (!player) return;

  const roomCode = player.roomCode;
  if (!roomCode || !rooms[roomCode]) return;

  const room = rooms[roomCode];

  if (room.hostSocketId !== socket.id) return;

  room.roomName = data?.roomName || room.roomName;

  io.to(roomCode).emit("roomUpdate", getRoomStateDto(roomCode));
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
room.state = "STARTING";
room.finishOrder = [];
room.finishedPlayers = new Set();
      const startAt = Date.now() + 8000;

      io.to(roomCode).emit("gameStarting", {
        sceneName: room.selectedScene,
        startAt
      });

      room.raceStartAt = startAt;

for (const p of room.players) {
  if (players[p.socketId]) {
    players[p.socketId].currentCheckpoint = 0;
  }
}
// Change state to RACING after countdown
setTimeout(() => {
  if (rooms[roomCode]) {
    rooms[roomCode].state = "RACING";
    console.log(`[RACE STATE] ${roomCode} → RACING`);
  }
}, 8000);

      console.log(`[GAME STARTING] ${roomCode} → ${room.selectedScene} at ${startAt}`);

    } catch (err) {
      console.error("[START GAME ERROR]", err);
    }
  });

  // ========================================
// QUICK MATCH
// ========================================
socket.on("quickMatch", () => {
  try {
    let targetRoom = null;

    for (const code in rooms) {
      const room = rooms[code];
      if (room.state === "WAITING" && room.players.length < 6) {
        targetRoom = room;
        break;
      }
    }

    if (targetRoom) {
      const roomCode = targetRoom.roomCode;

      players[socket.id].roomCode = roomCode;

      const alreadyInRoom = targetRoom.players.some(p => p.socketId === socket.id);
      if (!alreadyInRoom) {
        targetRoom.players.push({
          socketId: socket.id,
          userId: socket.user.userId,
          username: socket.user.username
        });
      }

      socket.join(roomCode);

      socket.emit("roomJoined", getRoomStateDto(roomCode));
      io.to(roomCode).emit("roomUpdate", getRoomStateDto(roomCode));

      console.log(`[QUICK MATCH JOIN] ${socket.user.username} → ${roomCode}`);
    } else {
      // ✅ Directly create room (same logic as createRoom)
      const userId = socket.user.userId;
      const username = socket.user.username;
      const roomCode = createUniqueRoomCode();

      players[socket.id].roomCode = roomCode;

      rooms[roomCode] = {
        roomCode,
        state: "WAITING",
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
        readyPlayers: new Set(),
        raceStartAt: null,
        finishOrder: [],
        finishedPlayers: new Set()
      };

      socket.join(roomCode);

      socket.emit("roomCreated", getRoomStateDto(roomCode));
      io.to(roomCode).emit("roomUpdate", getRoomStateDto(roomCode));

      console.log(`[QUICK MATCH CREATE] ${username} → ${roomCode}`);
    }

  } catch (err) {
    console.error("[QUICK MATCH ERROR]", err);
  }
});

socket.on("getPublicRooms", () => {
  try {
    const publicRooms = [];

    for (const code in rooms) {
      const room = rooms[code];

      if (room.state === "WAITING") {
        publicRooms.push({
          roomCode: room.roomCode,
          hostUsername: room.hostUsername,
          playerCount: room.players.length,
          maxPlayers: 6,
          selectedScene: room.selectedScene || "Not selected"
        });
      }
    }

    socket.emit("publicRoomsList", publicRooms);

  } catch (err) {
    console.error("[GET PUBLIC ROOMS ERROR]", err);
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

  const roomCode = player.roomCode;
  if (!roomCode || !rooms[roomCode]) return;

  const room = rooms[roomCode];

  // ✅ Only validate during race
  if (room.state !== "RACING") {
    player.x = data?.x ?? player.x;
    player.y = data?.y ?? player.y;
    player.z = data?.z ?? player.z;
    player.rotY = data?.rotY ?? player.rotY;
    return;
  }

  const now = Date.now();
  const deltaTime = (now - player.lastUpdateAt) / 1000; // seconds

  if (deltaTime <= 0) return;

  const newX = data?.x ?? player.x;
  const newY = data?.y ?? player.y;
  const newZ = data?.z ?? player.z;

  const dx = newX - player.x;
  const dy = newY - player.y;
  const dz = newZ - player.z;

  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const speed = distance / deltaTime;

  const MAX_ALLOWED_SPEED = 50; // Adjust based on real bike speed

  if (speed > MAX_ALLOWED_SPEED) {
    console.log(`[CHEAT DETECTED] ${player.username} speed=${speed.toFixed(2)}`);
    return; // Reject movement update
  }

  player.x = newX;
  player.y = newY;
  player.z = newZ;
  player.rotY = data?.rotY ?? player.rotY;
  player.lastUpdateAt = now;
});

// ========================================
// CHECKPOINT HIT
// ========================================
socket.on("checkpointHit", (data) => {
  const player = players[socket.id];
  if (!player) return;

  const roomCode = player.roomCode;
  if (!roomCode || !rooms[roomCode]) return;

  const room = rooms[roomCode];

  if (room.state !== "RACING") return;

  const checkpointIndex = data?.checkpointIndex;

  if (typeof checkpointIndex !== "number") return;

  // ✅ Only allow next sequential checkpoint
  if (checkpointIndex === player.currentCheckpoint + 1) {
    player.currentCheckpoint = checkpointIndex;

    console.log(
      `[CHECKPOINT] ${player.username} → ${checkpointIndex}`
    );
  } else {
    console.log(
      `[CHECKPOINT REJECTED] ${player.username} invalid checkpoint ${checkpointIndex}`
    );
  }
});


// ========================================
// RACE FINISH
// ========================================
socket.on("raceFinish", () => {
  try {
    const player = players[socket.id];
    if (!player) return;

    const roomCode = player.roomCode;
    if (!roomCode || !rooms[roomCode]) return;

    const room = rooms[roomCode];

    // ✅ Ensure player is actually in this room
    if (!room.players.some(p => p.socketId === socket.id)) {
      return;
    }

    if (room.state !== "RACING") {
      console.log(`[FINISH REJECTED] Not racing: ${roomCode}`);
      return;
    }

    const userId = socket.user.userId;

    if (room.finishedPlayers.has(userId)) return;

    const REQUIRED_CHECKPOINT = 10;
    if (player.currentCheckpoint < REQUIRED_CHECKPOINT) {
      console.log(`[FINISH REJECTED] ${socket.user.username} skipped checkpoints`);
      return;
    }

    const serverTime = Date.now();
    const MIN_RACE_TIME_MS = 10000;

    if (serverTime - room.raceStartAt < MIN_RACE_TIME_MS) {
      console.log(`[CHEAT DETECTED] ${socket.user.username} finished too early`);
      return;
    }

    room.finishedPlayers.add(userId);

    room.finishOrder.push({
      userId,
      username: socket.user.username,
      finishedAt: serverTime
    });

    console.log(`[RACE FINISH] ${socket.user.username} finished in ${roomCode}`);

    io.to(roomCode).emit("raceUpdate", {
      finishOrder: room.finishOrder
    });

    if (room.finishedPlayers.size >= room.players.length) {
      room.state = "FINISHED";

      console.log(`[RACE COMPLETE] ${roomCode}`);

      io.to(roomCode).emit("raceComplete", {
        results: room.finishOrder
      });

      const wager = require("./wager.js").wagerRooms[roomCode];

      if (wager && wager.state === "Locked") {
        console.log(`[AUTO WAGER PAYOUT] ${roomCode}`);

        const wagerModule = require("./wager.js");

        const formattedResults = room.finishOrder.map((player, index) => ({
          userId: player.userId,
          rank: index + 1,
          teamId: wager.players.find(p => p.userId === player.userId)?.teamId ?? 0
        }));

        const payout = wagerModule.calculatePayout(
          wager,
          formattedResults,
          false
        );

        wager.state = "Completed";

        io.to(roomCode).emit("wagerPayout", payout);

        setTimeout(() => {
          delete wagerModule.wagerRooms[roomCode];
        }, 60000);
      }
    }

  } catch (err) {
    console.error("[RACE FINISH ERROR]", err);
  }
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
  roomName: room.roomName,   // ✅ ADD THIS
  hostId: room.hostUserId,
  hostUsername: room.hostUsername,
  selectedScene: room.selectedScene,
  players: room.players.map(p => ({
    userId: p.userId,
    username: p.username,
    ready: p.ready
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

  // ✅ HANDLE FORFEIT DURING ACTIVE RACE
if (room.state === "RACING") {
  const userId = socket.user?.userId;

  if (userId && !room.finishedPlayers.has(userId)) {
    console.log(`[FORFEIT] ${socket.user.username} disconnected during race`);

    room.finishedPlayers.add(userId);

    room.finishOrder.push({
      userId,
      username: socket.user.username,
      finishedAt: Date.now(),
      forfeit: true
    });

    io.to(roomCode).emit("raceUpdate", {
      finishOrder: room.finishOrder
    });

    // ✅ If all players now accounted for, complete race
    if (room.finishedPlayers.size >= room.players.length) {
      room.state = "FINISHED";

      io.to(roomCode).emit("raceComplete", {
        results: room.finishOrder
      });
    }
  }
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