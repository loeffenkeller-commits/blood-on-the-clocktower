
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

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  playerCount: number;
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

const SCRIPT_ROLES: Record<string, Record<string, string[]>> = {
  "trouble-brewing": {
    townsfolk: [
      "Washerwoman", "Librarian", "Investigator", "Chef",
      "Empath", "Fortune Teller", "Undertaker", "Monk",
      "Ravenkeeper", "Virgin", "Slayer", "Soldier", "Mayor"
    ],
    outsiders: ["Butler", "Drunk", "Recluse", "Saint"],
    minions: ["Poisoner", "Spy", "Scarlet Woman", "Baron"],
    demons: ["Imp"]
  },

  "bad-moon-rising": {
    townsfolk: [
      "Grandmother", "Sailor", "Chambermaid", "Exorcist",
      "Innkeeper", "Gambler", "Gossip", "Courtier",
      "Professor", "Minstrel", "Tea Lady", "Pacifist", "Fool"
    ],
    outsiders: ["Tinker", "Moonchild", "Goon", "Lunatic"],
    minions: ["Godfather", "Devil's Advocate", "Assassin", "Mastermind"],
    demons: ["Zombuul", "Pukka", "Shabaloth", "Po"]
  },

  "sects-and-violets": {
    townsfolk: [
      "Snake Charmer", "Flowergirl", "Town Crier", "Oracle",
      "Savant", "Seamstress", "Philosopher", "Artist",
      "Juggler", "Sage", "Clockmaker", "Dreamer", "Mathematician"
    ],
    outsiders: ["Mutant", "Sweetheart", "Barber", "Klutz"],
    minions: ["Evil Twin", "Witch", "Cerenovus", "Pit-Hag"],
    demons: ["Fang Gu", "Vigormortis", "No Dashii", "Vortox"]
  }
};

const ROLE_TYPES: Record<string, string> = {};

for (const script of Object.values(SCRIPT_ROLES)) {
  for (const [type, roles] of Object.entries(script)) {
    for (const role of roles) {
      ROLE_TYPES[role.toLowerCase()] = type;
    }
  }
}

const PLAYER_COUNTS: Record<number, {
  townsfolk: number;
  outsiders: number;
  minions: number;
  demons: number;
}> = {
  5:  { townsfolk: 3, outsiders: 0, minions: 1, demons: 1 },
  6:  { townsfolk: 3, outsiders: 1, minions: 1, demons: 1 },
  7:  { townsfolk: 5, outsiders: 0, minions: 1, demons: 1 },
  8:  { townsfolk: 5, outsiders: 1, minions: 1, demons: 1 },
  9:  { townsfolk: 5, outsiders: 2, minions: 1, demons: 1 },
  10: { townsfolk: 7, outsiders: 0, minions: 2, demons: 1 },
  11: { townsfolk: 7, outsiders: 1, minions: 2, demons: 1 },
  12: { townsfolk: 7, outsiders: 2, minions: 2, demons: 1 },
  13: { townsfolk: 9, outsiders: 0, minions: 3, demons: 1 },
  14: { townsfolk: 9, outsiders: 1, minions: 3, demons: 1 },
  15: { townsfolk: 9, outsiders: 2, minions: 3, demons: 1 }
};

