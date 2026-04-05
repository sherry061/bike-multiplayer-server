const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

app.get("/", (req, res) => {
  res.send("Bike multiplayer server is running");
});

const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

const players = {};
const rooms = {};
let lastBroadcastDebugAt = 0;

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
    hostId: room.hostPlayerId,
    selectedScene: room.selectedScene,
    players: room.players.map(p => p.playerId)
  };
}

io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);

  players[socket.id] = {
    socketId: socket.id,
    playerId: "",
    x: 0,
    y: 0,
    z: 0,
    rotY: 0,
    roomCode: null
  };

  socket.emit("welcome", { myId: socket.id });
  console.log(`[WELCOME] socket=${socket.id}`);

  // CREATE ROOM
  socket.on("createRoom", (data) => {
    try {
      const playerId = data?.playerId || "Player";
      const roomCode = createUniqueRoomCode();

      players[socket.id].playerId = playerId;
      players[socket.id].roomCode = roomCode;

      rooms[roomCode] = {
        roomCode: roomCode,
        hostSocketId: socket.id,
        hostPlayerId: playerId,
        selectedScene: "",
        players: [
          {
            socketId: socket.id,
            playerId: playerId
          }
        ],
        readyPlayers: new Set()
      };

      socket.join(roomCode);

      console.log(`Room created: ${roomCode} by ${playerId}`);
      console.log("[ROOM CREATED DTO]", getRoomStateDto(roomCode));

      socket.emit("roomCreated", getRoomStateDto(roomCode));
      io.to(roomCode).emit("roomUpdate", getRoomStateDto(roomCode));
    } catch (err) {
      console.error("createRoom error:", err);
      socket.emit("joinError", "Failed to create room");
    }
  });

  // JOIN ROOM
  socket.on("joinRoom", (data) => {
    try {
      const roomCode = data?.roomCode;
      const playerId = data?.playerId || "Player";

      if (!roomCode || !rooms[roomCode]) {
        socket.emit("joinError", "Room not found");
        return;
      }

      const room = rooms[roomCode];

      players[socket.id].playerId = playerId;
      players[socket.id].roomCode = roomCode;

      const alreadyInRoom = room.players.some(p => p.socketId === socket.id);
      if (!alreadyInRoom) {
        room.players.push({
          socketId: socket.id,
          playerId: playerId
        });
      }

      // ensure ready set exists
      room.readyPlayers = room.readyPlayers || new Set();

      socket.join(roomCode);

      console.log(`${playerId} joined room ${roomCode}`);
      console.log("[ROOM JOINED DTO]", getRoomStateDto(roomCode));

      socket.emit("roomJoined", getRoomStateDto(roomCode));
      io.to(roomCode).emit("roomUpdate", getRoomStateDto(roomCode));
    } catch (err) {
      console.error("joinRoom error:", err);
      socket.emit("joinError", "Failed to join room");
    }
  });

  // SELECT MAP
  socket.on("selectMap", (data) => {
    try {
      const roomCode = players[socket.id]?.roomCode;
      if (!roomCode || !rooms[roomCode]) return;

      const room = rooms[roomCode];

      if (room.hostSocketId !== socket.id) return;

      room.selectedScene = data?.sceneName || "";

      console.log(
        `[MAP SELECTED] room=${roomCode} host=${players[socket.id]?.playerId} scene=${room.selectedScene}`
      );

      io.to(roomCode).emit("mapSelected", {
        sceneName: room.selectedScene
      });

      io.to(roomCode).emit("roomUpdate", getRoomStateDto(roomCode));
    } catch (err) {
      console.error("selectMap error:", err);
    }
  });

  // START GAME
  socket.on("startGame", () => {
    try {
      const roomCode = players[socket.id]?.roomCode;
      if (!roomCode || !rooms[roomCode]) return;

      const room = rooms[roomCode];

      if (room.hostSocketId !== socket.id) return;
      if (room.players.length < 2) return;
      if (!room.selectedScene) return;

      const startAt = Date.now() + 8000;

      io.to(roomCode).emit("gameStarting", {
        sceneName: room.selectedScene,
        startAt: startAt
      });

      console.log(
        `[START GAME] room=${roomCode} scene=${room.selectedScene} startAt=${startAt} players=${room.players
          .map(p => p.playerId)
          .join(", ")}`
      );
    } catch (err) {
      console.error("startGame error:", err);
    }
  });

  // BIKE READY (replaces sceneReady)
  socket.on("bikeReady", (data) => {
    try {
      const roomCode = data?.roomCode || players[socket.id]?.roomCode;
      if (!roomCode || !rooms[roomCode]) return;

      const room = rooms[roomCode];
      const playerId = players[socket.id]?.playerId;
      if (!playerId) return;

      room.readyPlayers = room.readyPlayers || new Set();
      room.readyPlayers.add(playerId);

      console.log(
        `[BIKE READY] room=${roomCode} playerId=${playerId} ready=${room.readyPlayers.size}/${room.players.length}`
      );

      if (room.readyPlayers.size >= room.players.length) {
        // Optional re-sync start time (ms)
        const startAt = Date.now() + 3000;

        io.to(roomCode).emit("allBikesReady", { startAt });
        console.log(`[ALL BIKES READY] room=${roomCode} startAt=${startAt}`);

        room.readyPlayers.clear();
      }
    } catch (err) {
      console.error("bikeReady error:", err);
    }
  });

  // LEAVE ROOM
  socket.on("leaveRoom", () => {
    handleLeaveRoom(socket);
  });

  // PLAYER MOVE
  socket.on("playerMove", (data) => {
    const player = players[socket.id];

    if (!player) {
      console.log(`[MOVE][IGNORED] unknown socket=${socket.id}`, data);
      return;
    }

    console.log(
      `[MOVE][RECV] socket=${socket.id} playerId=${player.playerId} room=${player.roomCode}`,
      data
    );

    player.x = data?.x ?? 0;
    player.y = data?.y ?? 0;
    player.z = data?.z ?? 0;
    player.rotY = data?.rotY ?? 0;

    if (data?.roomCode && player.roomCode && data.roomCode !== player.roomCode) {
      console.log(
        `[MOVE][WARN] payload roomCode mismatch. payload=${data.roomCode}, player.roomCode=${player.roomCode}`
      );
    }
  });

  // DISCONNECT
  socket.on("disconnect", () => {
    console.log("Player disconnected:", socket.id);
    handleLeaveRoom(socket);
    delete players[socket.id];
    io.emit("playerDisconnected", socket.id);
  });
});

