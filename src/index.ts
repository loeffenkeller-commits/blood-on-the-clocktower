
import { DurableObject } from "cloudflare:workers";

interface Player {
  id: string;
  name: string;
  joinedAt: number;
}

interface GameSettings {
  [key: string]: unknown;
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  roleCounts: {
    Townsfolk: number;
    Outsider: number;
    Minion: number;
    Demon: number;
  };
}

interface LobbyState {
  players: Player[];
  phase: string;
  tellerId: string | null;
  tellerName: string | null;
  settings: GameSettings;
  kickedPlayers: string[];
}

interface Env {
  ASSETS: Fetcher;
  GAME: DurableObjectNamespace<GameRoom>;
}

type RoleType = "Townsfolk" | "Outsider" | "Minion" | "Demon";

interface ScriptDefinition {
  name: string;
  roles: Record<RoleType, string[]>;
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

const SCRIPTS: Record<string, ScriptDefinition> = {
  "trouble-brewing": {
    name: "Trouble Brewing",
    roles: {
      Townsfolk: [
        "Washerwoman",
        "Librarian",
        "Investigator",
        "Chef",
        "Empath",
        "Fortune Teller",
        "Undertaker",
        "Monk",
        "Ravenkeeper",
        "Virgin",
        "Slayer",
        "Soldier",
        "Mayor"
      ],
      Outsider: [
        "Butler",
        "Drunk",
        "Recluse",
        "Saint"
      ],
      Minion: [
        "Poisoner",
        "Spy",
        "Baron",
        "Scarlet Woman"
      ],
      Demon: [
        "Imp"
      ]
    }
  },

  "bad-moon-rising": {
    name: "Bad Moon Rising",
    roles: {
      Townsfolk: [
        "Grandmother",
        "Sailor",
        "Chambermaid",
        "Exorcist",
        "Innkeeper",
        "Gambler",
        "Gossip",
        "Courtier",
        "Professor",
        "Minstrel",
        "Tea Lady",
        "Pacifist",
        "Fool"
      ],
      Outsider: [
        "Goon",
        "Lunatic",
        "Tinker",
        "Moonchild"
      ],
      Minion: [
        "Godfather",
        "Devil's Advocate",
        "Assassin",
        "Mastermind"
      ],
      Demon: [
        "Zombuul",
        "Pukka",
        "Shabaloth",
        "Po"
      ]
    }
  },

  "sects-and-violets": {
    name: "Sects & Violets",
    roles: {
      Townsfolk: [
        "Clockmaker",
        "Dreamer",
        "Snake Charmer",
        "Mathematician",
        "Flowergirl",
        "Town Crier",
        "Oracle",
        "Savant",
        "Seamstress",
        "Philosopher",
        "Artist",
        "Juggler",
        "Sage"
      ],
      Outsider: [
        "Mutant",
        "Sweetheart",
        "Barber",
        "Klutz"
      ],
      Minion: [
        "Evil Twin",
        "Witch",
        "Cerenovus",
        "Pit-Hag"
      ],
      Demon: [
        "Fang Gu",
        "Vigormortis",
        "No Dashii",
        "Vortox"
      ]
    }
  }
};

const PLAYER_COUNTS: Record<number, {
  Townsfolk: number;
  Outsider: number;
  Minion: number;
  Demon: number;
}> = {
  5:  { Townsfolk: 3, Outsider: 0, Minion: 1, Demon: 1 },
  6:  { Townsfolk: 3, Outsider: 1, Minion: 1, Demon: 1 },
  7:  { Townsfolk: 5, Outsider: 0, Minion: 1, Demon: 1 },
  8:  { Townsfolk: 5, Outsider: 1, Minion: 1, Demon: 1 },
  9:  { Townsfolk: 5, Outsider: 2, Minion: 1, Demon: 1 },
  10: { Townsfolk: 7, Outsider: 0, Minion: 2, Demon: 1 },
  11: { Townsfolk: 7, Outsider: 1, Minion: 2, Demon: 1 },
  12: { Townsfolk: 7, Outsider: 2, Minion: 2, Demon: 1 },
  13: { Townsfolk: 9, Outsider: 0, Minion: 3, Demon: 1 },
  14: { Townsfolk: 9, Outsider: 1, Minion: 3, Demon: 1 },
  15: { Townsfolk: 9, Outsider: 2, Minion: 3, Demon: 1 }
};

function cloneDefaults(): GameSettings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

function getRoleType(
  roleName: string,
  script: ScriptDefinition
): RoleType | null {
  for (const type of Object.keys(script.roles) as RoleType[]) {
    if (script.roles[type].includes(roleName)) {
      return type;
    }
  }

  return null;
}

function validateScript(
  settings: GameSettings,
  actualPlayerCount: number
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const roleCounts = {
    Townsfolk: 0,
    Outsider: 0,
    Minion: 0,
    Demon: 0
  };

  const scriptId = String(settings.script || "");
  const script = SCRIPTS[scriptId];

  if (!script && scriptId !== "custom") {
    errors.push("The selected script does not exist.");
  }

  const playerLimit = Number(settings.playerLimit);

  if (
    !Number.isInteger(playerLimit) ||
    playerLimit < 5 ||
    playerLimit > 15
  ) {
    errors.push("Player limit must be a whole number between 5 and 15.");
  }

  const selected = settings.selectedCharacters;

  if (!Array.isArray(selected)) {
    errors.push("Character selection must be a list.");
    return { valid: false, errors, warnings, roleCounts };
  }

  const selectedCharacters = selected.map(String);

  if (new Set(selectedCharacters).size !== selectedCharacters.length) {
    errors.push("The character selection contains duplicates.");
  }

  let availableRoles: Record<RoleType, string[]> = {
    Townsfolk: [],
    Outsider: [],
    Minion: [],
    Demon: []
  };

  if (script) {
    availableRoles = script.roles;
  } else if (scriptId === "custom") {
    if (selectedCharacters.length === 0) {
      errors.push("A custom script needs at least one selected character.");
    }

    for (const roleName of selectedCharacters) {
      let found = false;

      for (const definition of Object.values(SCRIPTS)) {
        const roleType = getRoleType(roleName, definition);

        if (roleType) {
          availableRoles[roleType].push(roleName);
          found = true;
          break;
        }
      }

      if (!found) {
        errors.push(`Unknown character: ${roleName}`);
      }
    }
  }

  const rolePool = selectedCharacters.length > 0
    ? selectedCharacters
    : Object.values(availableRoles).flat();

  for (const roleName of rolePool) {
    const roleType = getRoleType(roleName, {
      name: "validation",
      roles: availableRoles
    });

    if (!roleType) {
      errors.push(`Character "${roleName}" is not part of the selected script.`);
      continue;
    }

    roleCounts[roleType]++;
  }

  if (roleCounts.Townsfolk < 1) {
    errors.push("The script needs at least one Townsfolk character.");
  }

  if (roleCounts.Minion < 1) {
    errors.push("The script needs at least one Minion character.");
  }

  if (roleCounts.Demon < 1) {
    errors.push("The script needs at least one Demon character.");
  }

  if (Number.isInteger(playerLimit) && PLAYER_COUNTS[playerLimit]) {
    const required = PLAYER_COUNTS[playerLimit];

    for (const type of Object.keys(required) as RoleType[]) {
      if (roleCounts[type] < required[type]) {
        errors.push(
          `Not enough ${type} characters for ${playerLimit} players. ` +
          `Required: ${required[type]}; available: ${roleCounts[type]}.`
        );
      }
    }
  }

  if (actualPlayerCount < 5) {
    warnings.push(
      "The lobby currently has fewer than 5 players. " +
      "The script is being checked against the configured player limit."
    );
  }

  if (actualPlayerCount > playerLimit) {
    errors.push("The current lobby has more players than the configured limit.");
  }

  if (scriptId === "custom" && !String(settings.customScriptName || "").trim()) {
    warnings.push("Consider giving your custom script a name.");
  }

  if (settings.includeExperimental) {
    warnings.push(
      "Experimental characters are not included in the built-in character database."
    );
  }

  if (settings.includeTravellers) {
    warnings.push(
      "Traveller support is not yet implemented in the game engine."
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    roleCounts
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
    settings: cloneDefaults(),
    kickedPlayers: []
  };

  private initialized: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.initialized = this.loadState();
  }

  private async loadState() {
    const saved = await this.ctx.storage.get<Partial<LobbyState>>("game");

    if (saved) {
      this.state = {
        ...this.state,
        ...saved,
        players: saved.players || [],
        kickedPlayers: saved.kickedPlayers || [],
        settings: {
          ...cloneDefaults(),
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

      if (!id) {
        return this.sendError(socket, "Missing player identity.");
      }

      if (data.type === "join") {
        if (!name) {
          return this.sendError(socket, "Enter a valid player name.");
        }

        if (this.state.kickedPlayers.includes(id)) {
          return this.sendError(
            socket,
            "You have been removed from this game."
          );
        }

        if (this.state.tellerId === id) {
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
        if (!name) {
          return this.sendError(socket, "Enter a valid Game Teller name.");
        }

        if (this.state.players.some(player => player.id === id)) {
          return this.sendError(
            socket,
            "Leave the player list before becoming Game Teller."
          );
        }

        if (this.state.tellerId && this.state.tellerId !== id) {
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
        if (!this.isTeller(id)) {
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

        const proposedSettings = {
          ...this.state.settings,
          ...data.settings
        };

        const validation = validateScript(
          proposedSettings,
          this.state.players.length
        );

        if (!validation.valid) {
          socket.send(JSON.stringify({
            type: "validation",
            result: validation
          }));

          return this.sendError(
            socket,
            "Settings were not saved. Fix the script validation errors first."
          );
        }

        this.state.settings = proposedSettings;

        await this.saveState();
        this.broadcastState();

        socket.send(JSON.stringify({
          type: "saved"
        }));

        return;
      }

      if (data.type === "verifyScript") {
        if (!this.isTeller(id)) {
          return this.sendError(
            socket,
            "Only the Game Teller can verify the script."
          );
        }

        const result = validateScript(
          this.state.settings,
          this.state.players.length
        );

        socket.send(JSON.stringify({
          type: "validation",
          result
        }));

        return;
      }

      if (data.type === "kickPlayer") {
        if (!this.isTeller(id)) {
          return this.sendError(
            socket,
            "Only the Game Teller can remove players."
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
          return this.sendError(socket, "That player is not in the lobby.");
        }

        this.state.players = this.state.players.filter(
          player => player.id !== targetId
        );

        if (!this.state.kickedPlayers.includes(targetId)) {
          this.state.kickedPlayers.push(targetId);
        }

        await this.saveState();
        this.broadcastState();

        socket.send(JSON.stringify({
          type: "playerKicked",
          playerName: target.name
        }));

        return;
      }

    } catch {
      this.sendError(socket, "Invalid request.");
    }
  }

  private isTeller(id: string): boolean {
    return Boolean(id && id === this.state.tellerId);
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
