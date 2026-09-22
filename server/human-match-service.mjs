import { createHash, randomInt, randomUUID } from "node:crypto";
import { CustomMatchService, customMatchPrimitives } from "./custom-match-engine.mjs";

const { applySelectedDeck, makePlayGame, normalizeMove, moveType, playerSummary, recordDeck } = customMatchPrimitives;
const SIDES = ["black", "white"];
const clone = (value) => structuredClone(value);
const opposite = (side) => side === "black" ? "white" : "black";
const tokenHash = (token) => createHash("sha256").update(String(token)).digest("hex");
const boundedDuration = (value, name, minimum = 0) => {
  const duration = Number(value);
  if (!Number.isSafeInteger(duration) || duration < minimum) throw new Error(`invalid_${name}`);
  return duration;
};
const splitCommand = (line) => {
  const index = line.indexOf(" ");
  return index < 0 ? [line, ""] : [line.slice(0, index), line.slice(index + 1)];
};

export const humanMatchTimingContract = Object.freeze({
  // MatchVersusView.TOTAL_SECONDS, MatchStageView._update_match_intro, then
  // sharedassets4_prefabs.turn_change_player TweenAlpha/TweenShaderOffset.
  versusMilliseconds: 6200,
  stageIntroMilliseconds: 9800,
  turnCutInMilliseconds: 1500,
  firstPresentationMilliseconds: 6200 + 9800 + 1500,
  // Base upper bounds for a single-result battle Spin:
  // fade out/in + entry delay/tween + optional speedup + randomized stop +
  // displacement. The authoring caps, not a client-reported elapsed time,
  // determine the deadline. Additional results are budgeted below.
  battleWheelPresentationMilliseconds: 300 + 300 + 500 + 200 + 1600 + 1200 + 500 + 300,
  // Wheel bound + result wait + Z prelude + longest serialized attack/damage
  // clip (damage_necrozma 3.8s) + fifteen completion frames + condition hold +
  // field-return fades + turn cut-in. Fifteen frames at 30 fps is owned deadline
  // policy; the original presentation itself remains frame-count based.
  battlePresentationMilliseconds: 4900 + 500 + 3000 + 3800 + 500 + 2300 + 600 + 1500,
  // Owned upper-bound allowance for asset construction/network delivery. This
  // is not an asserted original-server constant. A readiness message can end
  // the allowance early; it can never extend an already-issued deadline.
  readinessAllowanceMilliseconds: 5000,
});

export function repeatedSpinPresentationExtraMilliseconds(spinValue) {
  // MatchStageView._complete_battle_wheel_result waits0.5s, multiplies the
  // stop duration by0.6 (floor0.1s), and draws at most1.2x jitter. Two wheels
  // run concurrently. Displacement adds its own0.5s wait and0.3s tween.
  return Math.ceil(Math.max(0, ...(spinValue?.spins || []).map(spin => {
    let base = 1000, extra = 0;
    for (const result of (spin.results || []).slice(1)) {
      base = Math.max(100, base * 0.6);
      extra += 500 + base * 1.2 + (Number(result.displace) !== 0 ? 800 : 0);
    }
    return extra;
  })));
}

function battlePresentationExtraMilliseconds(record, wheelBound) {
  const spins = [];
  for (let index = record.all_moves.length - 1; index >= 0; index--) {
    const value = record.all_moves[index].value;
    // A player already saw the first preview before choosing a respin/decline.
    if (["declare_battle", "declare_respin", "null_move"].includes(value.type)) break;
    if (value.type === "spin") spins.push(value);
  }
  return spins.reduce((total, spin) => total + repeatedSpinPresentationExtraMilliseconds(spin), 0)
    + Math.max(0, spins.length - 1) * wheelBound;
}

// One projection for both the live result and its durable post-restart record.
// AccountStore enforces participant ownership before supplying stored records;
// retain the check here so callers cannot accidentally project another account.
export function humanMatchResult(completion, userId, rating = 1000) {
  const player = completion?.players?.find((value) => Number(value.user_id) === Number(userId));
  if (completion?.mode !== "human" || !player || !SIDES.includes(player.side) ||
      !Number.isSafeInteger(Number(completion.match_id))) throw new Error("match_result_unavailable");
  return {
    online_match_id: Number(completion.match_id), mode: "human", player_color: player.side,
    winner: completion.winner, reason: completion.reason, won: completion.winner === player.side,
    // Ranking/economy changes remain a separate recovered transaction contract.
    prev_point: 0, after_point: 0, prev_rating: rating, after_rating: rating,
    prev_star: 0, after_star: 0, user_arena_rewards: [],
    user_arena_ranking_changes: [], user_rental_decks: [], is_shield: false,
  };
}

