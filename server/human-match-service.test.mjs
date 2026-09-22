import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import test from "node:test";
import { AccountStore } from "./account-store.mjs";
import { CustomMatchService, customMatchContract } from "./custom-match-engine.mjs";
import { HumanMatchService, humanMatchTimingContract, repeatedSpinPresentationExtraMilliseconds } from "./human-match-service.mjs";

const plateMasters = JSON.parse(readFileSync(new URL("../data/reference_match_plate_contract.json", import.meta.url))).plate_masters;
const users = [
  { user_id: 701, display_name: "First_Human", rating: 1270 },
  { user_id: 702, display_name: "Second_Human", rating: 1320 },
  { user_id: 703, display_name: "Unrelated_Human", rating: 1000 },
];
const sessions = ["first-private-test-session", "second-private-test-session", "unrelated-private-test-session"];
const nativeRepeatCases = JSON.parse(readFileSync(new URL("../docs/generated/mechanics-20260913/native-multispin.json", import.meta.url))).cases;
const exclusionGaugeCases = JSON.parse(readFileSync(new URL("../docs/generated/mechanics-20260913/exclusion-gauge-contract.json", import.meta.url))).cases;

test("presentation clock budgets actual repeated wheel stops, concurrent wheels and displacement", () => {
  const wheel = (count, displace = 0) => ({results:Array.from({length:count},()=>({displace}))});
  assert.equal(repeatedSpinPresentationExtraMilliseconds({spins:[wheel(1)]}),0);
  assert.equal(repeatedSpinPresentationExtraMilliseconds({spins:[wheel(3)]}),2152);
  assert.equal(repeatedSpinPresentationExtraMilliseconds({spins:[wheel(17)]}),11007);
  assert.equal(repeatedSpinPresentationExtraMilliseconds({spins:[wheel(3),wheel(3)]}),2152);
  assert.equal(repeatedSpinPresentationExtraMilliseconds({spins:[wheel(3,1)]}),3752);
});
const decks = customMatchContract.decks.map((entries, side) => ({
  deck_no: side + 1,
  figures: entries.map((entry, index) => ({ deck_index: index, item_master_id: entry.itemMasterId, model_id: entry.modelId })),
  plates: [5002, 5015, 5022, 5023, 5026, 5426],
}));

async function until(predicate, label = "condition") {
  const deadline = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class WireClient {
  constructor(socket) {
    this.socket = socket;
    this.lines = [];
    this.buffer = "";
    this.record = null;
    this.sendIndex = 0;
    this.recvIndex = -1;
    this.times = {};
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (data) => {
      this.buffer += data;
      while (this.buffer.includes("\n")) {
        const index = this.buffer.indexOf("\n");
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        this.lines.push(line);
        let command = line;
        const sequence = line.match(/^sequence (\d+) (-?\d+) (.*)$/);
        if (sequence) {
          const index = Number(sequence[1]);
          assert.ok(index > this.recvIndex, "each side's server sequence increases independently");
          this.recvIndex = index;
          command = sequence[3];
        }
        if (command.startsWith("playgame ")) {
          const snapshot = JSON.parse(command.slice(9));
          this.record = snapshot.Record;
          this.recvIndex = snapshot.ClientRecvIndex;
          this.sendIndex = snapshot.ServerRecvIndex < 0 ? 0 : snapshot.ServerRecvIndex;
          this.snapshot = snapshot;
          this.acceptPlateState(snapshot.PlateState);
          this.acceptZState(snapshot.ZState);
        } else if (command.startsWith("do_move ")) {
          assert.ok(this.record, "game_start record must precede moves");
          this.record.all_moves.push(JSON.parse(command.slice(8)));
        } else if (command.startsWith("time ")) {
          const [, side, value] = command.split(" ");
          this.times[side] = Number(value);
        } else if (command.startsWith("plate_state ")) {
          assert.ok(sequence, "plate updates share the authenticated sequenced stream");
          this.acceptPlateState(JSON.parse(command.slice(12)));
        } else if (command.startsWith("z_state ")) {
          assert.ok(sequence, "Z updates share the authenticated sequenced stream");
          this.acceptZState(JSON.parse(command.slice(8)));
        } else if (command.startsWith("match_finish ")) {
          const [, winner, reason] = command.split(" ");
          this.result = { winner, reason };
        }
      }
    });
  }

  acceptPlateState(snapshot) {
    assert.equal(snapshot.schema, 1);
    assert.equal(snapshot.match_id, String(this.record.id));
    assert.equal(snapshot.record_move_count, this.record.all_moves.length, "snapshot binds exact accepted prefix, including derived system moves");
    assert.deepEqual(snapshot.equipped, ["black", "white"].map((color) => ({ color, plates: this.record.players.find((player) => player.color === color).plates })));
    assert.deepEqual(snapshot.plate_conditions.map(({ color, plates }) => ({ color, plates: plates.map(({ id }) => id) })),
      snapshot.equipped.map(({ color, plates }) => ({ color, plates: [...plates].sort((left, right) => left - right) })));
    this.plateState = snapshot;
  }

  acceptZState(snapshot) {
    assert.equal(snapshot.schema, 1);
    assert.equal(snapshot.match_id, String(this.record.id));
    assert.equal(snapshot.record_move_count, this.record.all_moves.length, "Z state binds the complete received batch");
    assert.deepEqual(snapshot.figures, ["black", "white"].map(color => ({ color,
      pokemons: this.record.players.find(player => player.color === color).pokemons.slice()
        .sort((a,b) => a.pokemon_index-b.pokemon_index).map(pokemon => Number(pokemon.id)) })));
    this.zState = snapshot;
  }

  static async open(service, user, ticket) {
    const socket = connect({ port: service.port, host: "127.0.0.1" });
    const client = new WireClient(socket);
    await once(socket, "connect");
    socket.write(`@login ${user.user_id} ${ticket}\n`);
    await until(() => client.lines.some((line) => line.startsWith("@login ")), "TCP ticket response");
    return client;
  }

  play() { this.socket.write("playgame custom.2 evidence-base.1\n"); }

  command(command, payload = "") {
    this.sendIndex += 1;
    const line = `sequence ${this.sendIndex} ${this.recvIndex} ${command}${payload ? ` ${payload}` : ""}\n`;
    this.socket.write(line);
    return line;
  }

  move(side, value) {
    const move = { display_info: "move", selective_side: side, value };
    // Independent client follows the recovered optimistic local append/no-echo
    // contract; stream equality would fail if either peer receives an echo.
    this.record.all_moves.push(structuredClone(move));
    return this.command("do_move", JSON.stringify(move));
  }
}

async function setup(t, options = {}) {
  let now = 1_800_000_000_000;
  let nextId = 7_000_000;
  const completed = [];
  const service = new HumanMatchService({
    bindHost: "127.0.0.1", publicHost: "127.0.0.1", port: 0, plateMasters,
    moveDelayMs: 1, opponentTurnDelayMs: 1, clockSource: () => now,
    firstPresentationMs: 0, turnPresentationMs: 0, presentationSlackMs: 0,
    battlePresentationMs: 0, battleWheelPresentationMs: 0,
    matchIdSource: () => nextId++, onMatchFinished: (value) => completed.push(value),
    ...options,
  });
  await service.listen();
  t.after(() => service.close());
  return { service, completed, advance: (milliseconds) => { now += milliseconds; } };
}

async function pair(t, options = {}) {
  const fixture = await setup(t, options);
  const { service } = fixture;
  assert.equal(service.enter(sessions[0], users[0], decks[0]).status, 1);
  const found = service.enter(sessions[1], users[1], decks[1]);
  assert.equal(found.status, 3);
  assert.equal(found.online_match.game_server.plate_state_schema, 1);
  const clients = [];
  for (let index = 0; index < 2; index += 1) {
    clients.push(await WireClient.open(service, users[index], service.issueTicket(sessions[index], users[index])));
    clients[index].play();
  }
  await until(() => clients.every((client) => client.record), "both game_start snapshots");
  return { ...fixture, clients, match: service.matches.get(found.room_id) };
}

