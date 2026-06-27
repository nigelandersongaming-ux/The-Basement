import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { WebSocketServer, WebSocket } from "ws";

interface PlayerState {
  id: string;
  username: string;
  x: number;
  y: number;
  z: number;
  rotY: number;
  headRotX: number;
  isCrouching: boolean;
  isSprinting: boolean;
  activeItem: string | null;
  isFlashlightOn: boolean;
  isDead: boolean;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Track global game lobby states
  let players: Record<string, PlayerState> = {};
  let collectedKeys: number[] = [];
  let isBarricadeBroken = false;
  let isExitUnlocked = false;
  let currentHostId: string | null = null;
  
  // Track monster sync state
  let monsterSync = {
    x: 0,
    y: 0,
    z: 0,
    rotY: 0,
    state: "WANDER",
  };

  // API routes first
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  // Attach WebSocket server on the same HTTP port
  const wss = new WebSocketServer({ server });

  // Helper to broadcast to all clients except optionally the sender
  const broadcast = (data: any, excludeId?: string) => {
    const payload = JSON.stringify(data);
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        if (!excludeId || (client as any).playerId !== excludeId) {
          client.send(payload);
        }
      }
    });
  };

  wss.on("connection", (ws: WebSocket) => {
    let playerId = Math.random().toString(36).substring(2, 9);
    (ws as any).playerId = playerId;

    console.log(`Player connected: ${playerId}`);

    // If no host, assign this player as host
    if (!currentHostId) {
      currentHostId = playerId;
    }

    // Send initial join configuration
    ws.send(
      JSON.stringify({
        type: "init",
        playerId,
        isHost: playerId === currentHostId,
        collectedKeys,
        isBarricadeBroken,
        isExitUnlocked,
        players,
        monster: monsterSync,
      })
    );

    ws.on("message", (message: string) => {
      try {
        const data = JSON.parse(message);

        switch (data.type) {
          case "join":
            players[playerId] = {
              id: playerId,
              username: data.username || `Player_${playerId}`,
              x: data.x || 0,
              y: data.y || 0,
              z: data.z || 0,
              rotY: data.rotY || 0,
              headRotX: data.headRotX || 0,
              isCrouching: data.isCrouching || false,
              isSprinting: data.isSprinting || false,
              activeItem: data.activeItem || null,
              isFlashlightOn: data.isFlashlightOn !== false,
              isDead: false,
            };
            console.log(`Player ${players[playerId].username} joined the lobby`);
            // Broadcast join to other players
            broadcast({ type: "player_joined", player: players[playerId] }, playerId);
            break;

          case "update":
            if (players[playerId]) {
              Object.assign(players[playerId], data.state);
              // Broadcast state update to everyone else
              broadcast({ type: "player_updated", id: playerId, state: data.state }, playerId);
            }
            break;

          case "key_collected":
            if (!collectedKeys.includes(data.index)) {
              collectedKeys.push(data.index);
              if (collectedKeys.length === 3) {
                isExitUnlocked = true;
              }
              broadcast({ type: "key_collected", index: data.index, collectorId: playerId });
            }
            break;

          case "barricade_broken":
            isBarricadeBroken = true;
            broadcast({ type: "barricade_broken", breakerId: playerId });
            break;

          case "monster_sync":
            // Only accept monster sync updates from the host to avoid conflicts
            if (playerId === currentHostId) {
              monsterSync = {
                x: data.x,
                y: data.y,
                z: data.z,
                rotY: data.rotY,
                state: data.state,
              };
              broadcast({ type: "monster_synced", monster: monsterSync }, playerId);
            }
            break;

          case "player_dead":
            if (players[playerId]) {
              players[playerId].isDead = true;
              broadcast({ type: "player_died", id: playerId });
            }
            break;

          case "chat":
            broadcast({ type: "chat", sender: players[playerId]?.username || "System", text: data.text });
            break;

          case "restart_game":
            // Reset state
            collectedKeys = [];
            isBarricadeBroken = false;
            isExitUnlocked = false;
            for (const id in players) {
              players[id].isDead = false;
            }
            monsterSync = { x: 0, y: 0, z: 0, rotY: 0, state: "WANDER" };
            broadcast({ type: "game_restarted" });
            break;
        }
      } catch (err) {
        console.error("Error processing ws message:", err);
      }
    });

    ws.on("close", () => {
      console.log(`Player disconnected: ${playerId}`);
      delete players[playerId];

      // Broadcast leave
      broadcast({ type: "player_left", id: playerId });

      // Handle host migration if host left
      if (playerId === currentHostId) {
        const remainingPlayerIds = Object.keys(players);
        if (remainingPlayerIds.length > 0) {
          currentHostId = remainingPlayerIds[0];
          broadcast({ type: "host_migrated", hostId: currentHostId });
          console.log(`Host migrated to: ${currentHostId}`);
        } else {
          currentHostId = null;
          // Reset game states when all players leave
          collectedKeys = [];
          isBarricadeBroken = false;
          isExitUnlocked = false;
        }
      }
    });
  });
}

startServer();