function handleLeaveRoom(socket) {
  const player = players[socket.id];
  if (!player) return;

  const roomCode = player.roomCode;
  if (!roomCode || !rooms[roomCode]) return;

  const room = rooms[roomCode];

  // remove from ready set if present
  if (room.readyPlayers && player.playerId) {
    room.readyPlayers.delete(player.playerId);
  }

  room.players = room.players.filter(p => p.socketId !== socket.id);

  socket.leave(roomCode);

  if (room.hostSocketId === socket.id && room.players.length > 0) {
    room.hostSocketId = room.players[0].socketId;
    room.hostPlayerId = room.players[0].playerId;
  }

  players[socket.id].roomCode = null;

  console.log(`[LEAVE ROOM] socket=${socket.id} playerId=${player.playerId} room=${roomCode}`);

  if (room.players.length === 0) {
    delete rooms[roomCode];
    console.log(`Room deleted: ${roomCode}`);
  } else {
    io.to(roomCode).emit("roomUpdate", getRoomStateDto(roomCode));
  }
}

// ROOM-BASED PLAYER POSITION BROADCAST
setInterval(() => {
  const now = Date.now();
  const shouldDebug = now - lastBroadcastDebugAt >= 1000;

  for (const roomCode in rooms) {
    const room = rooms[roomCode];
    const roomPlayers = {};

    for (const p of room.players) {
      const socketId = p.socketId;

      if (players[socketId]) {
        roomPlayers[p.playerId] = {
          x: players[socketId].x,
          y: players[socketId].y,
          z: players[socketId].z,
          rotY: players[socketId].rotY
        };
      }
    }

    if (shouldDebug) {
      console.log(`[BROADCAST] room=${roomCode}`, roomPlayers);
    }

    io.to(roomCode).emit("playerPositions", roomPlayers);
  }

  if (shouldDebug) {
    lastBroadcastDebugAt = now;
  }
}, 50); // 20 Hz

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});