for (const name of ['v1-p0-b0-w1','v1-p6-b1-w0','v2-p0-bi1-wi1-g0','v2-p6-bi1-wi1-g0','v3-p0-b5-w5']) {
  test(`exclusion gauge over two authenticated sockets with replay and completion: ${name}`, async t => {
    const c=exclusionGaugeCases.find(row=>row.name===name);assert(c);
    const {service,completed}=await setup(t);
    service.enter(sessions[0],users[0],decks[0]);const found=service.enter(sessions[1],users[1],decks[1]);
    const match=service.matches.get(found.room_id);
    // Explicit pre-connection rule checkpoint. This tests gauge delivery from
    // seeded exclusions; it does not claim a client Curse acquisition history.
    for(const player of match.record.players){const source=c.record.players.find(row=>row.color===player.color);player.pokemons=structuredClone(source.pokemons);player.plates=[...source.plates];}
    match.record.first_player=c.record.first_player;match.turn=c.before.turn;match.plateState=null;match.zState=null;
    match.positions=new Map(c.before.pokemon_conditions.map(row=>[row.pokemon_index,row.index]));
    match.conditions=new Map(c.before.pokemon_conditions.map(row=>[row.pokemon_index,row.marker.circle]));
    match.waits=new Map(c.before.pokemon_conditions.map(row=>[row.pokemon_index,row.wait]));
    match.zGauge=Object.fromEntries(c.before.z_gauge_conditions.map(row=>[row.color,row.z_gauge]));
    const clients=[];
    for(let index=0;index<2;index++){clients.push(await WireClient.open(service,users[index],service.issueTicket(sessions[index],users[index])));clients[index].play();}
    const synced=()=>clients.every(client=>client.record?.all_moves.length===match.record.all_moves.length&&client.zState?.record_move_count===match.record.all_moves.length&&client.plateState?.record_move_count===match.record.all_moves.length);
    await until(synced,'exclusion checkpoint connected');
    for(const step of c.steps){
      const sender=step.action.selective_side==='black'?0:1,count=match.record.all_moves.length;
      const wire=clients[sender].move(step.action.selective_side,structuredClone(step.action.value));
      await until(synced,'exclusion award received by both clients');
      const effects=record=>record.all_moves.slice(count).filter(move=>move.value.type==='add_z_gauge').map(move=>move.value);
      const expected=step.effects.filter(move=>move.value.type==='add_z_gauge').map(move=>move.value);
      for(const client of clients){assert.deepEqual(effects(client.record),expected);assert.deepEqual(client.record,match.record);}
      assert.deepEqual(match.zGauge,Object.fromEntries(step.status.z_gauge_conditions.map(row=>[row.color,row.z_gauge])));
      for(const row of step.status.pokemon_conditions)assert.equal(match.positions.get(row.pokemon_index),row.index);
      const before=structuredClone(match.record);clients[sender].socket.write(wire);
      await new Promise(resolve=>setTimeout(resolve,8));assert.deepEqual(match.record,before,'duplicate cannot award gauge twice');
      const wrong=match.turn==='black'?1:0;
      clients[wrong].command('do_move',JSON.stringify({selective_side:wrong?'white':'black',value:{type:'resign'}}));
      await until(()=>clients[wrong].lines.some(line=>line.includes('stale_player_turn')));
      assert.deepEqual(match.record,before,'out-of-turn input cannot repeat a completed award');
      clients[wrong].socket.destroy();await until(()=>!match.peers[wrong].socket);
      clients[wrong]=await WireClient.open(service,users[wrong],service.issueTicket(sessions[wrong],users[wrong]));clients[wrong].play();await until(synced,'exclusion gauge reconnect');
      assert.deepEqual(clients.map(client=>client.record),[match.record,match.record]);assert.deepEqual(clients[0].zState,clients[1].zState);
    }
    const resigning=match.turn==='black'?0:1;clients[resigning].move(match.turn,{type:'resign'});
    await until(()=>clients.every(client=>client.result)&&completed.length===1);
    assert.deepEqual(clients[0].result,clients[1].result);assert.equal(clients[0].result.reason,'resign');assert.deepEqual(completed[0].record,match.record);
    assert.equal(new Set(match.positions.values()).size,12);
    t.diagnostic(JSON.stringify({case:name,real_tcp_clients:2,steps:c.steps.length,debug_seeded_exclusion:true,native_gauge_actions_matched:true,reconnected_after_each_turn:true,completed:true,live_service_touched:false}));
  });
}

for (const suffix of ["pNTxjA-tackle", "MwInsm-ice-shard-followup", "lpQUX7-double-chance-repeat", "lpQUX7-double-chance-decline", "MwPvTP-blue-corrected"]) {
  test(`native mechanics over two real sockets, reconnect, rejection and completion: ${suffix}`, async t => {
    const evidence = nativeRepeatCases.find(entry => entry.name.endsWith(suffix));assert.ok(evidence);
    const final = evidence.continuations?.at(-1) ?? evidence;
    const expectedSpins = final.record.all_moves.filter(move => move.value.type === "spin");
    const units = new Map();
    for (const move of expectedSpins) for (const spin of move.value.spins) {
      units.set(spin.pokemon, [...(units.get(spin.pokemon) || []), ...spin.results.map(result => result.num)]);
    }
    const {service, completed} = await setup(t, {spinUnitSource: (maximum, pokemon) => {
      const unit = units.get(pokemon)?.shift();assert.ok(Number.isInteger(unit) && unit >= 0 && unit < maximum);return unit;
    }});
    service.enter(sessions[0], users[0], decks[0]);
    const found = service.enter(sessions[1], users[1], decks[1]);
    const match = service.matches.get(found.room_id);
    // Trusted, pre-connection fixture definition, before any accepted action.
    // Both independent clients obtain these exact wheels through playgame.
    for (const player of match.record.players) {
      const source = final.record.players.find(row => row.color === player.color);
      player.pokemons = structuredClone(source.pokemons);player.plates = [...source.plates];
    }
    match.record.seed = final.record.seed;match.record.seeds = [...final.record.seeds];match.plateState = null;match.zState = null;
    const clients = [];
    for (let side = 0; side < 2; side++) {
      clients.push(await WireClient.open(service, users[side], service.issueTicket(sessions[side], users[side])));clients[side].play();
    }
    const synced = () => clients.every(client => client.record?.all_moves.length === match.record.all_moves.length
      && client.plateState?.record_move_count === match.record.all_moves.length && client.zState?.record_move_count === match.record.all_moves.length);
    await until(synced, "native fixture initial state");
    let expectedSpinCount = 0;
    for (const action of final.record.all_moves) {
      if (action.selective_side === "both") {
        expectedSpinCount++;
        await until(() => match.record.all_moves.filter(move => move.value.type === "spin").length >= expectedSpinCount, "authoritative real spin");
        await until(synced);
        assert.deepEqual(match.record.all_moves.filter(move => move.value.type === "spin")[expectedSpinCount-1].value, action.value);
        if (match.pendingRespin && !match.pendingRespin.declared) {
          const extra = repeatedSpinPresentationExtraMilliseconds(action.value);
          assert.equal(match.presentationClock.reason,"respin_choice");
          assert.equal(match.presentationClock.deadline - Number(service.clockSource()),extra,"real connection gets every repeated stop before its clock deadline");
        }
      } else {
        await until(() => match.turn === action.selective_side && !match.resolving, "native player decision boundary");
        const side = action.selective_side === "black" ? 0 : 1;
        const wire = clients[side].move(action.selective_side, structuredClone(action.value));
        await until(synced);
        const before = structuredClone(match.record);
        clients[side].socket.write(wire); // Exact retransmission, no optimistic second append.
        await new Promise(resolve => setTimeout(resolve, 8));
        // Timed authority may append a Spin; the submitted player command itself
        // must still occur once, and both streams must converge afterwards.
        const count = record => record.all_moves.filter(move => JSON.stringify(move.value) === JSON.stringify(action.value)).length;
        assert.equal(count(match.record),count(before),"retransmission never repeats the player action");
        await until(synced);
      }
      assert.deepEqual(clients.map(client => client.record),[match.record,match.record]);
    }
    await until(() => !match.battleResolutionPending && !match.resolving);
    await until(synced);
    assert([...units.values()].every(queue => queue.length === 0));
    assert.deepEqual(match.record.all_moves.filter(move => move.value.type === "spin").map(move => move.value),expectedSpins.map(move => move.value));
    for (const pokemon of final.status.pokemon_conditions) {
      assert.equal(match.positions.get(pokemon.pokemon_index),pokemon.index);
      assert.equal(match.conditions.get(pokemon.pokemon_index),pokemon.marker.circle);
      assert.equal(match.waits.get(pokemon.pokemon_index),pokemon.wait);
    }
    const beforeRejected = structuredClone(match.record),wrongSide = match.turn === "black" ? 1 : 0;
    clients[wrongSide].command("do_move",JSON.stringify({selective_side:wrongSide ? "white":"black",value:{type:"resign"}}));
    await until(() => clients[wrongSide].lines.some(line => line.includes("stale_player_turn")));
    assert.deepEqual(match.record,beforeRejected);
    if (suffix.endsWith("blue-corrected")) {
      clients[0].command("do_move",JSON.stringify({selective_side:"black",value:{type:"mp_move",route:[15,11]}}));
      await until(() => clients[0].lines.some(line => line.includes("illegal_player_movement")));
      assert.deepEqual(match.record,beforeRejected,"occupied endpoint refused over the authenticated wire");
    }
    for (const side of [0,1]) {
      if (side !== 1 && !clients[side].socket.destroyed && !match.peers[side].connectionState?.terminated) continue;
      clients[side].socket.destroy();await until(() => !match.peers[side].socket);
      clients[side] = await WireClient.open(service,users[side],service.issueTicket(sessions[side],users[side]));clients[side].play();
    }
    await until(synced);assert.deepEqual(clients.map(client => client.record),[match.record,match.record]);
    const retiringSide = match.turn,retiring = retiringSide === "black" ? 0 : 1;
    clients[retiring].move(retiringSide,{type:"resign"});
    await until(() => clients.every(client => client.result) && completed.length === 1);
    assert.deepEqual(clients[0].result,clients[1].result);assert.equal(clients[0].result.reason,"resign");
    assert.equal(clients[0].result.winner,retiring ? "black":"white");
    assert.deepEqual(completed[0].record,match.record);
    assert.equal(new Set(match.positions.values()).size,12);
  });
}