// The managed OnlineGameManager.InitializeGame/PlayerMove contract supplies a
// complete record at connection, no echo to the author of a local move, and
// sequenced opponent/system commands. Queue leases and reconnect deadlines are
// owned-service policy, not claims about an unavailable original server.
export class HumanMatchService extends CustomMatchService {
  constructor({
    trainingService = null,
    loadDeck = null,
    onMatchFinished = null,
    queueLeaseMs = 30_000,
    joinTimeoutMs = 60_000,
    reconnectGraceMs = 30_000,
    resultRetentionMs = 24 * 60 * 60 * 1000,
    firstPresentationMs = humanMatchTimingContract.firstPresentationMilliseconds,
    turnPresentationMs = humanMatchTimingContract.turnCutInMilliseconds,
    battlePresentationMs = humanMatchTimingContract.battlePresentationMilliseconds,
    battleWheelPresentationMs = humanMatchTimingContract.battleWheelPresentationMilliseconds,
    presentationSlackMs = humanMatchTimingContract.readinessAllowanceMilliseconds,
    matchIdSource = () => randomInt(1_000_000_000, 2 ** 48),
    ...options
  }) {
    super({ ...options, opponentPlateMode: "off", battleEvidenceMode: "off" });
    this.trainingService = trainingService;
    this.loadDeck = loadDeck;
    this.onMatchFinished = onMatchFinished;
    this.queueLeaseMs = boundedDuration(queueLeaseMs, "queue_lease_ms", 1);
    this.joinTimeoutMs = boundedDuration(joinTimeoutMs, "join_timeout_ms", 1);
    this.reconnectGraceMs = boundedDuration(reconnectGraceMs, "reconnect_grace_ms", 1);
    this.resultRetentionMs = boundedDuration(resultRetentionMs, "result_retention_ms", 1);
    this.firstPresentationMs = boundedDuration(firstPresentationMs, "first_presentation_ms");
    this.turnPresentationMs = boundedDuration(turnPresentationMs, "turn_presentation_ms");
    this.battlePresentationMs = boundedDuration(battlePresentationMs, "battle_presentation_ms");
    this.battleWheelPresentationMs = boundedDuration(battleWheelPresentationMs, "battle_wheel_presentation_ms");
    this.presentationSlackMs = boundedDuration(presentationSlackMs, "presentation_slack_ms");
    this.matchIdSource = matchIdSource;
    this.waiting = new Map();
    this.activeByUser = new Map();
    this.sessionUsers = new Map();
    this.closed = false;
  }

  async listen() {
    await super.listen();
    if (this.trainingService) this.trainingService.port = this.port;
  }

  authenticate(session, user) {
    const id = Number(user?.user_id);
    if (!Number.isSafeInteger(id) || id <= 0 || typeof session !== "string" || !session
        || !this.sessionIsAuthorized(session, id)) {
      throw new Error("matching_authentication_required");
    }
    const hash = tokenHash(session);
    const existing = this.sessionUsers.get(hash);
    if (existing && existing.userId !== id) throw new Error("matching_session_account_mismatch");
    this.sessionUsers.set(hash, { userId: id, lastSeenAt: Number(this.clockSource()) });
    return { id, hash };
  }

  enter(session, user, selectedDeck = null) {
    const { id } = this.authenticate(session, user);
    this.expireState();
    const active = this.activeByUser.get(id);
    if (active) return this.status(active, this.statusCode(active));
    const current = this.waiting.get(id);
    if (current) {
      current.expiresAt = Number(this.clockSource()) + this.queueLeaseMs;
      current.session = session;
      return this.waitingStatus(current);
    }
    // loadDeck is the authoritative AccountStore resolver when integrated. A
    // supplied snapshot alone is for trusted callers/isolated engine tests,
    // never a client-submitted deck accepted by the HTTP boundary.
    const deck = this.loadDeck ? this.loadDeck(id, Number(selectedDeck?.deck_no)) : selectedDeck;
    if (!deck || !Number.isInteger(Number(deck.deck_no)) || Number(deck.deck_no) < 1) {
      throw new Error("battle_deck_required");
    }
    if (deck.user_id != null && Number(deck.user_id) !== id) throw new Error("battle_deck_account_mismatch");
    // Validate the full master projection before an invalid entry can consume
    // another player's queue slot. The snapshot stays fixed until cancel/reset.
    applySelectedDeck(super.createMatch("validation", user).record, deck);
    const now = Number(this.clockSource());
    const entry = {
      id: this.newMatchId(), user: clone(user), deck: clone(deck), session, enteredAt: now,
      expiresAt: now + this.queueLeaseMs,
    };
    this.waiting.set(id, entry);
    const opponent = [...this.waiting.entries()].find(([otherId]) => otherId !== id);
    if (!opponent) return this.waitingStatus(entry);
    const [otherId, first] = opponent;
    const match = this.pair(first, entry);
    this.waiting.delete(otherId);
    this.waiting.delete(id);
    return this.status(match, 3);
  }

