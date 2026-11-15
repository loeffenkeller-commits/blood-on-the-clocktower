import { DurableObject } from "cloudflare:workers";

interface Player {
  id: string;
  name: string;
  joinedAt: number;
}

interface LobbyState {
  players: Player[];
  phase: string;
}

interface Env {
  ASSETS: Fetcher;
  GAME: DurableObjectNamespace<GameRoom>;
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/ws") {
      const id = env.GAME.idFromName("main-game");
      const room = env.GAME.get(id);
      return room.fetch(request);
    }

    return env.ASSETS.fetch(request);
  }
} satisfies ExportedHandler<Env>;

export class GameRoom extends DurableObject<Env> {
  private state: LobbyState = {
    players: [],
    phase: "Lobby"
  };

  private initialized: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.initialized = this.loadState();
  }

  private async loadState() {
    const saved = await this.ctx.storage.get<LobbyState>("game");

    if (saved) {
      this.state = saved;
    }
  }

  private async saveState() {
    await this.ctx.storage.put("game", this.state);
  }

  async fetch(request: Request): Promise<Response> {
    await this.initialized;

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket connection required", {
        status: 426
      });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.ctx.acceptWebSocket(server);

    server.send(JSON.stringify({
      type: "state",
      state: this.state
    }));

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  async webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer
  ) {
    await this.initialized;

    try {
      const data = JSON.parse(
        typeof message === "string"
          ? message
          : new TextDecoder().decode(message)
      );

      if (data.type === "join") {
        const id = String(data.id || "");
        const name = String(data.name || "").trim().slice(0, 20);

        if (!id || !name) {
          socket.send(JSON.stringify({
            type: "error",
            message: "Enter a valid player name."
          }));
          return;
        }

        const existing = this.state.players.find(
          player => player.id === id
        );

        if (existing) {
          existing.name = name;
        } else {
          if (this.state.players.length >= 15) {
            socket.send(JSON.stringify({
              type: "error",
              message: "This lobby is full."
            }));
            return;
          }

          this.state.players.push({
            id,
            name,
            joinedAt: Date.now()
          });
        }

        await this.saveState();
        this.broadcastState();
      }
    } catch {
      socket.send(JSON.stringify({
        type: "error",
        message: "Invalid request."
      }));
    }
  }

  async webSocketClose(
    _socket: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean
  ) {
    // Players remain in the lobby when they disconnect.
  }

  private broadcastState() {
    const message = JSON.stringify({
      type: "state",
      state: this.state
    });

    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
      } catch {
        // Ignore disconnected sockets.
      }
    }
  }
}
