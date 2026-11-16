import { DurableObject } from "cloudflare:workers";

type S = Record<string, any>;
interface Env { ASSETS: Fetcher; GAME: DurableObjectNamespace<GameRoom>; }

const DEF: S = {
  script: "trouble-brewing", playerLimit: 15, roleAssignment: "random", includeTravellers: false,
  includeFabled: false, includeExperimental: false, customScriptName: "", selectedCharacters: [],
  firstNightMinutes: 8, otherNightMinutes: 6, dayDiscussionMinutes: 8, nominationMinutes: 5,
  votingSeconds: 30, executionMinutes: 2, announcePhaseChanges: true, showTimers: true,
  allowDeadPlayersToSpeak: true, deadPlayersKeepVote: true, nominationsPerDay: 0,
  tieHandling: "no-execution", allowSelfNomination: false, allowRepeatNominations: false,
  automaticPhaseProgression: false, automaticVoting: true, automaticExecution: false,
  automaticVictoryCheck: true, pauseForUnsupportedAbilities: true, storytellerCanOverride: true,
  allowRoleChanges: true, allowResurrection: true, allowManualDeaths: true,
  allowManualInformation: true, revealExecutedRole: true, revealDeathCause: false,
  gameVisibility: "unlisted", allowLateJoin: false, reconnectGraceMinutes: 10,
  retainGameHistory: true, clearPrivateNotesAtEnd: true, enablePersonalNotes: true,
  enableSuspicionTokens: true, enableScreenSafeMode: true, confirmDestructiveActions: true
};

const SR: Record<string, Record<string, string[]>> = {
  "trouble-brewing": {
    townsfolk: ["Washerwoman","Librarian","Investigator","Chef","Empath","Fortune Teller","Undertaker","Monk","Ravenkeeper","Virgin","Slayer","Soldier","Mayor"],
    outsiders: ["Butler","Drunk","Recluse","Saint"],
    minions: ["Poisoner","Spy","Scarlet Woman","Baron"],
    demons: ["Imp"]
  },
  "bad-moon-rising": {
    townsfolk: ["Grandmother","Sailor","Chambermaid","Exorcist","Innkeeper","Gambler","Gossip","Courtier","Professor","Minstrel","Tea Lady","Pacifist","Fool"],
    outsiders: ["Tinker","Moonchild","Goon","Lunatic"],
    minions: ["Godfather","Devil's Advocate","Assassin","Mastermind"],
    demons: ["Zombuul","Pukka","Shabaloth","Po"]
  },
  "sects-and-violets": {
    townsfolk: ["Snake Charmer","Flowergirl","Town Crier","Oracle","Savant","Seamstress","Philosopher","Artist","Juggler","Sage","Clockmaker","Dreamer","Mathematician"],
    outsiders: ["Mutant","Sweetheart","Barber","Klutz"],
    minions: ["Evil Twin","Witch","Cerenovus","Pit-Hag"],
    demons: ["Fang Gu","Vigormortis","No Dashii","Vortox"]
  }
};

const RT: Record<string, string> = {};
for (const sc of Object.values(SR)) for (const [t, rs] of Object.entries(sc)) for (const r of rs) RT[r.toLowerCase()] = t;
const typeOf = (r?: string) => RT[(r || "").toLowerCase()];

// [townsfolk, outsiders, minions, demons]
const PC: Record<number, number[]> = {
  5: [3,0,1,1], 6: [3,1,1,1], 7: [5,0,1,1], 8: [5,1,1,1], 9: [5,2,1,1], 10: [7,0,2,1],
  11: [7,1,2,1], 12: [7,2,2,1], 13: [9,0,3,1], 14: [9,1,3,1], 15: [9,2,3,1]
};

// Night-action roles (Trouble Brewing) and number of targets they choose.
const ACT: Record<string, number> = { Poisoner: 1, Monk: 1, Imp: 1, "Fortune Teller": 2, Butler: 1, Ravenkeeper: 1 };

