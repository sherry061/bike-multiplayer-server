/**
 * Wager System Extension for Bike Multiplayer Server
 * Handles wagering logic, state management, and integration with WGC API
 */

const axios = require("axios");

// ========================================
// WAGER CONFIGURATION
// ========================================

const WAGER_CONFIG = {
  MIN_WAGER_AMOUNT: 100,
  MAX_WAGER_AMOUNT: 10000,
  HOUSE_FEE_PERCENTAGE: 0.05, // 5%
  WINNER_PERCENTAGE: 0.95 // 95% to winner(s)
};

// ========================================
// WAGER STATE
// ========================================

const wagerRooms = {}; // roomCode -> wager data

// Wager state enum
const WagerState = {
  NONE: "None",
  PENDING: "Pending",
  COLLECTING: "Collecting",
  LOCKED: "Locked",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled"
};

// ========================================
// WAGER HANDLERS
// ========================================

function initializeWagerHandlers(io, socket, players, rooms) {

  // ----------------------------------------
  // CREATE WAGER (Host only)
  // ----------------------------------------
  socket.on("wagerCreate", (data) => {
    try {
      const roomCode = players[socket.id]?.roomCode;
      if (!roomCode || !rooms[roomCode]) {
        socket.emit("wagerError", { error: "Not in a room" });
        return;
      }

      const room = rooms[roomCode];

      // Only host can create wager
      if (room.hostSocketId !== socket.id) {
        socket.emit("wagerError", { error: "Only host can create wager" });
        return;
      }

      // Check if wager already exists
      if (wagerRooms[roomCode]) {
        socket.emit("wagerError", { error: "Wager already exists for this room" });
        return;
      }

      const amount = parseFloat(data.amount);

      // Validate amount
      if (isNaN(amount) || amount < WAGER_CONFIG.MIN_WAGER_AMOUNT || amount > WAGER_CONFIG.MAX_WAGER_AMOUNT) {
        socket.emit("wagerError", {
          error: `Amount must be between ${WAGER_CONFIG.MIN_WAGER_AMOUNT} and ${WAGER_CONFIG.MAX_WAGER_AMOUNT}`
        });
        return;
      }

      // Create wager data
      wagerRooms[roomCode] = {
        roomCode: roomCode,
        wagerAmount: amount,
        state: WagerState.COLLECTING,
        hostUserId: socket.user.userId,
        hostUsername: socket.user.username,
        createdAt: new Date(),
        lockedAt: null,
        completedAt: null,
        players: [],
        totalPot: 0,
        houseFee: 0,
        prizePool: 0
      };

      console.log(`[WAGER CREATED] ${roomCode} - Amount: ${amount} SGC`);

      // Notify room
      io.to(roomCode).emit("wagerCreated", {
        roomCode: roomCode,
        amount: amount,
        state: WagerState.COLLECTING,
        hostUserId: socket.user.userId
      });

    } catch (err) {
      console.error("[WAGER CREATE ERROR]", err);
      socket.emit("wagerError", { error: "Failed to create wager" });
    }
  });

  // ----------------------------------------
  // JOIN WAGER
  // ----------------------------------------
  socket.on("wagerJoin", () => {
    try {
      const roomCode = players[socket.id]?.roomCode;
      if (!roomCode || !rooms[roomCode]) {
        socket.emit("wagerError", { error: "Not in a room" });
        return;
      }

      const wager = wagerRooms[roomCode];
      if (!wager) {
        socket.emit("wagerError", { error: "No wager in this room" });
        return;
      }

      if (wager.state !== WagerState.COLLECTING) {
        socket.emit("wagerError", { error: "Wager is not accepting players" });
        return;
      }

      // Check if already joined
      if (wager.players.some(p => p.userId === socket.user.userId)) {
        socket.emit("wagerError", { error: "Already joined wager" });
        return;
      }

      // Add player to wager
      const playerData = {
        userId: socket.user.userId,
        username: socket.user.username,
        socketId: socket.id,
        hasPaid: false,
        transactionId: null,
        paidAt: null,
        teamId: getPlayerTeam(rooms[roomCode], socket.user.userId)
      };

      wager.players.push(playerData);

      console.log(`[WAGER JOIN] ${socket.user.username} joined ${roomCode}`);

      // Notify player
      socket.emit("wagerJoined", {
        roomCode: roomCode,
        amount: wager.wagerAmount,
        state: wager.state
      });

      // Broadcast to room
      io.to(roomCode).emit("wagerPlayerJoined", {
        userId: socket.user.userId,
        username: socket.user.username,
        paidCount: wager.players.filter(p => p.hasPaid).length,
        totalPlayers: wager.players.length
      });

    } catch (err) {
      console.error("[WAGER JOIN ERROR]", err);
      socket.emit("wagerError", { error: "Failed to join wager" });
    }
  });

  // ----------------------------------------
  // PAY ENTRY FEE
  // ----------------------------------------
  socket.on("wagerPay", (data) => {
    try {
      const roomCode = players[socket.id]?.roomCode;
      if (!roomCode || !rooms[roomCode]) {
        socket.emit("wagerError", { error: "Not in a room" });
        return;
      }

      const wager = wagerRooms[roomCode];
      if (!wager) {
        socket.emit("wagerError", { error: "No wager in this room" });
        return;
      }

      const player = wager.players.find(p => p.userId === socket.user.userId);
      if (!player) {
        socket.emit("wagerError", { error: "Not in wager" });
        return;
      }

      if (player.hasPaid) {
        socket.emit("wagerError", { error: "Already paid" });
        return;
      }

      // Mark as paid (actual WGC API call should happen here)
      player.hasPaid = true;
      player.transactionId = data.transactionId || `TX_${Date.now()}_${socket.user.userId}`;
      player.paidAt = new Date();

      // Update totals
      updateWagerTotals(wager);

      console.log(`[WAGER PAID] ${socket.user.username} paid ${wager.wagerAmount} SGC for ${roomCode}`);

      // Notify player
      socket.emit("wagerPaymentConfirmed", {
        transactionId: player.transactionId,
        amount: wager.wagerAmount
      });

      // Broadcast to room
      io.to(roomCode).emit("wagerPlayerPaid", {
        userId: socket.user.userId,
        username: socket.user.username,
        paidCount: wager.players.filter(p => p.hasPaid).length,
        totalPlayers: wager.players.length,
        totalPot: wager.totalPot
      });

      // Check if all paid
      if (wager.players.every(p => p.hasPaid)) {
        io.to(roomCode).emit("wagerAllPaid", {
          totalPot: wager.totalPot,
          playerCount: wager.players.length
        });
      }

    } catch (err) {
      console.error("[WAGER PAY ERROR]", err);
      socket.emit("wagerError", { error: "Payment failed" });
    }
  });

  // ----------------------------------------
  // LOCK WAGER (Host only, when race starts)
  // ----------------------------------------
  socket.on("wagerLock", () => {
    try {
      const roomCode = players[socket.id]?.roomCode;
      if (!roomCode || !rooms[roomCode]) {
        return;
      }

      const room = rooms[roomCode];
      const wager = wagerRooms[roomCode];

      if (!wager) return;

      // Only host can lock
      if (room.hostSocketId !== socket.id) {
        socket.emit("wagerError", { error: "Only host can lock wager" });
        return;
      }

      if (wager.state !== WagerState.COLLECTING) {
        socket.emit("wagerError", { error: "Wager cannot be locked" });
        return;
      }

      // Check if all players paid
      const unpaidPlayers = wager.players.filter(p => !p.hasPaid);
      if (unpaidPlayers.length > 0) {
        socket.emit("wagerError", {
          error: `${unpaidPlayers.length} players haven't paid`,
          unpaidPlayers: unpaidPlayers.map(p => p.username)
        });
        return;
      }

      // Lock wager
      wager.state = WagerState.LOCKED;
      wager.lockedAt = new Date();
      updateWagerTotals(wager);

      console.log(`[WAGER LOCKED] ${roomCode} - Pot: ${wager.totalPot} SGC`);

      // Notify room
      io.to(roomCode).emit("wagerLocked", {
        totalPot: wager.totalPot,
        houseFee: wager.houseFee,
        prizePool: wager.prizePool,
        playerCount: wager.players.length
      });

    } catch (err) {
      console.error("[WAGER LOCK ERROR]", err);
      socket.emit("wagerError", { error: "Failed to lock wager" });
    }
  });

  // ----------------------------------------
  // CANCEL WAGER (Host only)
  // ----------------------------------------
  socket.on("wagerCancel", () => {
    try {
      const roomCode = players[socket.id]?.roomCode;
      if (!roomCode || !rooms[roomCode]) {
        return;
      }

      const room = rooms[roomCode];
      const wager = wagerRooms[roomCode];

      if (!wager) return;

      // Only host can cancel
      if (room.hostSocketId !== socket.id) {
        socket.emit("wagerError", { error: "Only host can cancel wager" });
        return;
      }

      if (wager.state === WagerState.LOCKED) {
        socket.emit("wagerError", { error: "Cannot cancel locked wager" });
        return;
      }

      // Refund all paid players
      const paidPlayers = wager.players.filter(p => p.hasPaid);

      for (const player of paidPlayers) {
        // Trigger refund via WGC API (placeholder)
        console.log(`[WAGER REFUND] ${player.username}: ${wager.wagerAmount} SGC`);
      }

      wager.state = WagerState.CANCELLED;

      console.log(`[WAGER CANCELLED] ${roomCode} - Refunded ${paidPlayers.length} players`);

      // Notify room
      io.to(roomCode).emit("wagerCancelled", {
        refundedCount: paidPlayers.length
      });

      // Clean up
      delete wagerRooms[roomCode];

    } catch (err) {
      console.error("[WAGER CANCEL ERROR]", err);
      socket.emit("wagerError", { error: "Failed to cancel wager" });
    }
  });

  // ----------------------------------------
  // HANDLE DISCONNECT
  // ----------------------------------------
  socket.on("disconnect", () => {
    const roomCode = players[socket.id]?.roomCode;
    if (!roomCode) return;

    const wager = wagerRooms[roomCode];
    if (!wager) return;

    const player = wager.players.find(p => p.userId === socket.user?.userId);
    if (!player) return;

    // If wager is locked, player forfeits
    if (wager.state === WagerState.LOCKED && player.hasPaid) {
      player.result = "Forfeit";
      console.log(`[WAGER FORFEIT] ${player.username} disconnected during race`);

      io.to(roomCode).emit("wagerPlayerForfeit", {
        userId: player.userId,
        username: player.username
      });
    }

    // If wager is collecting, remove player
    if (wager.state === WagerState.COLLECTING) {
      wager.players = wager.players.filter(p => p.userId !== socket.user?.userId);

      io.to(roomCode).emit("wagerPlayerLeft", {
        userId: socket.user?.userId,
        username: socket.user?.username,
        remainingPlayers: wager.players.length
      });

      // Clean up if empty
      if (wager.players.length === 0) {
        delete wagerRooms[roomCode];
      }
    }
  });
}