test("native1717 full prefix travels over two real sockets with selected, moved, pre-spin and finalized reconnects", async t => {
  const archive = new URL("../docs/generated/z-skill-lifecycle-20260910/native-followups/", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", archive)));
  assert.equal(manifest.complete, true);
  const query = manifest.queries.find(row => row.label === "white-field-purple1717-after-auto0" && row.operation === "status");
  const data = {};
  for (const kind of ["request", "response"]) {
    const bytes = readFileSync(new URL(query[kind + "_file"], archive));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), query[kind + "_sha256"]);
    data[kind] = JSON.parse(bytes);
  }
  const record = data.request.record;
  const nativeSpin = record.all_moves.at(-1);
  assert.equal(nativeSpin.value.type, "spin");
  const units = [6, 0].map(actor => nativeSpin.value.spins.find(row => row.pokemon === actor).results[0].num);
  const {service} = await setup(t, {spinUnitSource: maximum => {
    const value = units.shift(); assert.ok(value >= 0 && value < maximum); return value;
  }});
  service.enter(sessions[0], users[0], decks[0]);
  const found = service.enter(sessions[1], users[1], decks[1]);
  assert.equal(found.online_match.game_server.z_state_schema, 1);
  const match = service.matches.get(found.room_id);
  for (const player of match.record.players) {
    const source = record.players.find(row => row.color === player.color);
    player.pokemons = structuredClone(source.pokemons); player.plates = [...source.plates];
  }
  let heldBattle;
  const resolveBattle = service.resolveBattle.bind(service);
  service.resolveBattle = (value, action) => { assert.equal(value, match); heldBattle = action; };
  const clients = [];
  for (let side=0; side<2; side++) {
    clients.push(await WireClient.open(service, users[side], service.issueTicket(sessions[side], users[side])));
    clients[side].play();
  }
  const synced = () => clients.every(client => client.record?.all_moves.length === match.record.all_moves.length
    && client.zState?.record_move_count === match.record.all_moves.length);
  await until(synced);
  const phases = [];
  async function reconnect(side, expectedPhase) {
    await until(synced);
    const expected = structuredClone(clients[side].zState);
    assert.equal(expected.active?.phase ?? null, expectedPhase);
    const before = structuredClone(match.record), gaugeBefore = structuredClone(match.zGauge);
    clients[side].socket.destroy();
    await until(() => !match.peers[side].socket);
    clients[side] = await WireClient.open(service, users[side], service.issueTicket(sessions[side], users[side]));
    clients[side].play();
    await until(synced);
    assert.deepEqual(clients[side].snapshot.ZState, expected, "reconnect keeps exact selected power/declaration/phase");
    assert.deepEqual(match.record, before, "reconnect cannot activate or consume twice");
    assert.deepEqual(match.zGauge, gaugeBefore);
    assert.deepEqual(clients.map(client => client.record), [match.record, match.record]);
    phases.push(expectedPhase);
  }
  for (const [index, action] of record.all_moves.slice(0, -1).entries()) {
    clients[action.selective_side === "black" ? 0 : 1].move(action.selective_side, action.value);
    await until(() => match.record.all_moves.filter(row => row.value.type !== "add_z_gauge").length === index + 1);
    await until(synced);
    if (action.value.type === "z_skill") {
      assert.equal(match.zGauge.white, 100); await reconnect(1, "selected");
    } else if (clients[0].zState.active?.phase === "battle_choice") {
      assert.equal(match.zGauge.white, 100); await reconnect(0, "battle_choice");
    } else if (action.value.type === "declare_battle") {
      await until(() => Boolean(heldBattle)); await reconnect(1, "resolving");
    }
  }
  assert.ok(heldBattle); resolveBattle(match, heldBattle);
  await until(() => match.turn === "black" && synced());
  await reconnect(0, null);
  assert.deepEqual(phases, ["selected", "battle_choice", "resolving", null]);
  assert.deepEqual(match.zGauge, {black: 100, white: 0});
  assert.equal(match.waits.get(0), 8); assert.equal(match.waits.get(6), 0);
  for (const row of data.response.status.pokemon_conditions) {
    assert.deepEqual([match.positions.get(row.pokemon_index), match.waits.get(row.pokemon_index), match.conditions.get(row.pokemon_index)],
      [row.index, row.wait, row.marker.circle]);
  }
  assert.equal(units.length, 0);
});

test("native Rock Slide pending KO survives real socket reconnect and only its scheduled system continuation completes battle", async (t) => {
  const archive = new URL("../docs/generated/z-skill-lifecycle-20260910/native-rock-adjacent-rehit/", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", archive)));
  const query = manifest.queries.find((row) => row.label === "adjacent-draw-rehit-second-resolved1" && row.operation === "status");
  const bytes = readFileSync(new URL(query.request_file, archive));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), query.request_sha256);
  const nativeRecord = JSON.parse(bytes).record;
  const units = [];
  let declaration;
  for (const move of nativeRecord.all_moves) {
    if (move.value.type === "declare_battle") declaration = move;
    if (move.value.type === "spin") for (const pokemon of [declaration.value.from_pokemon, declaration.value.to_pokemon]) {
      units.push(move.value.spins.find((row) => row.pokemon === pokemon).results[0].num);
    }
  }
  const { service } = await setup(t, { spinUnitSource: () => units.shift(), knockoutChoiceSource: () => 0, battlePresentationMs: 1000 });
  service.enter(sessions[0], users[0], decks[0]);
  const found = service.enter(sessions[1], users[1], decks[1]);
  const match = service.matches.get(found.room_id);
  // Authored fixture controls only, before either initial PlayGame. There is
  // no field, Wait, gauge or accepted-record hydration at any checkpoint.
  for (const player of match.record.players) {
    const native = nativeRecord.players.find((row) => row.color === player.color);
    player.pokemons = structuredClone(native.pokemons);
    player.plates = [...native.plates];
  }
  let scheduled;
  service.schedulePendingKnockouts = (_match, pending) => { scheduled = pending; };
  const clients = [];
  for (let side = 0; side < 2; side += 1) {
    clients.push(await WireClient.open(service, users[side], service.issueTicket(sessions[side], users[side])));
    clients[side].play();
  }
  await until(() => clients.every((client) => client.record));
  let actionCount = 0;
  for (const move of nativeRecord.all_moves.slice(0, -1)) {
    actionCount += 1;
    if (move.selective_side !== "both") clients[move.selective_side === "black" ? 0 : 1].move(move.selective_side, move.value);
    await until(() => match.record.all_moves.filter((row) => row.value.type !== "add_z_gauge").length >= actionCount,
      `native accepted prefix action ${actionCount}`);
    await until(() => clients.every((client) => client.record.all_moves.length === match.record.all_moves.length
      && client.plateState.record_move_count === match.record.all_moves.length), `native stream batch ${actionCount}`);
  }
  await until(() => scheduled && clients.every((client) => client.record.all_moves.length === match.record.all_moves.length));
  assert.equal(match.pendingKnockouts, scheduled);
  assert.equal(match.turn, "white");
  assert.equal(match.resolving, true);
  assert.equal(match.activeClockSide, "");
  assert.equal(match.presentationClock, null, "spin must not arm the final result clock while a KO is pending");
  assert.deepEqual([0, 1].map((pokemon) => [match.positions.get(pokemon), match.waits.get(pokemon), match.conditions.get(pokemon)]),
    [[10, 3, "faint"], [14, 3, "faint"]]);
  const before = structuredClone(match.record);
  const gaugeBefore = structuredClone(match.zGauge);
  assert.equal(service.performPendingKnockouts(match, { ...scheduled }), false, "stale callback identity is not authoritative");
  assert.equal(service.performPendingKnockouts({ ...match, phase: "finished" }, scheduled), false, "finished match cannot resume a stale scheduled effect");
  assert.equal(service.performPendingKnockouts({ ...match, record: { ...match.record, all_moves: [...match.record.all_moves, {}] } }, scheduled), false,
    "changed accepted-record prefix invalidates a pending callback");
  assert.equal(service.performPendingKnockouts(match, scheduled, { selective_side: "both", value: { type: "knockedout_move", from: 14, to: 41 } }), false);
  assert.deepEqual(match.record, before);
  clients[0].socket.destroy();
  await until(() => !match.peers[0].socket);
  const resume = async () => {
    const client = await WireClient.open(service, users[0], service.issueTicket(sessions[0], users[0]));
    client.play();
    await until(() => client.record);
    assert.deepEqual(client.record, before, "pending phase is preserved in the real accepted spin prefix");
    assert.deepEqual(client.snapshot.ZGaugeConditions, ["black", "white"].map((color) => ({ color, z_gauge: gaugeBefore[color] })));
    assert.equal(client.snapshot.ClockPolicy.active_side, "");
    return client;
  };
  const forged = await resume();
  forged.command("do_move", JSON.stringify(nativeRecord.all_moves.at(-1)));
  await until(() => forged.lines.some((line) => line.startsWith("move_rejected ")));
  assert.deepEqual(match.record, before, "public player transport cannot submit a both-side system KO");
  await until(() => !match.peers[0].socket);
  clients[0] = await resume();
  // Exercise the production timer callback after holding only its scheduling
  // boundary long enough to inspect and reconnect; resolution is not replaced.
  CustomMatchService.prototype.schedulePendingKnockouts.call(service, match, scheduled);
  await until(() => !match.pendingKnockouts && clients.every((client) => client.record.all_moves.length === match.record.all_moves.length));
  assert.deepEqual(clients.map((client) => client.record), [match.record, match.record]);
  assert.deepEqual(match.record.all_moves.slice(before.all_moves.length).map(({ value }) => value.type),
    ["knockedout_move", "add_z_gauge", "add_z_gauge", "add_z_gauge", "add_z_gauge"]);
  assert.deepEqual([0, 1, 6, 7].map((pokemon) => [match.positions.get(pokemon), match.waits.get(pokemon), match.conditions.get(pokemon)]),
    [[40, 2, "normal"], [41, 2, "normal"], [6, 0, "normal"], [9, 2, "normal"]]);
  assert.equal(match.turn, "black");
  assert.equal(match.resolving, false);
  assert.equal(match.presentationClock.reason, "battle_result");
  assert.equal(units.length, 0);
  const completedRecord = structuredClone(match.record);
  assert.equal(service.performPendingKnockouts(match, scheduled), false, "late duplicate callback cannot award or move twice");
  assert.deepEqual(match.record, completedRecord);
});