const AB: Record<string, string> = {
  Washerwoman: "Start knowing that 1 of 2 players is a particular Townsfolk.",
  Librarian: "Start knowing that 1 of 2 players is a particular Outsider (or that there are none).",
  Investigator: "Start knowing that 1 of 2 players is a particular Minion.",
  Chef: "Start knowing how many pairs of evil players sit next to each other.",
  Empath: "Each night, learn how many of your 2 alive neighbours are evil.",
  "Fortune Teller": "Each night, choose 2 players: learn if either is the Demon. One good player registers as the Demon.",
  Undertaker: "Each night*, learn which character died by execution today.",
  Monk: "Each night*, choose a player (not yourself): they are safe from the Demon tonight.",
  Ravenkeeper: "If you die at night, choose a player: learn their character.",
  Virgin: "The first time you are nominated, if the nominator is a Townsfolk, they are executed immediately.",
  Slayer: "Once per game, during the day, publicly choose a player: if they are the Demon, they die.",
  Soldier: "You are safe from the Demon.",
  Mayor: "If only 3 players live and no execution occurs, your team wins. If you die at night, another player might die instead.",
  Butler: "Each night, choose a player (not yourself): tomorrow you may only vote if they are voting too.",
  Drunk: "You do not know you are the Drunk. You think you are a Townsfolk, but your ability malfunctions.",
  Recluse: "You might register as evil and as a Minion or Demon, even if dead.",
  Saint: "If you die by execution, your team loses.",
  Poisoner: "Each night, choose a player: they are poisoned tonight and tomorrow day.",
  Spy: "Each night, you see the Grimoire. You might register as good and as a Townsfolk or Outsider, even if dead.",
  "Scarlet Woman": "If there are 5 or more players alive and the Demon dies, you become the Demon.",
  Baron: "There are extra Outsiders in play (+2 Outsiders, -2 Townsfolk).",
  Imp: "Each night*, choose a player: they die. If you kill yourself this way, a Minion becomes the Imp."
};

interface P { id: string; pid: string; name: string; alive: boolean; ghost: boolean; role?: string; shown?: string; evil?: boolean; hist: string[]; act?: string[]; }

const sh = <T,>(a: T[]) => a.map(x => [Math.random(), x] as const).sort((a, b) => a[0] - b[0]).map(x => x[1]);

function validateScript(st: S, count: number) {
  const errors: string[] = [], warnings: string[] = [];
  const script = String(st.script || "");
  if (!(Number(st.playerLimit) >= 5 && Number(st.playerLimit) <= 15)) errors.push("Maximum player count must be between 5 and 15.");
  const n = Math.max(5, Math.min(15, count || 5));
  if (count < 5) warnings.push("Fewer than 5 players are in the lobby. Using the 5-player distribution.");
  const need = PC[n];
  const sel: string[] = Array.isArray(st.selectedCharacters) ? st.selectedCharacters.map(String) : [];
  let pool: string[] = [];
  if (script === "custom") {
    if (!sel.length) errors.push("A custom script needs characters selected.");
    pool = sel;
  } else if (!SR[script]) errors.push("The selected script is not recognized.");
  else {
    const all = Object.values(SR[script]).flat();
    pool = sel.length ? sel : all;
    const bad = sel.filter(r => !all.includes(r));
    if (bad.length) errors.push("Characters not in the selected script: " + bad.join(", "));
  }
  const low = pool.map(r => r.toLowerCase());
  const dup = low.filter((r, i) => low.indexOf(r) !== i);
  if (dup.length) errors.push("Duplicate characters: " + [...new Set(dup)].join(", "));
  const c = [0, 0, 0, 0], T = ["townsfolk", "outsiders", "minions", "demons"];
  for (const r of pool) { const i = T.indexOf(typeOf(r)); if (i >= 0) c[i]++; }
  T.forEach((t, i) => { if (c[i] < need[i]) errors.push(`Not enough ${t}: need ${need[i]}, have ${c[i]}.`); });
  if (st.includeTravellers) warnings.push("Travellers are not part of the role distribution check or the game engine.");
  if (st.includeExperimental) warnings.push("Experimental characters need manual rules checks.");
  if (script !== "trouble-brewing") warnings.push("Only Trouble Brewing has role text and night-action support; other scripts need manual Game Teller resolution.");
  return { valid: !errors.length, errors, warnings, playerCount: n };
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/ws") return env.GAME.get(env.GAME.idFromName("main-game")).fetch(request);
    return env.ASSETS.fetch(request);
  }
} satisfies ExportedHandler<Env>;