// ========================================
// HELPER FUNCTIONS
// ========================================

function updateWagerTotals(wager) {
  const paidCount = wager.players.filter(p => p.hasPaid).length;
  wager.totalPot = paidCount * wager.wagerAmount;
  wager.houseFee = wager.totalPot * WAGER_CONFIG.HOUSE_FEE_PERCENTAGE;
  wager.prizePool = wager.totalPot * WAGER_CONFIG.WINNER_PERCENTAGE;
}

function getPlayerTeam(room, userId) {
  // Team logic based on player position in room
  const playerIndex = room.players.findIndex(p => p.userId === userId);
  if (playerIndex === -1) return -1;
  return playerIndex < 4 ? 0 : 1; // 0 = Red, 1 = Blue
}

function calculatePayout(wager, results, isTeamMatch) {
  const payout = {
    roomCode: wager.roomCode,
    totalPrize: wager.prizePool,
    houseFee: wager.houseFee,
    winners: [],
    losers: [],
    winningTeam: "Individual"
  };

  // Sort results by rank
  const sortedResults = results.sort((a, b) => a.rank - b.rank);

  if (isTeamMatch) {
    // Team match - winning team splits pot
    if (sortedResults.length > 0) {
      const firstPlace = sortedResults[0];
      const winningTeamId = firstPlace.teamId;
      payout.winningTeam = winningTeamId === 0 ? "Red" : "Blue";

      const winningTeamPlayers = wager.players.filter(
        p => p.hasPaid && p.teamId === winningTeamId
      );

      if (winningTeamPlayers.length > 0) {
        const sharePerPlayer = wager.prizePool / winningTeamPlayers.length;

        for (const player of winningTeamPlayers) {
          const result = sortedResults.find(r => r.userId === player.userId);
          payout.winners.push({
            userId: player.userId,
            username: player.username,
            amount: sharePerPlayer,
            rank: result?.rank || 0
          });
        }
      }

      // Losers
      const losingTeamPlayers = wager.players.filter(
        p => p.hasPaid && p.teamId !== winningTeamId
      );

      for (const player of losingTeamPlayers) {
        const result = sortedResults.find(r => r.userId === player.userId);
        payout.losers.push({
          userId: player.userId,
          username: player.username,
          amount: 0,
          rank: result?.rank || 0
        });
      }
    }
  } else {
    // Individual match - winner takes all
    if (sortedResults.length > 0) {
      const winner = sortedResults[0];
      const winnerData = wager.players.find(p => p.userId === winner.userId);

      if (winnerData && winnerData.hasPaid) {
        payout.winners.push({
          userId: winner.userId,
          username: winnerData.username,
          amount: wager.prizePool,
          rank: 1
        });
      }

      // Losers
      for (let i = 1; i < sortedResults.length; i++) {
        const result = sortedResults[i];
        const playerData = wager.players.find(p => p.userId === result.userId);

        if (playerData && playerData.hasPaid) {
          payout.losers.push({
            userId: result.userId,
            username: playerData.username,
            amount: 0,
            rank: result.rank
          });
        }
      }
    }
  }

  return payout;
}

// ========================================
// MODULE EXPORTS
// ========================================

module.exports = {
  initializeWagerHandlers,
  WagerState,
  WAGER_CONFIG,
  wagerRooms
};