function validateScript(
  settings: GameSettings,
  actualPlayerCount: number
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const script = String(settings.script || "");
  const playerLimit = Number(settings.playerLimit) || 15;

  if (playerLimit < 5 || playerLimit > 15) {
    errors.push("Maximum player count must be between 5 and 15.");
  }

  const playerCount = Math.max(
    5,
    Math.min(15, actualPlayerCount || 5)
  );

  if (actualPlayerCount < 5) {
    warnings.push(
      "Fewer than 5 players are currently in the lobby. Validation is using the 5-player role distribution."
    );
  }

  const requiredCounts = PLAYER_COUNTS[playerCount];

  const selected = Array.isArray(settings.selectedCharacters)
    ? settings.selectedCharacters.map(String)
    : [];

  let rolePool: string[] = [];

  if (script === "custom") {
    if (!selected.length) {
      errors.push(
        "A custom script needs characters selected before it can be verified."
      );
    }
    rolePool = selected;
  } else {
    const builtIn = SCRIPT_ROLES[script];

    if (!builtIn) {
      errors.push("The selected script is not recognized.");
    } else {
      const allRoles = Object.values(builtIn).flat();
      rolePool = selected.length ? selected : allRoles;

      if (selected.length) {
        const invalid = selected.filter(
          role => !allRoles.includes(role)
        );

        if (invalid.length) {
          errors.push(
            "These characters do not belong to the selected script: " +
            invalid.join(", ")
          );
        }
      }
    }
  }

  const normalized = rolePool.map(role => role.toLowerCase());
  const duplicates = normalized.filter(
    (role, index) => normalized.indexOf(role) !== index
  );

  if (duplicates.length) {
    errors.push(
      "Duplicate character selections: " +
      [...new Set(duplicates)].join(", ")
    );
  }

  const counts = {
    townsfolk: 0,
    outsiders: 0,
    minions: 0,
    demons: 0
  };

  const unknownRoles: string[] = [];

  for (const role of rolePool) {
    const type = ROLE_TYPES[role.toLowerCase()];

    if (!type) {
      unknownRoles.push(role);
      continue;
    }

    if (type in counts) {
      counts[type as keyof typeof counts]++;
    }
  }

  if (unknownRoles.length) {
    warnings.push(
      "These characters have no built-in role category for validation: " +
      [...new Set(unknownRoles)].join(", ")
    );
  }

  for (const type of Object.keys(requiredCounts) as Array<
    keyof typeof requiredCounts
  >) {
    if (counts[type] < requiredCounts[type]) {
      errors.push(
        `Not enough ${type}: need ${requiredCounts[type]}, but only have ${counts[type]}.`
      );
    }
  }

  if (settings.includeTravellers) {
    warnings.push(
      "Travellers are not included in the standard player role distribution check."
    );
  }

  if (settings.includeExperimental) {
    warnings.push(
      "Experimental characters may need additional manual rules verification."
    );
  }

  if (script === "custom" && !String(settings.customScriptName || "").trim()) {
    warnings.push("Consider giving your custom script a name.");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    playerCount
  };
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

        if (id === this.state.tellerId) {
          return this.sendError(
            socket,
            "The Game Teller cannot also join as a player."
          );
        }

        const existing = this.state.players.find(
          player => player.id === id
        );

        if (existing) {
          existing.name = name;
        } else {
          const limit = Number(this.state.settings.playerLimit) || 15;

          if (
            this.state.players.length >=
            Math.min(15, Math.max(5, limit))
          ) {
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
          return this.sendError(
            socket,
            "Enter a valid Game Teller name."
          );
        }

        if (this.state.players.some(player => player.id === id)) {
          return this.sendError(
            socket,
            "You have already joined as a player."
          );
        }

        if (
          this.state.tellerId &&
          this.state.tellerId !== id
        ) {
          return this.sendError(
            socket,
            "A Game Teller has already been selected."
          );
        }

        this.state.tellerId = id;
        this.state.tellerName = name;

        await this.saveState();
        this.broadcastState();
        return;
      }

      if (data.type === "saveSettings") {
        if (!id || id !== this.state.tellerId) {
          return this.sendError(
            socket,
            "Only the selected Game Teller can change settings."
          );
        }

        if (
          !data.settings ||
          typeof data.settings !== "object" ||
          Array.isArray(data.settings)
        ) {
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
        return;
      }

      if (data.type === "verifyScript") {
        if (!id || id !== this.state.tellerId) {
          return this.sendError(
            socket,
            "Only the selected Game Teller can verify the script."
          );
        }

        const proposedSettings =
          data.settings &&
          typeof data.settings === "object" &&
          !Array.isArray(data.settings)
            ? {
                ...DEFAULT_SETTINGS,
                ...data.settings
              }
            : this.state.settings;

        const result = validateScript(
          proposedSettings,
          this.state.players.length
        );

        socket.send(JSON.stringify({
          type: "validation",
          result
        }));
        return;
      }

      if (data.type === "kickPlayer") {
        if (!id || id !== this.state.tellerId) {
          return this.sendError(
            socket,
            "Only the selected Game Teller can remove players."
          );
        }

        const targetId = String(data.targetId || "");

        if (!targetId) {
          return this.sendError(socket, "No player was selected.");
        }

        const target = this.state.players.find(
          player => player.id === targetId
        );

        if (!target) {
          return this.sendError(
            socket,
            "That player is no longer in the lobby."
          );
        }

        this.state.players = this.state.players.filter(
          player => player.id !== targetId
        );

        await this.saveState();
        this.broadcastState();

        socket.send(JSON.stringify({
          type: "saved",
          message: `${target.name} was removed from the lobby.`
        }));
        return;
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