  newMatchId() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const id = Number(this.matchIdSource());
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error("invalid_match_id_source");
      if (!this.matches.has(id) && ![...this.waiting.values()].some((entry) => entry.id === id)) return id;
    }
    throw new Error("match_id_exhausted");
  }

  pair(first, second) {
    const match = super.createMatch("human", first.user, first.deck);
    match.id = first.id;
    match.record.id = String(first.id);
    applySelectedDeck(match.record, second.deck, 1);
    match.record.players[1].id = String(second.user.user_id);
    match.record.client_ai_name = "kiwi-duel-human";
    match.record.server_ai_name = "kiwi-duel-authority";
    match.mode = "human";
    match.phase = "found";
    match.createdAt = Number(this.clockSource());
    match.finishedAt = null;
    match.resolving = false;
    match.peers = SIDES.map((side, index) => {
      const entry = index === 0 ? first : second;
      return {
        side, user: clone(entry.user), deck: clone(entry.deck), socket: null, session: null, connectionState: null,
        ready: false, connectedOnce: false, disconnectedAt: null, reset: false,
        serverSendIndex: -1, clientSendIndex: -1,
      };
    });
    // Inherited rule continuations test whether a transport exists. This is a
    // match-level authority handle; actual writes are directed to each peer.
    match.socket = { destroyed: false, destroy: () => {} };
    this.matches.set(match.id, match);
    for (const peer of match.peers) this.activeByUser.set(Number(peer.user.user_id), match);
    return match;
  }

  waitingStatus(entry) {
    return { room_id: entry.id, status: 1, online_match: null, tentative_user: null };
  }

  statusCode(match) {
    return match.phase === "finished" ? 11 : ["started", "finishing"].includes(match.phase) ? 10 : match.phase === "reset" ? 99 : 3;
  }

  poll(session, user) {
    const { id } = this.authenticate(session, user);
    this.expireState();
    const match = this.activeByUser.get(id);
    if (match) return this.status(match, this.statusCode(match));
    const entry = this.waiting.get(id);
    if (!entry) return { room_id: 0, status: 99, online_match: null, tentative_user: null };
    entry.expiresAt = Number(this.clockSource()) + this.queueLeaseMs;
    entry.session = session;
    return this.waitingStatus(entry);
  }

  cancel(session, user) {
    const { id } = this.authenticate(session, user);
    if (this.waiting.delete(id)) return true;
    const match = this.activeByUser.get(id);
    // Once paired, cancel loses the race. Neither user can evict the other's
    // assigned match; they must connect and explicitly resign if desired.
    return !match || match.phase === "reset";
  }

  reset(session, user) {
    const { id } = this.authenticate(session, user);
    if (this.waiting.has(id)) throw new Error("matching_cancel_required");
    const match = this.activeByUser.get(id);
    if (!match) return true;
    if (!["finished", "reset"].includes(match.phase)) throw new Error("match_reset_before_finish");
    const peer = this.peerForUser(match, id);
    peer.reset = true;
    this.activeByUser.delete(id);
    this.revokeTickets(match, id);
    peer.socket?.end();
    // Keep the terminal record so one result dismissal cannot delete the other
    // player's result. Retention is bounded and can be backed by onMatchFinished.
    return true;
  }

  issueTicket(session, user) {
    const { id, hash } = this.authenticate(session, user);
    this.expireState();
    const match = this.activeByUser.get(id);
    if (!match || !["found", "started", "finished"].includes(match.phase)) throw new Error("battle_match_unavailable");
    const peer = this.peerForUser(match, id);
    this.revokeTickets(match, id);
    const ticket = randomUUID();
    this.tickets.set(ticket, {
      // Private in-memory proof for immediate revocation checks on raw TCP as
      // well as WS. This value never enters records, DTOs, logs or snapshots.
      session, sessionHash: hash, userId: id, side: peer.side, matchId: match.id,
      expiresAt: Number(this.clockSource()) + 60_000,
    });
    return ticket;
  }

  revokeTickets(match, userId = null) {
    for (const [ticket, value] of this.tickets) {
      if (value.matchId === match.id && (userId == null || value.userId === userId)) this.tickets.delete(ticket);
    }
  }

  peerForUser(match, id) {
    const peer = match.peers.find((candidate) => Number(candidate.user.user_id) === Number(id));
    if (!peer) throw new Error("match_account_not_participant");
    return peer;
  }

  result(session, matchId, user) {
    const { id } = this.authenticate(session, user);
    const match = this.matches.get(Number(matchId));
    if (!match || match.phase !== "finished") throw new Error("match_result_unavailable");
    const peer = this.peerForUser(match, id);
    const rating = Number(peer.user.rate ?? peer.user.rating ?? peer.user.public?.rate ?? 1000);
    return humanMatchResult({
      match_id: match.id, mode: "human", winner: match.winner, reason: match.reason,
      players: match.peers.map((entry) => ({ user_id: entry.user.user_id, side: entry.side })),
    }, id, rating);
  }

  userInfo(session, baseUser) {
    const { id } = this.authenticate(session, baseUser);
    this.expireState();
    const user = clone(baseUser);
    const match = this.activeByUser.get(id);
    const entry = this.waiting.get(id);
    if (match || entry) user.private = {
      ...user.private,
      matching_status: match ? this.status(match, this.statusCode(match)) : this.waitingStatus(entry),
    };
    return user;
  }

  status(match, statusCode) {
    if (!match.peers) return super.status(match, statusCode);
    const players = match.peers.map((peer, index) => playerSummary(
      Number(peer.user.user_id), String(peer.user.display_name ?? peer.user.name ?? "Player"), index,
      this.plateMasters, match.record.players[index].plates, recordDeck(match.record, index), Number(peer.deck.deck_no),
    ));
    return {
      room_id: match.id, status: statusCode, tentative_user: null,
      online_match: statusCode === 99 ? null : {
        online_match_id: match.id, match_type: 1, mode: "human",
        player1: players[0], player2: players[1],
        arena: { black_league_master_id: 101, white_league_master_id: 101 },
        game_server: {
          public_name: this.publicHost, port: this.port,
          protocol_version: "custom.2", ai_version: "evidence-base.1",
          plate_state_schema: 1,
          z_state_schema: 1,
        },
      },
    };
  }

  attach(socket) {
    super.attach(socket);
    // The base owns framing/error limits. This close observer only releases the
    // exact socket generation so a late old close cannot evict a reconnect.
    socket.on("close", () => {
      for (const match of this.matches.values()) {
        const peer = match.peers.find((candidate) => candidate.socket === socket);
        if (!peer) continue;
        peer.socket = null;
        peer.ready = false;
        if (match.phase === "started") peer.disconnectedAt ??= Number(this.clockSource());
      }
    });
  }

  handleLine(socket, state, line) {
    if (state.terminated || socket.destroyed || socket.writableEnded) return;
    if (state.training) return this.trainingService.handleLine(socket, state, line);
    let [command, payload] = splitCommand(line);
    // Fixed queue/join/reconnect deadlines apply at input arrival, not merely
    // at the next periodic sweep. A pre-issued ticket cannot reopen a lost game.
    // Check only this connection's match: one client's ping must not trigger
    // AccountStore lookups for every unrelated live match or waiting account.
    const pendingGrant = command === "@login" ? this.tickets.get(payload.split(/\s+/)[1]) : null;
    const associatedMatch = state.match ?? this.matches.get(pendingGrant?.matchId);
    if (associatedMatch) this.expireMatch(associatedMatch, Number(this.clockSource()));
    if (socket.destroyed || socket.writableEnded) return;
    if (command === "@login") {
      if (state.match) return socket.destroy();
      const [userId, ticket] = payload.split(/\s+/);
      if (this.trainingService?.tickets.has(ticket)) {
        const grant = this.trainingService.tickets.get(ticket);
        const trainingMatch = this.trainingService.matches.get(grant.session);
        if ((socket.authenticatedSession != null && socket.authenticatedSession !== grant.session)
            || (socket.authenticatedUserId != null && Number(socket.authenticatedUserId) !== Number(trainingMatch?.localUser?.user_id))) {
          this.trainingService.tickets.delete(ticket);
          socket.end("@login rejected\n");
          return;
        }
        state.training = true;
        return this.trainingService.handleLine(socket, state, line);
      }
      const grant = this.tickets.get(ticket);
      this.tickets.delete(ticket);
      const match = grant ? this.matches.get(grant.matchId) : null;
      if (!grant || grant.expiresAt <= Number(this.clockSource()) || String(grant.userId) !== userId
          || this.sessionUsers.get(grant.sessionHash)?.userId !== grant.userId
          || !this.sessionIsAuthorized(grant.session, grant.userId)
          || (socket.authenticatedSession != null && tokenHash(socket.authenticatedSession) !== grant.sessionHash)
          || (socket.authenticatedUserId != null && Number(socket.authenticatedUserId) !== grant.userId)
          || !match || !["found", "started", "finished"].includes(match.phase)) {
        socket.end("@login rejected\n");
        return;
      }
      const peer = this.peerForUser(match, grant.userId);
      if (peer.reset || peer.side !== grant.side) return socket.end("@login rejected\n");
      const previous = peer.socket;
      peer.socket = socket;
      peer.ready = false;
      peer.session = grant.session;
      peer.connectionState = state;
      // A reconnect is complete at PlayGame, not login. Repeated half-open
      // handshakes must not extend the original disconnect/readiness deadline.
      if (match.phase === "started") peer.disconnectedAt ??= Number(this.clockSource());
      peer.connectedOnce = true;
      state.match = match;
      state.peer = peer;
      previous?.destroy();
      socket.write("@login ok\n");
      return;
    }
    const { match, peer } = state;
    if (!match || !peer || peer.socket !== socket) return socket.destroy();
    if (!this.sessionIsAuthorized(peer.session, peer.user.user_id)) {
      this.closeRevokedPeer(match, peer);
      return;
    }
    let sequenceIndex = null;
    if (command === "sequence") {
      const envelope = payload.match(/^(-?\d+)\s+(-?\d+)\s+([\s\S]+)$/);
      if (!envelope) return this.rejectConnection(peer, "invalid_sequence");
      sequenceIndex = Number(envelope[1]);
      if (!Number.isSafeInteger(sequenceIndex) || sequenceIndex < 0) return this.rejectConnection(peer, "invalid_sequence");
      const acknowledgedServerIndex = Number(envelope[2]);
      if (!Number.isSafeInteger(acknowledgedServerIndex) || acknowledgedServerIndex < -1
          || acknowledgedServerIndex > peer.serverSendIndex) return this.rejectConnection(peer, "invalid_sequence_ack");
      // The original starts at ServerRecvIndex+1; Godot's pre-increment sender
      // starts a fresh connection at 1. Both initial forms are accepted once.
      if (sequenceIndex <= peer.clientSendIndex) return;
      if ((peer.clientSendIndex >= 0 && sequenceIndex !== peer.clientSendIndex + 1)
          || (peer.clientSendIndex < 0 && sequenceIndex > 1)) return this.rejectConnection(peer, "sequence_gap");
      [command, payload] = splitCommand(envelope[3]);
      peer.clientSendIndex = sequenceIndex;
    }
    if (command === "playgame") {
      peer.ready = true;
      peer.disconnectedAt = null;
      if (match.phase === "found") {
        if (!match.peers.every((candidate) => candidate.ready)) return;
        match.phase = "started";
        this.armPresentationClock(match, "first_turn", this.firstPresentationMs);
        for (const candidate of match.peers) this.sendPlayGame(match, candidate);
      } else {
        this.syncMatchClock(match);
        this.sendPlayGame(match, peer);
        if (match.phase === "finished") this.sendPeer(peer, `match_finish ${match.winner} ${match.reason}`);
      }
      return;
    }
    if (!peer.ready) return this.rejectConnection(peer, "playgame_required");
    if (command === "ping") return;
    if (command === "time" || command === "timer_start") {
      // The owned wall clock never trusts client time reports or allows the
      // non-active player to pause, reset, or extend the opponent's clock.
      this.syncMatchClock(match);
      if (command === "timer_start" && payload.trim() === peer.side && match.turn === peer.side
          && match.phase === "started" && !match.resolving) this.startMatchClock(match, peer.side);
      this.sendTimes(match, peer);
      return;
    }
    if (sequenceIndex == null && ["do_move", "go", "lose"].includes(command)) {
      return this.rejectConnection(peer, "sequence_required");
    }
    if (match.phase !== "started" || !this.syncMatchClock(match)) return;
    if (command === "lose") {
      this.finish(match, opposite(peer.side), "resign");
      return;
    }
    if (command === "go") {
      this.sendPeer(peer, `go ${JSON.stringify({ ErrorCode: 1, ErrorMessage: "AI assistance is not available in human matchmaking" })}`);
      return;
    }
    if (command !== "do_move") return;
    let parsed;
    try { parsed = JSON.parse(payload); } catch { return this.rejectConnection(peer, "invalid_move_json"); }
    const move = normalizeMove(parsed);
    if (!move || move.selective_side !== peer.side) return this.rejectConnection(peer, "invalid_player_side");
    if (this.selectionSide(match) !== peer.side || match.resolving) return this.rejectConnection(peer, "stale_player_turn");
    if (match.pendingRespin?.declared) return this.rejectConnection(peer, "respin_already_declared");
    const type = moveType(move);
    if (match.pendingBattles.length > 0 && !match.pendingRespin
        && !["declare_battle", "null_move", "resign", ...(match.pendingTouch ? ["touch"] : [])].includes(type)) {
      return this.rejectConnection(peer, "battle_choice_required");
    }
    if (type === "null_move" && !match.pendingRespin && match.pendingBattles.some((battle) =>
      match.positions.get(Number(battle.value.from_pokemon)) === match.positions.get(Number(battle.value.to_pokemon)))) {
      return this.rejectConnection(peer, "occupied_destination_requires_battle");
    }
    if (match.pendingPlate && type === "declare_plate") return this.rejectConnection(peer, "plate_continuation_required");
    match.commandPeer = peer;
    const before = match.record.all_moves.length;
    const precedingTurn = match.turn;
    const presentationRevision = match.presentationRevision ?? 0;
    try {
      super.acceptPlayerMove(match, move, peer.side);
    } finally {
      match.commandPeer = null;
    }
    if (match.phase !== "started" || match.record.all_moves.length === before) return;
    // A Sleep recovery Surround can finish the turn inside DeclareBattle.
    // No Spin callback will arrive to release the human input/clock lock.
    const cancelledDeclaration = type === "declare_battle" && !match.battleResolutionPending;
    match.resolving = ["declare_battle", "declare_respin", "declare_spin"].includes(type) && !cancelledDeclaration;
    // Declining a respin resolves synchronously and already arms the battle
    // presentation deadline. Do not overwrite it with a plain turn cut-in.
    if (!match.resolving && presentationRevision === (match.presentationRevision ?? 0)) this.armPresentationClock(match, type === "touch" ? "player_touch" : cancelledDeclaration ? "condition_recovery" : "player_move",
      (type === "touch" ? 3000 : cancelledDeclaration ? 1000 : 0) + (match.turn === precedingTurn ? 0 : this.turnPresentationMs));
    this.sendTimes(match);
  }

  sendPlayGame(match, peer) {
    const payload = makePlayGame(match);
    payload.ServerSendIndex = peer.serverSendIndex;
    payload.ServerRecvIndex = peer.clientSendIndex;
    payload.ClientRecvIndex = peer.serverSendIndex;
    payload.ClockPolicy = this.clockPolicy(match);
    peer.socket?.write(`playgame ${JSON.stringify(payload)}\n`);
  }

  rejectConnection(peer, error) {
    // The client may already have evaluated its local choice. Terminate only
    // that connection; a fresh ticket+playgame restores authoritative state.
    peer.ready = false;
    if (peer.connectionState) peer.connectionState.terminated = true;
    peer.socket?.end(`move_rejected ${JSON.stringify({ error })}\n`);
  }

  rejectPlayerMove(match, error) {
    if (match.commandPeer) this.rejectConnection(match.commandPeer, error);
  }

  playerMoveAccepted(match, move, side) {
    for (const peer of match.peers) if (peer.side !== side) this.sendPeer(peer, `do_move ${JSON.stringify(move)}`);
  }

  sendPeer(peer, command) {
    if (!this.sessionIsAuthorized(peer.session, peer.user.user_id)) {
      const match = this.activeByUser.get(Number(peer.user.user_id));
      if (match) this.closeRevokedPeer(match, peer);
      return;
    }
    if (!peer.ready || !peer.socket || peer.socket.destroyed || !peer.socket.writable) return;
    peer.serverSendIndex += 1;
    peer.socket.write(`sequence ${peer.serverSendIndex} ${peer.clientSendIndex} ${command}\n`);
  }

  sendSequenced(match, command) {
    if (!match.peers) return super.sendSequenced(match, command);
    for (const peer of match.peers) this.sendPeer(peer, command);
  }

  sendTimes(match, onlyPeer = null) {
    for (const peer of onlyPeer ? [onlyPeer] : match.peers) {
      for (const side of SIDES) this.sendPeer(peer, `time ${side} ${Math.ceil(match[`${side}TimeMs`])}`);
    }
  }

  clockPolicy(match) {
    return {
      schema: "kiwi-duel-owned-clock-policy-1",
      first_presentation_ms: this.firstPresentationMs,
      turn_cut_in_ms: this.turnPresentationMs,
      battle_presentation_bound_ms: this.battlePresentationMs,
      battle_wheel_presentation_bound_ms: this.battleWheelPresentationMs,
      readiness_allowance_ms: this.presentationSlackMs,
      active_side: match.activeClockSide,
      pending_side: match.presentationClock?.side ?? "",
      start_no_later_than_ms: match.presentationClock?.deadline ?? null,
      source: "6.2s Versus + 9.8s stage intro + serialized 1.5s turn cut-in; allowance is owned policy",
    };
  }

  armPresentationClock(match, reason, authoredMilliseconds) {
    if (match.phase !== "started") return;
    match.activeClockSide = "";
    match.clockStartedAtMs = 0;
    match.presentationRevision = (match.presentationRevision ?? 0) + 1;
    match.presentationClock = {
      side: this.selectionSide(match), reason,
      deadline: Number(this.clockSource()) + authoredMilliseconds + this.presentationSlackMs,
    };
    this.syncMatchClock(match);
  }

  startMatchClock(match, side) {
    if (match.phase !== "started" || this.selectionSide(match) !== side || match.resolving) return false;
    this.syncMatchClock(match);
    if (match.phase !== "started") return false;
    match.presentationClock = null;
    // Repeated timer_start only synchronizes an already-running clock; it
    // neither grants another animation pause nor replaces its time budget.
    if (match.activeClockSide === side) return true;
    return super.startMatchClock(match, side);
  }

  pauseMatchClock(match) {
    const result = super.pauseMatchClock(match);
    match.presentationClock = null;
    return result;
  }

  syncMatchClock(match) {
    const pending = match.presentationClock;
    if (pending && match.phase === "started" && Number(this.clockSource()) >= pending.deadline) {
      match.presentationClock = null;
      match.activeClockSide = pending.side;
      // Charge elapsed time from the fixed deadline, even if a busy event loop
      // ticks late. The sender cannot keep the clock paused by omitting readiness.
      match.clockStartedAtMs = pending.deadline;
    }
    return super.syncMatchClock(match);
  }

  // Human white is never driven by the inherited training controller.
  playOpponentTurn(_match) {}
  declareOpponentRespin(_match) {}
  scheduleOpponentJump(_match, _pending) {}
  scheduleOpponentExtraBattle(_match, _pending) {}
  scheduleOpponentGrudge(_match, _pending) {}

  performPendingGrudge(match,pending) {
    const priorTurn=match.turn;
    if (!super.performPendingGrudge(match,pending)) return false;
    match.resolving=false;
    this.armPresentationClock(match,"grudge_probability",this.battleWheelPresentationMs+(match.turn===priorTurn?0:this.turnPresentationMs));
    this.sendTimes(match);
    return true;
  }

  stagePendingExtraBattle(match, jump) {
    if (!super.stagePendingExtraBattle(match,jump)) return false;
    match.resolving=false;
    this.armPresentationClock(match,"double_flight_battle_choice",this.turnPresentationMs);
    this.sendTimes(match);
    return true;
  }

  stagePendingJump(match, state, outcome) {
    if (!super.stagePendingJump(match, state, outcome)) return false;
    match.resolving = false;
    this.armPresentationClock(match, "purple_jump_choice", this.battleWheelPresentationMs);
    this.sendTimes(match);
    return true;
  }

  performBattleSpin(match, attacker, defender, side, binding = match.activeBattleDeclaration) {
    super.performBattleSpin(match, attacker, defender, side, binding);
    if (match.phase === "started" && match.pendingRespin && !match.pendingRespin.declared) {
      match.resolving = false;
      const spin = match.record.all_moves[match.pendingRespin.spinRecordIndex]?.value;
      this.armPresentationClock(match, "respin_choice", this.battleWheelPresentationMs + repeatedSpinPresentationExtraMilliseconds(spin));
    }
  }

  completeBattleResolution(match, state, outcome, options = {}) {
    if (!super.completeBattleResolution(match, state, outcome, options)) return false;
    if (options.endTurn === false) return true;
    match.resolving = false;
    if (match.phase === "started") this.armPresentationClock(match, "battle_result", this.battlePresentationMs
      + battlePresentationExtraMilliseconds(match.record, this.battleWheelPresentationMs));
    this.sendTimes(match);
    return true;
  }

  finish(match, winner, reason) {
    if (match.phase === "finished" || match.phase === "reset") return;
    match.pendingCompletion ??= {
      match_id: match.id, mode: "human", winner, reason, finished_at: Number(this.clockSource()),
      players: match.peers.map((peer) => ({ user_id: Number(peer.user.user_id), side: peer.side })),
      record: clone(match.record),
    };
    match.phase = "finishing";
    match.activeClockSide = "";
    match.clockStartedAtMs = 0;
    this.commitCompletion(match);
  }

  commitCompletion(match) {
    // Commit before publishing match_finish or allowing HTTP result access.
    // A transient durable-store failure leaves the immutable pending outcome
    // for a bounded-cadence retry instead of crashing a socket data callback.
    try {
      const result = this.onMatchFinished?.(clone(match.pendingCompletion));
      if (result && typeof result.then === "function") throw new Error("match_completion_callback_must_be_synchronous");
    } catch {
      match.completionRetryAt = Number(this.clockSource()) + 1000;
      match.persistenceError = "match_completion_commit_failed";
      return;
    }
    const completion = match.pendingCompletion;
    match.finishedAt = completion.finished_at;
    match.persistenceError = "";
    super.finish(match, completion.winner, completion.reason);
    delete match.pendingCompletion;
  }

  expireState() {
    const now = Number(this.clockSource());
    for (const [id, entry] of this.waiting) {
      if (entry.expiresAt <= now || !this.sessionIsAuthorized(entry.session, id)) this.waiting.delete(id);
    }
    for (const [ticket, grant] of this.tickets) {
      if (grant.expiresAt <= now || !this.sessionIsAuthorized(grant.session, grant.userId)) this.tickets.delete(ticket);
    }
    for (const [hash, session] of this.sessionUsers) {
      if (now - session.lastSeenAt > 24 * 60 * 60 * 1000) this.sessionUsers.delete(hash);
    }
    for (const match of this.matches.values()) this.expireMatch(match, now);
  }

  expireMatch(match, now) {
    for (const peer of match.peers) {
      if (peer.socket && !this.sessionIsAuthorized(peer.session, peer.user.user_id)) this.closeRevokedPeer(match, peer);
    }
    if (match.phase === "finishing" && now >= match.completionRetryAt) this.commitCompletion(match);
    if (match.phase === "found" && now - match.createdAt >= this.joinTimeoutMs) {
      match.phase = "reset";
      match.finishedAt = now;
      this.revokeTickets(match);
      for (const peer of match.peers) {
        this.activeByUser.delete(Number(peer.user.user_id));
        peer.socket?.end("matching_canceled join_timeout\n");
      }
    }
    if (match.phase === "started") {
      const disconnected = match.peers.filter((peer) => peer.disconnectedAt != null
        && now - peer.disconnectedAt >= this.reconnectGraceMs);
      if (disconnected.length > 0) {
        const earliest = disconnected.sort((a, b) => a.disconnectedAt - b.disconnectedAt)[0];
        this.finish(match, opposite(earliest.side), "disconnect");
      }
    }
    if (match.finishedAt != null && now - match.finishedAt >= this.resultRetentionMs) {
      this.revokeTickets(match);
      for (const peer of match.peers) {
        const id = Number(peer.user.user_id);
        if (this.activeByUser.get(id) === match) this.activeByUser.delete(id);
        peer.socket?.end();
      }
      this.matches.delete(match.id);
    }
  }

  closeRevokedPeer(match, peer) {
    const socket = peer.socket;
    peer.socket = null;
    peer.ready = false;
    if (peer.connectionState) peer.connectionState.terminated = true;
    if (match.phase === "started") peer.disconnectedAt ??= Number(this.clockSource());
    socket?.destroy();
  }

  tickMatchTimers() {
    super.tickMatchTimers();
    this.trainingService?.tickMatchTimers();
    this.expireState();
  }

  async close() {
    this.closed = true;
    for (const match of this.matches.values()) match.phase = "reset";
    if (this.trainingService) {
      for (const match of this.trainingService.matches.values()) match.phase = "reset";
    }
    await super.close();
  }
}