export class GameRoom extends DurableObject<Env> {
  private s: S = { players: [] as P[], phase: "Lobby", day: 0, tellerId: null, tellerName: null, settings: { ...DEF }, log: [] as string[], nom: null, noms: [] as any[], block: null, winner: null };
  private ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<S>("game");
      if (saved) this.s = { ...this.s, ...saved, settings: { ...DEF, ...(saved.settings || {}) } };
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    if (request.headers.get("Upgrade") !== "websocket") return new Response("WebSocket required", { status: 426 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  // Each socket only ever receives the view for the id it registered with.
  // NOTE: ids are random browser-generated secrets, not real authentication.
  private view(id: string) {
    const s = this.s, me: P | undefined = s.players.find((p: P) => p.id === id), t = !!id && id === s.tellerId;
    const nm = (pid: string) => s.players.find((p: P) => p.pid === pid)?.name;
    const nomV = s.nom && { by: nm(s.nom.by), to: nm(s.nom.to), votes: s.nom.votes.length };
    const out: S = {
      type: "state", isTeller: t,
      pub: {
        phase: s.phase, day: s.day, tellerName: s.tellerName, settings: s.settings, log: s.log, winner: s.winner,
        players: s.players.map((p: P) => ({ pid: p.pid, name: p.name, alive: p.alive, ghost: p.ghost })),
        nom: nomV, block: s.block && { name: nm(s.block.pid), yes: s.block.yes }
      }
    };
    if (me) {
      out.me = { pid: me.pid, alive: me.alive };
      if (me.role) {
        const r = me.shown || me.role;
        Object.assign(out.me, {
          role: r, evil: !!me.evil, ability: AB[r] || "Ability text not built in: ask the Game Teller.", hist: me.hist,
          acts: ACT[r] || 0, done: !!me.act, voted: !!s.nom && s.nom.votes.includes(me.pid),
          canVote: me.alive || (!!s.settings.deadPlayersKeepVote && !me.ghost),
          nominated: s.noms.some((x: any) => x.by === me.pid)
        });
      }
    }
    if (t) out.teller = { players: s.players.map((p: P) => ({ pid: p.pid, name: p.name, role: p.role, shown: p.shown, evil: p.evil, alive: p.alive, act: (p.act || []).map(nm) })) };
    return out;
  }

  private broadcast() {
    for (const ws of this.ctx.getWebSockets()) {
      try { const a = ws.deserializeAttachment() as any; ws.send(JSON.stringify(this.view(a?.id || ""))); } catch {}
    }
  }

  private say(m: string) { this.s.log.push(m); this.s.log = this.s.log.slice(-40); }

  private checkWin() {
    const s = this.s;
    if (s.winner) return;
    const al = s.players.filter((p: P) => p.alive);
    if (!al.some((p: P) => typeOf(p.role) === "demons")) s.winner = "Good";
    else if (al.length <= 2) s.winner = "Evil";
    if (s.winner) { s.phase = "Ended"; s.nom = null; this.say(`${s.winner} wins!`); }
  }

  private kill(p: P, cause: string) {
    const s = this.s;
    if (!p.alive) return;
    const aliveBefore = s.players.filter((x: P) => x.alive).length;
    p.alive = false;
    this.say(cause === "executed" ? `${p.name} was executed.` : `${p.name} died.`);
    if (typeOf(p.role) === "demons" && aliveBefore >= 5) {
      const sw = s.players.find((x: P) => x.alive && x.role === "Scarlet Woman");
      if (sw) { sw.role = "Imp"; sw.evil = true; sw.shown = undefined; sw.hist.push(`Day ${s.day}: you are now the Imp.`); }
    }
    this.checkWin();
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    await this.ready;
    let d: any;
    try { d = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)); } catch { return; }
    const s = this.s, id = String(d.id || ""), name = String(d.name || "").trim().slice(0, 20);
    const err = (m: string) => { try { ws.send(JSON.stringify({ type: "error", message: m })); } catch {} };
    if (!id || id.length > 64) return err("Missing id.");
    ws.serializeAttachment({ id });
    const me: P | undefined = s.players.find((p: P) => p.id === id);
    const isT = id === s.tellerId, st = s.settings;
    const byPid = (x: any): P | undefined => s.players.find((p: P) => p.pid === String(x));
    const needT = () => { if (!isT) { err("Only the Game Teller can do that."); return false; } return true; };
    const playing = s.phase === "Night" || s.phase === "Day";

    try {
      switch (d.type) {
        case "hello": break;

        case "join": {
          if (!name) return err("Enter a valid player name.");
          if (isT) return err("The Game Teller cannot also join as a player.");
          if (me) { me.name = name; break; }
          if (s.phase !== "Lobby" && !st.allowLateJoin) return err("The game has already started.");
          if (s.phase !== "Lobby") return err("Late joining is not supported once roles are assigned.");
          if (s.players.length >= Math.min(15, Math.max(5, Number(st.playerLimit) || 15))) return err("This lobby is full.");
          s.players.push({ id, pid: crypto.randomUUID().slice(0, 8), name, alive: true, ghost: false, hist: [] });
          break;
        }

        case "claimTeller":
          if (!name) return err("Enter a valid Game Teller name.");
          if (me) return err("You have already joined as a player.");
          if (s.tellerId && !isT) return err("A Game Teller has already been selected.");
          s.tellerId = id; s.tellerName = name;
          break;

        case "saveSettings": {
          if (!needT()) return;
          if (!d.settings || typeof d.settings !== "object" || Array.isArray(d.settings) || JSON.stringify(d.settings).length > 20000) return err("Invalid settings.");
          s.settings = { ...DEF, ...d.settings };
          ws.send(JSON.stringify({ type: "saved" }));
          break;
        }

        case "verifyScript": {
          if (!needT()) return;
          const prop = d.settings && typeof d.settings === "object" && !Array.isArray(d.settings) ? { ...DEF, ...d.settings } : st;
          ws.send(JSON.stringify({ type: "validation", result: validateScript(prop, s.players.length) }));
          return;
        }

        case "kickPlayer": {
          if (!needT()) return;
          if (s.phase !== "Lobby") return err("Players can only be removed in the lobby.");
          s.players = s.players.filter((p: P) => p.pid !== String(d.pid));
          break;
        }

        case "startGame": {
          if (!needT()) return;
          if (s.phase !== "Lobby" && s.phase !== "Ended") return err("A game is already running.");
          const n = s.players.length;
          if (n < 5 || n > 15) return err("You need 5 to 15 players.");
          const sc = SR[st.script] || SR["trouble-brewing"];
          const sel: string[] = Array.isArray(st.selectedCharacters) ? st.selectedCharacters : [];
          const pool = (t: string) => { const f = sc[t].filter(r => sel.includes(r)); return sh(f.length ? f : sc[t]); };
          let [t, o, m] = PC[n];
          const mins = pool("minions").slice(0, m);
          if (mins.includes("Baron")) { t -= 2; o += 2; }
          const picks = [...pool("demons").slice(0, 1), ...mins, ...pool("outsiders").slice(0, o), ...pool("townsfolk").slice(0, t)];
          if (picks.length < n) return err("Not enough characters in the pool for this player count.");
          const order = sh(s.players as P[]);
          const unused = sh([...sc.townsfolk, ...sc.outsiders].filter(r => !picks.includes(r)));
          order.forEach((p, i) => {
            p.role = picks[i]; p.shown = undefined; p.alive = true; p.ghost = false; p.act = undefined;
            p.evil = ["minions", "demons"].includes(typeOf(p.role));
            p.hist = [];
            if (p.role === "Drunk") p.shown = sc.townsfolk.filter(r => !picks.includes(r))[0] || "Chef";
          });
          const ev = s.players.filter((p: P) => p.evil);
          ev.forEach((p: P) => p.hist.push("Night 1: your evil team is " + ev.map((e: P) => `${e.name} (${e.role})`).join(", ") + "."));
          const dem = s.players.find((p: P) => typeOf(p.role) === "demons");
          if (dem) dem.hist.push("Night 1: bluffs (characters not in play): " + unused.filter(r => typeOf(r) === "townsfolk").slice(0, 3).join(", ") + ".");
          Object.assign(s, { phase: "Night", day: 1, log: [], nom: null, noms: [], block: null, winner: null });
          this.say("The game begins. Night 1.");
          break;
        }

        case "assign": {
          if (!needT()) return;
          const p = byPid(d.pid), r = String(d.role || "");
          if (!p || !playing) return err("Pick a player during a running game.");
          if (!typeOf(r)) return err("Unknown character.");
          p.role = Object.values(SR).flatMap(x => Object.values(x).flat()).find(x => x.toLowerCase() === r.toLowerCase());
          p.shown = undefined; p.evil = ["minions", "demons"].includes(typeOf(p.role));
          p.hist.push(`${s.phase} ${s.day}: you are now the ${p.role}.`);
          break;
        }

        case "startDay": case "startNight": {
          if (!needT()) return;
          if (d.type === "startDay" && s.phase !== "Night") return err("It is not night.");
          if (d.type === "startNight" && s.phase !== "Day") return err("It is not day.");
          if (d.type === "startNight") s.day++;
          s.players.forEach((p: P) => (p.act = undefined));
          Object.assign(s, { phase: d.type === "startDay" ? "Day" : "Night", nom: null, noms: [], block: null });
          this.say(d.type === "startDay" ? `Day ${s.day} begins.` : `Night ${s.day} begins.`);
          break;
        }

        case "act": {
          if (!me || !me.role || s.phase !== "Night") return err("You cannot act now.");
          const r = me.shown || me.role, k = ACT[r];
          if (!k) return err("Your character has no night choice.");
          if (!me.alive && r !== "Ravenkeeper") return err("Dead players cannot act.");
          if (r === "Imp" && s.day === 1) return err("The Imp does not kill on the first night.");
          if (me.act) return err("You already chose tonight.");
          const tg = Array.isArray(d.targets) ? [...new Set(d.targets.map(String))] : [];
          const ps = tg.map(byPid);
          if (tg.length !== k || ps.some(x => !x)) return err(`Choose ${k} valid player(s).`);
          me.act = tg as string[];
          me.hist.push(`Night ${s.day}: you chose ${ps.map(x => x!.name).join(" and ")}.`);
          break;
        }

        case "info": {
          if (!needT()) return;
          const p = byPid(d.pid), text = String(d.text || "").trim().slice(0, 300);
          if (!p || !text || !playing) return err("Pick a player and write the information.");
          p.hist.push(`${s.phase} ${s.day}: ${text}`);
          break;
        }

        case "kill": {
          if (!needT()) return;
          const p = byPid(d.pid);
          if (!p || !playing) return err("Pick a living player during a running game.");
          this.kill(p, "died");
          break;
        }

        case "nominate": {
          if (!me || s.phase !== "Day" || !me.alive) return err("You cannot nominate now.");
          const to = byPid(d.pid);
          if (!to) return err("Pick a player.");
          if (s.nom) return err("A nomination is already open.");
          if (to.pid === me.pid && !st.allowSelfNomination) return err("Self-nomination is off.");
          if (s.noms.some((x: any) => x.by === me.pid)) return err("You already nominated today.");
          if (!st.allowRepeatNominations && s.noms.some((x: any) => x.to === to.pid)) return err("That player was already nominated today.");
          if (Number(st.nominationsPerDay) > 0 && s.noms.length >= Number(st.nominationsPerDay)) return err("Nomination limit reached today.");
          s.nom = { by: me.pid, to: to.pid, votes: [] };
          s.noms.push({ by: me.pid, to: to.pid });
          this.say(`${me.name} nominated ${to.name}.`);
          break;
        }

        case "vote": {
          if (!me || !s.nom) return err("No vote is open.");
          if (!(me.alive || (st.deadPlayersKeepVote && !me.ghost))) return err("You cannot vote.");
          if (s.nom.votes.includes(me.pid)) return err("You already voted.");
          s.nom.votes.push(me.pid);
          break;
        }

        case "closeVote": {
          if (!needT()) return;
          if (!s.nom) return err("No vote is open.");
          const yes = s.nom.votes.length, need = Math.ceil(s.players.filter((p: P) => p.alive).length / 2);
          s.nom.votes.forEach((v: string) => { const p = byPid(v); if (p && !p.alive) p.ghost = true; });
          const to = byPid(s.nom.to)!;
          if (yes >= need && (!s.block || yes >= s.block.yes)) {
            if (s.block && yes === s.block.yes) { s.block = null; this.say(`${to.name} got ${yes} votes: tie, nobody is on the block.`); }
            else { s.block = { pid: to.pid, yes }; this.say(`${to.name} got ${yes} votes and is on the block.`); }
          } else this.say(`${to.name} got ${yes} votes (needed ${need}): not enough.`);
          s.nom = null;
          break;
        }

        case "execute": {
          if (!needT()) return;
          if (s.phase !== "Day" || s.nom) return err("Close voting first.");
          if (!s.block) return err("Nobody is on the block.");
          const p = byPid(s.block.pid)!;
          s.block = null;
          this.kill(p, "executed");
          if (p.role === "Saint" && !s.winner) { s.winner = "Evil"; s.phase = "Ended"; this.say("The Saint was executed. Evil wins!"); }
          break;
        }

        case "reset": {
          if (!needT()) return;
          s.players.forEach((p: P) => Object.assign(p, { role: undefined, shown: undefined, evil: undefined, alive: true, ghost: false, hist: [], act: undefined }));
          Object.assign(s, { phase: "Lobby", day: 0, log: [], nom: null, noms: [], block: null, winner: null });
          break;
        }

        default: return err("Unknown request.");
      }
    } catch { return err("Invalid request."); }

    await this.ctx.storage.put("game", this.s);
    this.broadcast();
    if (d.type === "saveSettings") ws.send(JSON.stringify({ type: "saved" }));
  }

  async webSocketClose() {}
}