test("native three-KO preserves all scheduled Center phases across real reconnects", async (t) => {
  const archive = new URL("../docs/generated/z-skill-lifecycle-20260910/native-rock-three-ko/", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", archive)));
  const readPair = (label, operation) => {
    const query = manifest.queries.find((row) => row.label === label && row.operation === operation);
    const pair = {};
    for (const kind of ["request", "response"]) {
      const bytes = readFileSync(new URL(query[`${kind}_file`], archive));
      assert.equal(createHash("sha256").update(bytes).digest("hex"), query[`${kind}_sha256`]);
      pair[kind] = JSON.parse(bytes);
    }
    return pair;
  };
  const nativeRecord = readPair("three-ko-second-resolved3", "status").request.record;
  const units = [];
  let declaration;
  for (const move of nativeRecord.all_moves) {
    if (move.value.type === "declare_battle") declaration = move;
    if (move.value.type === "spin") for (const pokemon of [declaration.value.from_pokemon, declaration.value.to_pokemon]) {
      units.push(move.value.spins.find((row) => row.pokemon === pokemon).results[0].num);
    }
  }
  const { service } = await setup(t, { spinUnitSource: () => units.shift(), battlePresentationMs: 1000 });
  service.enter(sessions[0], users[0], decks[0]);
  const found = service.enter(sessions[1], users[1], decks[1]);
  const match = service.matches.get(found.room_id);
  for (const player of match.record.players) {
    const native = nativeRecord.players.find((row) => row.color === player.color);
    player.pokemons = structuredClone(native.pokemons);
    player.plates = [...native.plates];
  }
  const stageKnockouts = service.stagePendingKnockouts.bind(service);
  let stageIndex = 0;
  service.stagePendingKnockouts = (current,state,outcome,targets) => {
    const expected = readPair(`three-ko-second-resolved${++stageIndex}`, "output_effects").response.effect_moves.find(move=>move.selective_side==="both");
    assert(expected);
    const index = expected.value.type==="spot_move" ? 0 : targets.findIndex(target=>target.from===expected.value.from);
    assert(index>=0);
    service.knockoutChoiceSource = count=>{assert(index<count);return index};
    return stageKnockouts(current,state,outcome,targets);
  };
  let scheduled;
  service.schedulePendingKnockouts = (_match, pending) => { scheduled = pending; };
  const clients = [];
  for (let side = 0; side < 2; side += 1) {
    clients.push(await WireClient.open(service, users[side], service.issueTicket(sessions[side], users[side])));
    clients[side].play();
  }
  await until(() => clients.every((client) => client.record));
  const prefix = nativeRecord.all_moves.slice(0, nativeRecord.all_moves.findIndex((move) => move.value.type === "knockedout_move"));
  for (const [index, move] of prefix.entries()) {
    if (move.selective_side !== "both") clients[move.selective_side === "black" ? 0 : 1].move(move.selective_side, move.value);
    await until(() => match.record.all_moves.filter((row) => row.value.type !== "add_z_gauge").length >= index + 1);
    await until(() => clients.every((client) => client.record.all_moves.length === match.record.all_moves.length
      && client.plateState.record_move_count === match.record.all_moves.length));
  }
  const stale = [];
  for (let phase = 1; phase <= 3; phase += 1) {
    const pending = match.pendingKnockouts;
    assert.equal(pending, scheduled);
    assert.ok(pending);
    assert.equal(match.resolving, true);
    assert.equal(match.activeClockSide, "");
    assert.equal(match.presentationClock, null);
    const before = structuredClone(match.record);
    const gaugeBefore = structuredClone(match.zGauge);
    clients[0].socket.destroy();
    await until(() => !match.peers[0].socket);
    clients[0] = await WireClient.open(service, users[0], service.issueTicket(sessions[0], users[0]));
    clients[0].play();
    await until(() => clients[0].record);
    assert.deepEqual(clients[0].record, before, `phase ${phase} replay is the exact accepted record`);
    assert.deepEqual(clients[0].snapshot.ZGaugeConditions, ["black", "white"].map((color) => ({ color, z_gauge: gaugeBefore[color] })));
    assert.equal(clients[0].snapshot.ClockPolicy.active_side, "");
    assert.equal(service.performPendingKnockouts(match, { ...pending }), false);
    assert.equal(service.performPendingKnockouts(match, pending, { selective_side: "both", value: { ...pending.firstMove.value, to: 43 } }), false);
    assert.equal(service.performPendingKnockouts(match, pending, { selective_side: "both", value: {
      ...pending.firstMove.value, type: pending.firstMove.value.type === "spot_move" ? "knockedout_move" : "spot_move",
    } }), false);
    for (const previous of stale) assert.equal(service.performPendingKnockouts(match, previous), false);
    assert.deepEqual(match.record, before);
    CustomMatchService.prototype.schedulePendingKnockouts.call(service, match, pending);
    await until(() => match.pendingKnockouts !== pending && clients.every((client) => client.record.all_moves.length === match.record.all_moves.length
      && client.plateState.record_move_count === match.record.all_moves.length));
    const label = `three-ko-second-resolved${phase}`;
    const native = readPair(label, "status").response.status;
    const effects = readPair(label, "output_effects").response.effect_moves;
    // Owned records also carry the existing presentation-only display_info;
    // compare the full native action side/value, not that transport annotation.
    assert.deepEqual(match.record.all_moves.slice(before.all_moves.length).map(({ selective_side, value }) => ({ selective_side, value })),
      effects.filter((move) => move.selective_side === "both" || move.value.type === "add_z_gauge"),
      `phase ${phase} preserves exact authoritative inputs and ordered awards only`);
    assert.equal(match.turn, native.turn);
    assert.deepEqual(match.zGauge, Object.fromEntries(native.z_gauge_conditions.map(({ color, z_gauge }) => [color, z_gauge])));
    for (const row of native.pokemon_conditions) {
      assert.deepEqual([match.positions.get(row.pokemon_index), match.waits.get(row.pokemon_index), match.conditions.get(row.pokemon_index)],
        [row.index, row.wait, row.marker.circle]);
    }
    assert.deepEqual(clients.map((client) => client.record), [match.record, match.record]);
    assert.equal(Boolean(match.pendingKnockouts), phase < 3);
    assert.equal(match.resolving, phase < 3);
    assert.equal(service.performPendingKnockouts(match, pending), false);
    stale.push(pending);
  }
  assert.equal(match.presentationClock.reason, "battle_result");
  assert.equal(units.length, 0);
});

test("duplicate equipped copies publish sorted native state and survive authenticated reconnect", async (t) => {
  const { service } = await setup(t);
  const equipped = [5026, 5002, 5026];
  const blackDeck = { ...decks[0], plates: equipped };
  const whiteDeck = { ...decks[1], plates: [5015] };
  service.enter(sessions[0], users[0], blackDeck);
  const found = service.enter(sessions[1], users[1], whiteDeck);
  assert.equal(found.online_match.game_server.plate_state_schema, 1);
  const black = await WireClient.open(service, users[0], service.issueTicket(sessions[0], users[0]));
  const white = await WireClient.open(service, users[1], service.issueTicket(sessions[1], users[1]));
  black.play(); white.play();
  await until(() => black.record && white.record);
  assert.deepEqual(black.snapshot.PlateState.equipped.map(({ plates }) => plates), [equipped, [5015]], "snapshot uses final independently selected white deck");
  black.move("black", { type: "declare_plate", plate_id: 5026, value: { type: "spot_move", from: 28, to: 16 } });
  const match = service.matches.get(found.room_id);
  await until(() => match.turn === "white" && [black, white].every((client) => client.plateState.record_move_count === match.record.all_moves.length));
  const expected = [{ id: 5002, condition: "unused", turns: -1 }, { id: 5026, condition: "used", turns: -1 }, { id: 5026, condition: "unused", turns: -1 }];
  assert.deepEqual(black.plateState.plate_conditions[0].plates, expected);
  assert.deepEqual(white.plateState.plate_conditions[0].plates, expected);
  const before = structuredClone(black.plateState);
  black.socket.destroy();
  await until(() => !match.peers[0].socket);
  const resumed = await WireClient.open(service, users[0], service.issueTicket(sessions[0], users[0]));
  resumed.play();
  await until(() => resumed.record);
  assert.deepEqual(resumed.snapshot.PlateState, before, "resume never recreates used copies as unused");
  assert.deepEqual(resumed.record, match.record);
});

test("human queue does not fabricate an opponent; refresh, expiry and cancel stay account-scoped", async (t) => {
  const { service, advance } = await setup(t, { queueLeaseMs: 100 });
  assert.equal(service.poll(sessions[0], users[0]).status, 99, "poll alone never enters");
  const entry = service.enter(sessions[0], users[0], decks[0]);
  assert.equal(entry.status, 1);
  assert.equal(service.poll(sessions[0], users[0]).status, 1);
  assert.equal(service.enter("new-bearer-same-account", users[0], decks[1]).room_id, entry.room_id);
  assert.equal(service.waiting.size, 1, "one account cannot match itself through two sessions");
  assert.equal(service.cancel(sessions[2], users[2]), true);
  assert.equal(service.waiting.size, 1);
  advance(101);
  assert.equal(service.poll(sessions[0], users[0]).status, 99);
  assert.equal(service.enter(sessions[0], users[0], decks[0]).status, 1);
  assert.equal(service.cancel("new-bearer-same-account", users[0]), true);
  assert.equal(service.waiting.size, 0);
  assert.throws(() => service.enter(sessions[0], users[1], decks[1]), /account_mismatch/);
  assert.throws(() => service.enter("anonymous", null, decks[0]), /authentication_required/);
});

test("two sockets wait for both game_start records and play a complete shared match to goal/result/reset", async (t) => {
  const { service } = await setup(t);
  service.enter(sessions[0], users[0], decks[0]);
  const found = service.enter(sessions[1], users[1], decks[1]);
  const black = await WireClient.open(service, users[0], service.issueTicket(sessions[0], users[0]));
  black.play();
  await until(() => service.matches.get(found.room_id).peers[0].ready);
  assert.equal(black.record, null, "first client cannot start while the opponent has not loaded");
  assert.equal(service.cancel(sessions[1], users[1]), false, "pairing wins a cancel race");
  assert.throws(() => service.reset(sessions[1], users[1]), /before_finish/);
  const white = await WireClient.open(service, users[1], service.issueTicket(sessions[1], users[1]));
  white.play();
  await until(() => black.record && white.record);
  const match = service.matches.get(found.room_id);
  assert.deepEqual(black.record, white.record);
  assert.deepEqual(black.record.players.map((player) => player.id), ["701", "702"]);
  assert.deepEqual(black.record.players[1].pokemons.map((pokemon) => pokemon.pokemon_index), [6, 7, 8, 9, 10, 11]);
  const turns = [
    [black, "black", [28, 27]], [white, "white", [34, 0, 7]],
    [black, "black", [27, 20, 15]], [white, "white", [7, 0, 1]],
    [black, "black", [15, 11, 6]], [white, "white", [1, 0, 7]],
    [black, "black", [6, 5, 4]], [white, "white", [7, 0, 1]],
    [black, "black", [4, 3]],
  ];
  for (const [client, side, route] of turns) {
    const before = match.record.all_moves.length;
    client.move(side, { route, type: "mp_move" });
    await until(() => match.record.all_moves.length > before && black.record.all_moves.length === match.record.all_moves.length
      && white.record.all_moves.length === match.record.all_moves.length, `shared ${side} move ${route}`);
    assert.deepEqual(black.record, match.record);
    assert.deepEqual(white.record, match.record);
  }
  await until(() => black.result && white.result);
  assert.deepEqual(black.result, { winner: "black", reason: "goal" });
  assert.deepEqual(white.result, black.result);
  assert.equal(match.record.all_moves.filter((move) => move.value.type === "mp_move").length, 9);
  assert.equal(match.record.all_moves.length, 17, "exactly nine player moves and eight server Z transitions");
  assert.deepEqual(service.result(sessions[0], match.id, users[0]).won, true);
  assert.deepEqual(service.result(sessions[1], match.id, users[1]).won, false);
  assert.throws(() => service.result(sessions[2], match.id, users[2]), /not_participant/);
  assert.equal(service.reset(sessions[0], users[0]), true);
  assert.equal(service.poll(sessions[0], users[0]).status, 99);
  assert.equal(service.poll(sessions[1], users[1]).status, 11);
  assert.equal(service.result(sessions[1], match.id, users[1]).player_color, "white");
  assert.equal(service.reset(sessions[1], users[1]), true);
  assert.equal(service.enter(sessions[0], users[0], decks[0]).status, 1);
});

test("real account store decks drive both participants without accepting a forged client loadout", async (t) => {
  const starterFigures = decks[0].figures.map((figure) => ({ ...figure, level: 1 }));
  const store = new AccountStore({ databasePath: ":memory:", starterFigures,
    starterPlateIds: [5015, 5026], plateMasters, rewardCatalog: starterFigures });
  t.after(() => store.close());
  const first = store.createAccount({ email: "pvp-one@example.test", displayName: "PvP_First", password: "safe test password one" });
  const second = store.createAccount({ email: "pvp-two@example.test", displayName: "PvP_Second", password: "safe test password two" });
  store.updateDeck(second.user_id, { deck_no: 2, figures: [...starterFigures].reverse(), plates: [5026] });
  const { service } = await setup(t, { loadDeck: (id, deckNo) => store.battleDeck(id, deckNo) });
  service.enter("account-first", first, { ...decks[1], deck_no: 1 });
  const found = service.enter("account-second", second, { ...decks[1], deck_no: 2, plates: [999999] });
  const record = service.matches.get(found.room_id).record;
  assert.deepEqual(record.players[0].pokemons.map((pokemon) => pokemon.id), starterFigures.map((figure) => figure.item_master_id));
  assert.deepEqual(record.players[1].pokemons.map((pokemon) => pokemon.id), starterFigures.map((figure) => figure.item_master_id).reverse());
  assert.deepEqual(record.players[1].plates, [5026]);
  assert.equal(found.online_match.player2.deck_no, 2);
  assert.equal(found.online_match.player2.user_id, second.user_id);
  assert.deepEqual(found.online_match.player2.deck.user_deck_figures.map((figure) => figure.figure_user_items[0].item_master_id),
    starterFigures.map((figure) => figure.item_master_id).reverse());
});

test("tickets are single-use and cannot authenticate the other side or an unrelated account", async (t) => {
  const { service } = await setup(t);
  service.enter(sessions[0], users[0], decks[0]);
  service.enter(sessions[1], users[1], decks[1]);
  assert.throws(() => service.issueTicket(sessions[2], users[2]), /unavailable/);
  const ticket = service.issueTicket(sessions[0], users[0]);
  const wrong = await WireClient.open(service, users[1], ticket);
  assert.ok(wrong.lines.includes("@login rejected"));
  const replay = await WireClient.open(service, users[0], ticket);
  assert.ok(replay.lines.includes("@login rejected"));
  const fresh = await WireClient.open(service, users[0], service.issueTicket(sessions[0], users[0]));
  assert.ok(fresh.lines.includes("@login ok"));
});

test("an authenticated WebSocket upgrade cannot consume a ticket from another session/account", async (t) => {
  const { service } = await setup(t);
  service.enter(sessions[0], users[0], decks[0]);
  service.enter(sessions[1], users[1], decks[1]);
  const ticket = service.issueTicket(sessions[0], users[0]);
  const writes = [];
  const stream = {
    authenticatedSession: sessions[1], authenticatedUserId: users[1].user_id,
    end: (line) => writes.push(line),
  };
  service.handleLine(stream, {}, `@login ${users[0].user_id} ${ticket}`);
  assert.deepEqual(writes, ["@login rejected\n"]);
  assert.equal(service.tickets.has(ticket), false);
});

test("both human sides relay accepted plate and battle moves; only the server chooses spin values", async (t) => {
  const { service, clients: [black, white], match } = await pair(t, { spinUnitSource: () => 0 });
  const moves = [
    [black, "black", { type: "declare_plate", plate_id: 5026, value: { type: "spot_move", from: 28, to: 16 } }],
    [white, "white", { type: "declare_plate", plate_id: 5026, value: { type: "spot_move", from: 34, to: 1 } }],
    [black, "black", { type: "mp_move", route: [16, 12, 7] }],
    [white, "white", { type: "mp_move", route: [1, 0] }],
  ];
  for (const [client, side, move] of moves) {
    const previous = match.record.all_moves.length;
    client.move(side, move);
    await until(() => match.record.all_moves.length > previous && black.record.all_moves.length === match.record.all_moves.length
      && white.record.all_moves.length === match.record.all_moves.length);
  }
  assert.equal(match.turn, "white");
  white.move("white", { type: "declare_battle", from_pokemon: 6, to_pokemon: 0 });
  await until(() => match.turn === "black" && white.record.all_moves.length === match.record.all_moves.length
    && black.record.all_moves.length === match.record.all_moves.length);
  const spins = match.record.all_moves.filter((move) => move.value.type === "spin");
  assert.equal(spins.length, 1);
  assert.equal(spins[0].selective_side, "both");
  assert.deepEqual(spins[0].value.spins.map((spin) => spin.pokemon), [0, 6]);
  assert.deepEqual(black.record, match.record);
  assert.deepEqual(white.record, match.record);
  white.command("lose", "forged_reason");
  await until(() => black.result && white.result);
  assert.deepEqual(black.result, { winner: "black", reason: "resign" });
});

test("opponent spoofing, unsupported system moves, and illegal occupancy never mutate authoritative state", async (t) => {
  for (const value of [
    { selective_side: "white", value: { type: "mp_move", route: [34, 0] } },
    { selective_side: "black", value: { type: "spin", spins: [{ pokemon: 6, results: [{ num: 20 }] }] } },
    { selective_side: "black", value: { type: "mp_move", route: [28, 29] } },
  ]) {
    const { service, clients: [black], match } = await pair(t);
    black.command("do_move", JSON.stringify(value));
    await until(() => black.lines.some((line) => line.startsWith("move_rejected ")));
    assert.equal(match.record.all_moves.length, 0);
    assert.equal(match.positions.get(0), 28);
    assert.equal(match.turn, "black");
  }
});

test("duplicate sequences are idempotent and reconnect snapshots preserve record, clocks and side", async (t) => {
  const { service, clients: [black, white], match, advance } = await pair(t);
  const sent = black.move("black", { type: "mp_move", route: [28, 27] });
  await until(() => match.turn === "white" && white.record.all_moves.length === 2);
  black.socket.write(sent);
  white.socket.write("ping\n");
  advance(1234);
  service.tickMatchTimers();
  await until(() => white.times.white === 298766);
  assert.equal(match.record.all_moves.length, 2);
  const whiteIndex = match.peers[1].serverSendIndex;
  white.socket.destroy();
  await until(() => match.peers[1].socket === null);
  const renewed = "renewed-second-bearer";
  assert.equal(service.poll(renewed, users[1]).room_id, match.id);
  const reconnected = await WireClient.open(service, users[1], service.issueTicket(renewed, users[1]));
  reconnected.play();
  await until(() => reconnected.record);
  assert.deepEqual(reconnected.record, match.record);
  assert.equal(reconnected.snapshot.WhiteMilliSecondsTimeLimit, 298766);
  assert.equal(reconnected.snapshot.ClientRecvIndex, whiteIndex);
  reconnected.move("white", { type: "mp_move", route: [34, 0, 7] });
  await until(() => match.turn === "black" && black.record.all_moves.length === match.record.all_moves.length);
  assert.deepEqual(black.record, match.record);
  assert.deepEqual(reconnected.record, match.record);
});

test("the server clock cannot be extended or assigned to the opponent by either client", async (t) => {
  const { service, clients: [black, white], match, advance, completed } = await pair(t, { initialTimeMs: 1000 });
  white.socket.write("timer_start white\ntime 999999999\n");
  black.socket.write("time 999999999\n");
  advance(1001);
  service.tickMatchTimers();
  await until(() => black.result && white.result);
  assert.deepEqual(black.result, { winner: "white", reason: "timeout" });
  assert.equal(match.blackTimeMs, 0);
  assert.equal(match.whiteTimeMs, 1000);
  assert.equal(service.result(sessions[1], match.id, users[1]).won, true);
  assert.equal(completed.length, 1);
  assert.deepEqual(completed[0].players, [{ user_id: 701, side: "black" }, { user_id: 702, side: "white" }]);
  service.tickMatchTimers();
  assert.equal(completed.length, 1, "terminal ownership callback is once-only");
});

test("expired joins cancel both entries and expired disconnects retain the remaining player's owned result", async (t) => {
  const { service, advance } = await setup(t, { joinTimeoutMs: 100 });
  service.enter(sessions[0], users[0], decks[0]);
  const found = service.enter(sessions[1], users[1], decks[1]);
  const ticket = service.issueTicket(sessions[0], users[0]);
  advance(101);
  service.tickMatchTimers();
  assert.equal(service.poll(sessions[0], users[0]).status, 99);
  assert.equal(service.poll(sessions[1], users[1]).status, 99);
  assert.equal(service.tickets.has(ticket), false);
  assert.throws(() => service.result(sessions[0], found.room_id, users[0]), /unavailable/);
  const live = await pair(t, { reconnectGraceMs: 100 });
  live.clients[1].socket.destroy();
  await until(() => live.match.peers[1].disconnectedAt != null);
  live.advance(101);
  live.service.tickMatchTimers();
  await until(() => live.clients[0].result);
  assert.deepEqual(live.clients[0].result, { winner: "black", reason: "disconnect" });
  assert.equal(live.service.result(sessions[0], live.match.id, users[0]).won, true);
  assert.equal(live.service.result(sessions[1], live.match.id, users[1]).won, false);
});

test("explicit training uses the shared listener while ordinary human matchmaking continues waiting", async (t) => {
  const training = new CustomMatchService({ bindHost: "127.0.0.1", publicHost: "127.0.0.1", port: 0 });
  const { service } = await setup(t, { trainingService: training });
  training.port = service.port;
  service.enter(sessions[0], users[0], decks[0]);
  training.enter("training-only", users[2], decks[0]);
  const found = training.poll("training-only", users[2]);
  assert.equal(found.online_match.player2.user.name, "Training Opponent");
  const client = await WireClient.open(service, users[2], training.issueTicket("training-only"));
  client.play();
  await until(() => client.record);
  assert.equal(service.poll(sessions[0], users[0]).status, 1);
  assert.equal(client.record.players[0].id, "703");
  assert.equal(client.record.server_ai_name, "kiwi-duel-opponent");
  client.command("lose", "resign");
  await until(() => client.result);
  assert.equal(training.result("training-only", found.room_id).after_point, 0);
});

test("completion publishes only after durable ownership commits and retries without changing the outcome", async (t) => {
  let attempts = 0;
  const commits = [];
  const { service, clients: [black, white], match, advance } = await pair(t, {
    onMatchFinished: (completion) => {
      attempts += 1;
      if (attempts === 1) throw new Error("simulated database contention");
      commits.push(completion);
    },
  });
  black.command("lose", "resign");
  await until(() => match.phase === "finishing");
  assert.equal(black.result, undefined);
  assert.equal(white.result, undefined);
  assert.throws(() => service.result(sessions[0], match.id, users[0]), /unavailable/);
  assert.equal(match.activeClockSide, "");
  advance(1001);
  service.tickMatchTimers();
  await until(() => black.result && white.result);
  assert.equal(attempts, 2);
  assert.equal(commits.length, 1);
  assert.deepEqual(white.result, { winner: "white", reason: "resign" });
  assert.equal(service.result(sessions[1], match.id, users[1]).won, true);
  service.tickMatchTimers();
  assert.equal(attempts, 2);
});

test("recovered intro and turn cut-ins have bounded clock grace that readiness cannot extend", async (t) => {
  const { service, clients: [black, white], match, advance } = await pair(t, {
    firstPresentationMs: humanMatchTimingContract.firstPresentationMilliseconds,
    turnPresentationMs: humanMatchTimingContract.turnCutInMilliseconds,
    presentationSlackMs: humanMatchTimingContract.readinessAllowanceMilliseconds,
  });
  assert.equal(service.clockPolicy(match).first_presentation_ms, 17500);
  const initialDeadline = match.presentationClock.deadline;
  assert.equal(black.snapshot.ClockPolicy.pending_side, "black");
  assert.equal(black.snapshot.ClockPolicy.start_no_later_than_ms, initialDeadline);
  assert.deepEqual(black.snapshot.ClockPolicy, white.snapshot.ClockPolicy);
  advance(17500);
  service.tickMatchTimers();
  assert.equal(match.blackTimeMs, 300000, "Versus + stage intro + first cut-in consume no play time");
  white.socket.write("timer_start white\n");
  await until(() => white.times.white === 300000);
  assert.equal(match.presentationClock.deadline, initialDeadline, "wrong-side readiness cannot alter the deadline");
  black.socket.write("timer_start black\n");
  await until(() => match.activeClockSide === "black");
  advance(1234);
  black.socket.write("timer_start black\n");
  await until(() => black.times.black === 298766);
  assert.equal(match.presentationClock, null, "repeat readiness cannot grant a new grace window");
  black.move("black", { type: "mp_move", route: [28, 27] });
  await until(() => match.turn === "white" && match.presentationClock?.side === "white");
  const turnDeadline = match.presentationClock.deadline;
  advance(1500);
  service.tickMatchTimers();
  assert.equal(match.whiteTimeMs, 300000, "next turn cut-in consumes no play time");
  assert.equal(match.presentationClock.deadline, turnDeadline);
  advance(5000 + 750);
  service.tickMatchTimers();
  assert.equal(match.whiteTimeMs, 299250, "missing readiness starts the clock at its fixed bounded deadline");
  assert.equal(match.activeClockSide, "white");
});

test("invalid owned timing policy cannot create an unbounded readiness or reconnect pause", () => {
  for (const options of [
    { presentationSlackMs: Number.NaN }, { firstPresentationMs: Infinity },
    { turnPresentationMs: -1 }, { reconnectGraceMs: 0 }, { queueLeaseMs: "not-a-number" },
    { battlePresentationMs: Infinity }, { battleWheelPresentationMs: Number.NaN },
  ]) {
    assert.throws(() => new HumanMatchService({ port: 0, plateMasters, ...options }), /invalid_.*_ms/);
  }
});

test("white Double Chance waits for the real player and retains the full battle presentation deadline when declined", async (t) => {
  const { service, clients: [black, white], match, advance } = await pair(t, {
    spinUnitSource: () => 0,
    battlePresentationMs: humanMatchTimingContract.battlePresentationMilliseconds,
    battleWheelPresentationMs: humanMatchTimingContract.battleWheelPresentationMilliseconds,
    presentationSlackMs: 5000,
  });
  const moves = [
    [black, "black", { type: "declare_plate", plate_id: 5026, value: { type: "spot_move", from: 28, to: 16 } }],
    [white, "white", { type: "declare_plate", plate_id: 5026, value: { type: "spot_move", from: 34, to: 1 } }],
    [black, "black", { type: "mp_move", route: [16, 12, 7] }],
    [white, "white", { type: "declare_plate", plate_id: 5015, value: { type: "select_pokemon", pokemon: 6 } }],
    [white, "white", { type: "mp_move", route: [1, 0] }],
    [white, "white", { type: "declare_battle", from_pokemon: 6, to_pokemon: 0 }],
  ];
  for (const [client, side, move] of moves) {
    const previous = match.record.all_moves.length;
    client.move(side, move);
    await until(() => match.record.all_moves.length > previous && black.record.all_moves.length === match.record.all_moves.length
      && white.record.all_moves.length === match.record.all_moves.length);
  }
  await until(() => match.pendingRespin && !match.resolving);
  await until(() => [black, white].every((client) => client.plateState.record_move_count === match.record.all_moves.length));
  for (const client of [black, white]) {
    assert.equal(client.plateState.plate_conditions[1].plates.find(({ id }) => id === 5015).condition, "active");
    assert.equal(client.plateState.pending_selection.respin, true);
    assert.ok(client.plateState.attachments.some(({ side, plate_id, pokemon }) => side === "white" && plate_id === 5015 && pokemon === 6));
  }
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(match.turn, "white");
  assert.equal(match.pendingRespin.declared, false, "the inherited training bot cannot choose for human white");
  assert.equal(match.presentationClock.reason, "respin_choice");
  advance(humanMatchTimingContract.battleWheelPresentationMilliseconds);
  service.tickMatchTimers();
  assert.equal(match.whiteTimeMs, 300000, "wheel presentation does not consume human decision time");
  white.move("white", { type: "null_move" });
  await until(() => match.turn === "black" && black.record.all_moves.length === match.record.all_moves.length
    && white.record.all_moves.length === match.record.all_moves.length);
  assert.equal(match.presentationClock.reason, "battle_result", "synchronous decline must not collapse to cut-in grace");
  assert.equal(match.presentationClock.deadline - Number(service.clockSource()),
    humanMatchTimingContract.battlePresentationMilliseconds + 5000);
  assert.deepEqual(black.record, match.record);
  assert.deepEqual(white.record, match.record);
  await until(() => [black, white].every((client) => client.plateState.record_move_count === match.record.all_moves.length));
  for (const client of [black, white]) {
    assert.equal(client.plateState.plate_conditions[1].plates.find(({ id }) => id === 5015).condition, "used");
    assert.deepEqual(client.plateState.pending_selection, {});
    assert.equal(client.plateState.attachments.some(({ plate_id }) => plate_id === 5015), false);
  }
  advance(humanMatchTimingContract.battlePresentationMilliseconds);
  service.tickMatchTimers();
  assert.equal(match.blackTimeMs, 300000);
  black.socket.write("timer_start black\n");
  await until(() => match.activeClockSide === "black");
  advance(400);
  service.tickMatchTimers();
  assert.equal(match.blackTimeMs, 299600);
});

test("battle deadline animation maxima cover the serialized attack/damage and prelude clips", () => {
  const clips = JSON.parse(readFileSync(new URL("../data/match_runtime_contract.json", import.meta.url))).battle_animation.clips;
  const authoredMax = Math.max(...Object.entries(clips)
    .filter(([name]) => /^(attack_|damage_|guard$|dodge$)/.test(name))
    .map(([, clip]) => Number(clip.stop_time)));
  assert.ok(authoredMax <= 3.8);
  for (const name of ["zskill_fx_on", "zskill_fx_wait", "gold_fx_on", "gold_fx_wait"]) {
    assert.ok(Number(clips[name].stop_time) <= 3);
  }
  assert.equal(humanMatchTimingContract.battleWheelPresentationMilliseconds, 4900);
  assert.equal(humanMatchTimingContract.battlePresentationMilliseconds, 17100);
});

test("revoked sessions lose pending tickets and cannot submit another TCP action before a timer sweep", async (t) => {
  const authorized = new Map(sessions.map((session, index) => [session, users[index]]));
  const { service, clients: [black], match } = await pair(t, { authenticateSession: (session) => authorized.get(session) });
  const whiteTicket = service.issueTicket(sessions[1], users[1]);
  authorized.delete(sessions[0]);
  black.command("do_move", JSON.stringify({ selective_side: "black", value: { type: "mp_move", route: [28, 27] } }));
  await until(() => black.socket.destroyed || match.record.all_moves.length > 0);
  assert.equal(match.record.all_moves.length, 0, "revocation is checked on the command, not only a periodic WS heartbeat");
  assert.throws(() => service.issueTicket(sessions[0], users[0]), /authentication_required/);
  authorized.delete(sessions[1]);
  const stale = await WireClient.open(service, users[1], whiteTicket);
  assert.ok(stale.lines.includes("@login rejected"), "ticket minted before revocation cannot log into raw TCP afterward");
});

test("rejected command cannot regain readiness using subsequent lines in the same TCP chunk", async (t) => {
  const { clients: [black], match } = await pair(t);
  const illegal = { selective_side: "black", value: { type: "mp_move", route: [28, 29] } };
  const legal = { selective_side: "black", value: { type: "mp_move", route: [28, 27] } };
  black.socket.write(`sequence 1 -1 do_move ${JSON.stringify(illegal)}\nplaygame custom.2 evidence-base.1\nsequence 2 -1 do_move ${JSON.stringify(legal)}\n`);
  await until(() => black.socket.destroyed);
  assert.equal(match.record.all_moves.length, 0);
  assert.equal(match.positions.get(0), 28);
});

test("sequenced control messages consume their index exactly once before the next player action", async (t) => {
  for (const command of ["ping", "time", "timer_start"]) {
    const { clients: [black, white], match } = await pair(t);
    black.command(command, command === "timer_start" ? "black" : "");
    black.move("black", { type: "mp_move", route: [28, 27] });
    await until(() => black.lines.some((line) => line.startsWith("move_rejected ")) || white.record.all_moves.length === 2);
    assert.equal(match.record.all_moves.length, 2, `${command} must not create a gap in the next valid client sequence`);
    assert.deepEqual(black.record, white.record);
    assert.equal(match.peers[0].clientSendIndex, 2);
  }
});

test("a pre-issued reconnect ticket cannot bypass an already-expired disconnect deadline", async (t) => {
  const { service, clients: [, white], match, advance } = await pair(t, { reconnectGraceMs: 100 });
  const ticket = service.issueTicket(sessions[1], users[1]);
  await new Promise((resolve) => { white.socket.once("close", resolve); white.socket.destroy(); });
  await until(() => match.peers[1].disconnectedAt != null);
  advance(101);
  const reconnect = await WireClient.open(service, users[1], ticket);
  assert.equal(match.phase, "finished", "incoming login enforces deadlines without waiting for the next timer tick");
  assert.equal(match.winner, "black");
  assert.equal(match.reason, "disconnect");
  // Finished participants may view their result over a remaining ticket, but
  // can never resurrect the started match or erase its fixed winner.
  if (reconnect.lines.includes("@login ok")) {
    reconnect.play();
    await until(() => reconnect.result);
    assert.equal(reconnect.result.winner, "black");
  }
});

test("reconnect handshake does not reset grace until the authoritative PlayGame is requested", async (t) => {
  const { service, clients: [, white], match, advance } = await pair(t, { reconnectGraceMs: 100 });
  white.socket.destroy();
  await until(() => match.peers[1].disconnectedAt != null);
  const disconnectedAt = match.peers[1].disconnectedAt;
  advance(40);
  const reconnect = await WireClient.open(service, users[1], service.issueTicket(sessions[1], users[1]));
  assert.ok(reconnect.lines.includes("@login ok"));
  assert.equal(match.peers[1].disconnectedAt, disconnectedAt, "login alone cannot erase the original readiness deadline");
  advance(61);
  service.tickMatchTimers();
  assert.equal(match.phase, "finished");
  assert.equal(match.winner, "black");
});

test("training shares the same immediate revoked-session guard for tickets and established sockets", async (t) => {
  const authorized = new Map([[sessions[0], users[0]]]);
  const authenticateSession = (session) => authorized.get(session);
  const training = new CustomMatchService({
    bindHost: "127.0.0.1", publicHost: "127.0.0.1", port: 0, plateMasters, authenticateSession,
  });
  const { service } = await setup(t, { trainingService: training, authenticateSession });
  training.enter(sessions[0], users[0], decks[0]);
  training.poll(sessions[0], users[0]);
  const client = await WireClient.open(service, users[0], training.issueTicket(sessions[0]));
  client.play();
  await until(() => client.record);
  const pendingTicket = training.issueTicket(sessions[0]);
  const match = training.matches.get(sessions[0]);
  authorized.delete(sessions[0]);
  client.command("do_move", JSON.stringify({ selective_side: "black", value: { type: "mp_move", route: [28, 27] } }));
  await until(() => client.socket.destroyed || match.record.all_moves.length > 0);
  assert.equal(match.record.all_moves.length, 0);
  assert.throws(() => training.issueTicket(sessions[0]), /authentication_required/);
  const stale = await WireClient.open(service, users[0], pendingTicket);
  assert.ok(stale.lines.includes("@login rejected"));
});

test("sequence acknowledgements cannot claim unsent, negative or unsafe server indexes", async (t) => {
  for (const acknowledgement of ["-2", "999999999999999999999", "1000000"]) {
    const { clients: [black], match } = await pair(t);
    black.socket.write(`sequence 1 ${acknowledgement} do_move {"selective_side":"black","value":{"type":"mp_move","route":[28,27]}}\n`);
    await until(() => black.lines.some((line) => line.includes("invalid_sequence_ack")));
    assert.equal(match.record.all_moves.length, 0);
    assert.equal(match.peers[0].clientSendIndex, -1);
  }
});

test("outbound delivery and idle sweeps close revoked peers without leaking additional record commands", async (t) => {
  const authorized = new Map(sessions.map((session, index) => [session, users[index]]));
  const { service, clients: [black, white], match } = await pair(t, { authenticateSession: (session) => authorized.get(session) });
  authorized.delete(sessions[1]);
  black.move("black", { type: "mp_move", route: [28, 27] });
  await until(() => white.socket.destroyed && match.record.all_moves.length === 2);
  assert.equal(white.record.all_moves.length, 0, "revoked observer receives neither opponent move nor system Z update");
  authorized.delete(sessions[0]);
  service.tickMatchTimers();
  await until(() => black.socket.destroyed);
  assert.ok(match.peers.every((peer) => peer.disconnectedAt != null));
});
for (const healedSide of ['black','white']) for (const continuation of ['end','move','wrong-figure','occupied']) {
  test(`Full Heal human continuation: ${healedSide} ${continuation}`, async t => {
    const {service,completed}=await setup(t,{spinUnitSource:()=>0});
    service.enter(sessions[0],users[0],decks[0]);
    const found=service.enter(sessions[1],users[1],decks[1]);
    const match=service.matches.get(found.room_id);
    const healed=healedSide==='black'?0:6,enemy=healed===0?6:0,sideIndex=healed===0?0:1;
    const native=nativeRepeatCases.find(row=>row.name.endsWith('purple-primary-1018')).record;
    for(const player of match.record.players){
      player.plates=[5002];
      player.pokemons=structuredClone(native.players.find(row=>row.color===player.color).pokemons);
      for(const figure of player.pokemons){figure.id=1002;figure.pokepower=-1;figure.skills=[{id:figure.pokemon_index===enemy?1073:1199,color:figure.pokemon_index===enemy?2:1,range:96,speed_or_damage:figure.pokemon_index===enemy?2:50}];}
    }
    match.plateState=null;match.zState=null;
    const clients=[];
    for(let i=0;i<2;i++){clients[i]=await WireClient.open(service,users[i],service.issueTicket(sessions[i],users[i]));clients[i].play();}
    const synced=()=>clients.every(client=>client.record?.all_moves.length===match.record.all_moves.length&&client.plateState?.record_move_count===match.record.all_moves.length&&client.zState?.record_move_count===match.record.all_moves.length);
    await until(synced);
    async function send(side,value){const count=match.record.all_moves.length;clients[side==='black'?0:1].move(side,value);await until(()=>match.record.all_moves.length>count);await until(synced);}
    for(const action of native.all_moves.filter(move=>move.value.type==='mp_move'))await send(action.selective_side,action.value);
    if(healedSide==='white')await send('white',{type:'null_move'});
    await send(healedSide==='black'?'white':'black',{type:'declare_battle',from_pokemon:enemy,to_pokemon:healed});
    await until(()=>match.conditions.get(healed)==='poison'&&match.turn===healedSide&&!match.resolving);await until(synced);
    await send(healedSide,{type:'declare_plate',plate_id:5002,value:{type:'put_circle',pokemons:[healed],condition:'normal'}});
    assert.equal(match.conditions.get(healed),'normal');assert.equal(match.turn,healedSide);
    assert.equal(match.pendingPlate.pokemon,healed);assert.deepEqual(match.pendingBattles,[],'healing is not movement');
    assert.equal(match.plateState.plate_conditions.find(row=>row.color===healedSide).plates[0].condition,'used');
    if(['wrong-figure','occupied'].includes(continuation)){
      const before=structuredClone(match.record),positions=[...match.positions];
      const route=continuation==='occupied'?(healed===0?[15,11]:[11,15]):(healed===0?[29,27]:[35,6]);
      clients[sideIndex].command('do_move',JSON.stringify({selective_side:healedSide,value:{type:'mp_move',route}}));
      await until(()=>clients[sideIndex].lines.some(line=>line.startsWith('move_rejected ')));
      const rejection=clients[sideIndex].lines.find(line=>line.startsWith('move_rejected '));
      assert.equal(JSON.parse(rejection.slice(14)).error,'illegal_player_movement');
      assert.deepEqual(match.record,before);assert.deepEqual([...match.positions],positions);
      await until(()=>!match.peers[sideIndex].socket);
      clients[sideIndex]=await WireClient.open(service,users[sideIndex],service.issueTicket(sessions[sideIndex],users[sideIndex]));clients[sideIndex].play();await until(synced);
      assert.deepEqual(clients[sideIndex].record,before);
    }
    if(continuation==='move'){
      const route=healed===0?[15,20]:[11,6];await send(healedSide,{type:'mp_move',route});
      assert.equal(match.positions.get(healed),route[1]);
      if(match.pendingBattles.length)await send(healedSide,{type:'null_move'});
    }else await send(healedSide,{type:'declare_turn_end'});
    const opposite=healedSide==='black'?'white':'black';assert.equal(match.turn,opposite);assert.equal(match.pendingPlate,null);
    assert.equal(new Set(match.positions.values()).size,12);assert.deepEqual(clients.map(client=>client.record),[match.record,match.record]);
    await send(opposite,{type:'resign'});await until(()=>completed.length===1);
    assert.equal(completed[0].winner,healedSide);
  });
}
