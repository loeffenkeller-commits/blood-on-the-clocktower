
import { DurableObject } from "cloudflare:workers";

interface Player {
  id: string;
  name: string;
  joinedAt: number;
}

interface GameSettings {
  [key: string]: unknown;
}

interface LobbyState {
  players: Player[];
  phase: string;
  tellerId: string | null;
  tellerName: string | null;
  settings: GameSettings;
}

interface Env {
  ASSETS: Fetcher;
  GAME: DurableObjectNamespace<GameRoom>;
}

const DEFAULT_SETTINGS: GameSettings = {
  script: "trouble-brewing",
  playerLimit: 15,
  roleAssignment: "random",
  includeTravellers: false,
  includeFabled: false,
  includeExperimental: false,
  customScriptName: "",
  selectedCharacters: [],
  firstNightMinutes: 8,
  otherNightMinutes: 6,
  dayDiscussionMinutes: 8,
  nominationMinutes: 5,
  votingSeconds: 30,
  executionMinutes: 2,
  announcePhaseChanges: true,
  showTimers: true,
  allowDeadPlayersToSpeak: true,
  deadPlayersKeepVote: true,
  nominationsPerDay: 0,
  tieHandling: "no-execution",
  allowSelfNomination: false,
  allowRepeatNominations: false,
  automaticPhaseProgression: false,
  automaticVoting: true,
  automaticExecution: false,
  automaticVictoryCheck: true,
  pauseForUnsupportedAbilities: true,
  storytellerCanOverride: true,
  allowRoleChanges: true,
  allowResurrection: true,
  allowManualDeaths: true,
  allowManualInformation: true,
  revealExecutedRole: true,
  revealDeathCause: false,
  gameVisibility: "unlisted",
  allowLateJoin: false,
  reconnectGraceMinutes: 10,
  retainGameHistory: true,
  clearPrivateNotesAtEnd: true,
  enablePersonalNotes: true,
  enableSuspicionTokens: true,
  enableScreenSafeMode: true,
  confirmDestructiveActions: true
};

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
    phase: "Lobby",
    tellerId: null,
    tellerName: null,
    settings: DEFAULT_SETTINGS
  };

  private initialized: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.initialized = this.loadState();
  }

  private async loadState() {
    const saved = await this.ctx.storage.get<LobbyState>("game");

    if (saved) {
      this.state = {
        ...this.state,
        ...saved,
        settings: {
          ...DEFAULT_SETTINGS,
          ...(saved.settings || {})
        }
      };
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
      state: this.publicState()
    }));

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  private publicState() {
    return {
      players: this.state.players,
      phase: this.state.phase,
      tellerId: this.state.tellerId,
      tellerName: this.state.tellerName,
      settings: this.state.settings
    };
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

      const id = String(data.id || "");
      const name = String(data.name || "").trim().slice(0, 20);

      if (data.type === "join") {
        if (!id || !name) {
          return this.sendError(socket, "Enter a valid player name.");
        }

        const existing = this.state.players.find(
          player => player.id === id
        );

        if (existing) {
          existing.name = name;
        } else {
          const limit = Number(this.state.settings.playerLimit) || 15;

          if (this.state.players.length >= Math.min(15, Math.max(5, limit))) {
            return this.sendError(socket, "This lobby is full.");
          }

          this.state.players.push({
            id,
            name,
            joinedAt: Date.now()
          });
        }

        await this.saveState();
        this.broadcastState();
        return;
      }

      if (data.type === "claimTeller") {
        if (!id || !name) {
          return this.sendError(socket, "Enter a valid Game Teller name.");
        }

        if (this.state.tellerId && this.state.tellerId !== id) {
          return this.sendError(socket, "A Game Teller has already been selected.");
        }

        this.state.tellerId = id;
        this.state.tellerName = name;

        await this.saveState();
        this.broadcastState();
        return;
      }

      if (data.type === "saveSettings") {
        if (!id || id !== this.state.tellerId) {
          return this.sendError(socket, "Only the selected Game Teller can change settings.");
        }

        if (!data.settings || typeof data.settings !== "object") {
          return this.sendError(socket, "Invalid settings.");
        }

        const serialized = JSON.stringify(data.settings);

        if (serialized.length > 20000) {
          return this.sendError(socket, "Settings are too large.");
        }

        this.state.settings = {
          ...DEFAULT_SETTINGS,
          ...data.settings
        };

        await this.saveState();
        this.broadcastState();

        socket.send(JSON.stringify({
          type: "saved"
        }));
      }
    } catch {
      this.sendError(socket, "Invalid request.");
    }
  }

  private sendError(socket: WebSocket, message: string) {
    try {
      socket.send(JSON.stringify({
        type: "error",
        message
      }));
    } catch {}
  }

  async webSocketClose() {
    // A disconnect does not remove a player or Game Teller.
  }

  private broadcastState() {
    const message = JSON.stringify({
      type: "state",
      state: this.publicState()
    });

    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
      } catch {}
    }
  }
}
