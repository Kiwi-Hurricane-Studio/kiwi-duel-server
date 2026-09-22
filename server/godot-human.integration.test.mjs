import {floatingCandleNetworkCases} from "../tests/floating-candle-network-cases.mjs";
import {typedArrowNetworkCases} from "../tests/typed-arrow-network-cases.mjs";
import {waterProviderNetworkCases} from "../tests/water-provider-network-cases.mjs";
import {waitConditionalNetworkCases} from "../tests/wait-conditional-network-cases.mjs";
import {postMpBattleNetworkCases} from '../tests/post-mp-battle-network-cases.mjs';
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { packagedMasterBinding } from "./bootstrap-readiness.mjs";
import { purpleStarNetworkCases } from "../tests/purple-star-network-cases.mjs";
import { effectKnockoutNetworkCases } from "../tests/effect-knockout-network-cases.mjs";
import { conditionalKnockoutNetworkCases } from "../tests/conditional-knockout-network-cases.mjs";
import { purpleWaitNetworkCases } from "../tests/purple-wait-network-cases.mjs";
import { purpleConditionNetworkCases } from "../tests/purple-condition-network-cases.mjs";
import { surroundingNetworkCases } from "../tests/surrounding-network-cases.mjs";
import { surroundingPlateNetworkCases } from "../tests/surrounding-plate-network-cases.mjs";
import { purpleFlyNetworkCases } from "../tests/purple-fly-network-cases.mjs";
import { doubleFlightNetworkCases } from "../tests/double-flight-network-cases.mjs";
import { doubleFlightConditionNetworkCases } from "../tests/double-flight-condition-network-cases.mjs";
import { doubleFlightInteractionNetworkCases } from "../tests/double-flight-interaction-network-cases.mjs";
import { doubleFlightOwnerTurnNetworkCases } from "../tests/double-flight-owner-turn-network-cases.mjs";
import { fieldEntryRecoveryNetworkCases, duelEntryRecoveryNetworkCases } from "../tests/field-entry-recovery-network-cases.mjs";
import { battleDamageReductionNetworkCases } from "../tests/battle-damage-reduction-network-cases.mjs";
import { fieldDamageReductionNetworkCases } from "../tests/field-damage-reduction-network-cases.mjs";
import { movementTransitNetworkCases } from "../tests/movement-transit-network-cases.mjs";

const project = fileURLToPath(new URL("../", import.meta.url));
const godot = process.env.DUEL_TEST_GODOT || join(project, ".tools", "godot", "Godot_v4.7.2-stable_win64_console.exe");
const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;

async function freePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((resolveClose) => listener.close(resolveClose));
  return port;
}

function childProcess(executable, args, env) {
  const child = spawn(executable, args, { cwd: project, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const processState = { child, output: "", launchError: "" };
  child.on("error", (error) => { processState.launchError = error.code || "spawn_failed"; });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
    processState.output = (processState.output + chunk.toString()).slice(-1024 * 1024);
  });
  return processState;
}

async function stop(childState) {
  if (!childState || childState.child.exitCode != null || childState.child.signalCode != null || !childState.child.pid) return;
  const exited = once(childState.child, "exit");
  childState.child.kill("SIGTERM");
  let timer;
  await Promise.race([exited, new Promise((resolveTimeout) => { timer = setTimeout(resolveTimeout, 2000); })]);
  clearTimeout(timer);
  if (childState.child.exitCode == null && childState.child.signalCode == null) {
    childState.child.kill("SIGKILL");
    await exited;
  }
}

async function api(base, path, body = {}, token = "") {
  const response = await fetch(`${base}${path}`, {
    method: "POST", signal: AbortSignal.timeout(5000),
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  assert.equal(value.ok, true, `${path} failed: ${value.error ?? response.status}`);
  return value.data;
}

function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

const nativeCases = JSON.parse(readFileSync(new URL('../docs/generated/mechanics-20260913/native-multispin.json',import.meta.url))).cases;
const nativeCenterEntry={black:41,white:43};
for(const [side,pokemon,name]of [['black',0,'native-multispin-4svbGK-white'],['white',6,'native-multispin-4svbGK-white-mirrored']]) {
  const witness=nativeCases.find(row=>row.name===name);assert(witness);
  assert(witness.status.pokemon_conditions.some(row=>Number(row.pokemon??row.pokemon_index)===pokemon&&row.index===nativeCenterEntry[side]));
}
// These are original-description tests, not newly observed native captures.
const blackoutCases = [0,6].flatMap(owner => ['survive','damage_ko','secondary_ko'].map(ending => {
  const source=nativeCases.find(row=>row.name.endsWith('purple-primary-1009'));
  const record=structuredClone(source.record);record.all_moves=[];
  for(const figure of record.players.flatMap(player=>player.pokemons)) {
    figure.pokepower=figure.pokemon_index===owner?1326:-1;
    if([0,6].includes(figure.pokemon_index)) {
      figure.skills=[{id:1122,color:4,range:ending==='survive'?96:4,speed_or_damage:0}];
      if(ending!=='survive') figure.skills.push(figure.pokemon_index===owner?{id:1131,color:0,range:92,speed_or_damage:0}
        :{id:ending==='secondary_ko'?1001:1199,color:1,range:92,speed_or_damage:50});
    }
  }
  return {name:`blackout-description-owner-${owner}-${ending}`,evidence_kind:'original_description',owner,ending,record,
    evidence:'PokepowerDescription1326: first battle after field entry; native first-battle matrix: paralysis and Wait3',
    spin_units:{0:[0,60,...(ending==='secondary_ko'&&owner===0?[0]:[])],6:[0,60,...(ending==='secondary_ko'&&owner===6?[0]:[])]},final_turn:'white',
    actions:[...source.record.all_moves.filter(move=>move.value.type!=='spin'),
      {selective_side:'black',value:{type:'mp_move',route:[29,27]}},
      {selective_side:'white',value:{type:'mp_move',route:[35,ending==='secondary_ko'?0:6]}},
      {selective_side:'black',value:{type:'declare_battle',from_pokemon:0,to_pokemon:6}}]};
}));
const damageAuraCases=[0,6].flatMap(owner=>[
  ...[{ability:1218,id:1131,bonus:10},{ability:1307,id:1405,bonus:20},{ability:1352,id:1419,bonus:20},{ability:1411,id:1410,bonus:20},
    {ability:1243,id:1281,bonus:20},{ability:1371,id:1423,bonus:20},{ability:1409,id:1412,bonus:20},{ability:1420,id:1535,bonus:20},{ability:1422,id:1536,bonus:20},{ability:1466,id:1542,bonus:20}].flatMap(rule=>['base','respin'].map(mode=>({...rule,mode}))),
  ...[{ability:1218,id:1131,bonus:10},{ability:1411,id:1410,bonus:20}].map(rule=>({...rule,mode:'self_condition'})),
].map(({ability,id,bonus,mode})=>{
  const source=nativeCases.find(row=>row.name.endsWith('purple-primary-1018')),record=structuredClone(source.record);record.all_moves=[];
  const enemy=owner===0?6:0,side=owner===0?'black':'white',opposite=owner===0?'white':'black',self=mode==='self_condition',holder=self?owner:owner+1;
  for(const player of record.players){player.plates=player.color===side&&mode==='respin'?[5015]:[];for(const figure of player.pokemons){
    const p=figure.pokemon_index;figure.pokepower=p===holder?ability:-1;figure.id=[owner,holder].includes(p)?id:1002;
    figure.skills=[{id:1199,color:1,range:96,speed_or_damage:50+bonus-1}];
    if(p===owner)figure.skills=[{id:1199,color:1,range:mode==='respin'?48:96,speed_or_damage:50},...(mode==='respin'?[{id:1131,color:0,range:48,speed_or_damage:0}]:[])];
    if(self&&p===enemy)figure.skills=[{id:1009,color:2,range:48,speed_or_damage:1},{id:1199,color:1,range:48,speed_or_damage:55}];
  }}
  const actions=structuredClone(source.record.all_moves.filter(move=>!['spin','declare_battle'].includes(move.value.type)));
  actions.push({selective_side:'white',value:{type:'null_move'}});
  if(!self){actions.push({selective_side:'black',value:{type:'mp_move',route:[29,27,20]}},{selective_side:'white',value:{type:'mp_move',route:[35,6]}});if(owner===6)actions.push({selective_side:'black',value:{type:'mp_move',route:[30,21]}});}
  else if(owner===6)actions.push({selective_side:'black',value:{type:'mp_move',route:[29,27]}});
  if(mode==='respin')actions.push({selective_side:side,value:{type:'declare_plate',plate_id:5015,value:{type:'select_pokemon',pokemon:owner}}});
  const battle={selective_side:side,value:{type:'declare_battle',from_pokemon:owner,to_pokemon:enemy}};actions.push(battle);
  if(mode==='respin')actions.push({selective_side:side,value:{type:'declare_respin',pokemons:[owner]}});
  if(self)actions.push({selective_side:opposite,value:{type:'mp_move',route:owner===0?[35,6]:[27,20]}},structuredClone(battle));
  const result=(num=0,displace=0)=>({num,displace,type:'battle'}),expectedSpins=[[{pokemon:owner,results:[result()]},{pokemon:enemy,results:[result()]}]];
  if(mode==='respin')expectedSpins.push([{pokemon:owner,results:[result(48)]}]);
  if(self)expectedSpins.push([{pokemon:owner,results:[result(0,1)]},{pokemon:enemy,results:[result(48)]}]);
  const ownerLoses=mode==='respin'||self&&ability===1218;
  return {name:`damage-aura-owner-${owner}-${ability}-${mode}`,rule:'damage_aura',evidence_kind:'original_description',owner,holder,ability,bonus,mode,record,actions,final_turn:opposite,
    expected_damage:[50+bonus,...(mode==='respin'?[0]:self?[ability===1218?50:70]:[])],
    expected_sources:[holder,...(mode==='respin'?[-1]:self?[ability===1218?-1:holder]:[])],
    expected_notices:[holder,...(mode==='respin'?[-1]:self?[ability===1218?-1:holder]:[])].map(source=>source<0?[]:[{pokemon:owner,source,type:'pokepower_damage_notice',value:{current:50,addend:bonus,result:50+bonus,type:'damage_sum_notice'}}]),
    expected_spins:expectedSpins,spin_units:{[owner]:mode==='respin'?[0,48]:self?[0,0]:[0],[enemy]:self?[0,48]:[0]},
    expected_positions:{[owner]:ownerLoses?nativeCenterEntry[side]:(owner===0?15:11),[enemy]:ownerLoses?(enemy===0?15:11):nativeCenterEntry[opposite]},
    evidence:'Original single-type damage clauses and static PokepowerDamageNotice source-index/Sum wrapper. Flat stacking and compound timing remain derived.'};
}));
const battleColorCases=[0,6].flatMap(owner=>[
  {ability:1227,id:1272,up:true,first:true},{ability:1308,id:1404,up:true,first:true},
  {ability:1409,id:1412,up:false,first:false},{ability:1397,id:1498,up:false,first:true},
  {ability:1398,id:1503,up:false,first:true},{ability:1399,id:1504,up:false,first:true},{ability:1423,id:1525,up:false,first:true},
].flatMap(rule=>['base','respin','lifetime'].map(mode=>{
  const source=nativeCases.find(row=>row.name.endsWith('purple-primary-1018')),record=structuredClone(source.record);record.all_moves=[];
  const {ability,id,up,first}=rule,enemy=owner===0?6:0,side=owner===0?'black':'white',opposite=owner===0?'white':'black';
  const attack=(id,color,power,width=96)=>({id,color,speed_or_damage:power,range:width});
  for(const player of record.players){player.plates=player.color===side&&mode==='respin'?[5015]:[];for(const figure of player.pokemons){
    const p=figure.pokemon_index;figure.pokepower=p===owner?ability:-1;figure.id=p===owner?id:1001;
    figure.skills=[attack(1009,2,1)];
    if(p===owner)figure.skills=[attack(up?1199:1009,up?1:2,up?50:1,mode==='respin'?48:96),...(mode==='respin'?[attack(1131,0,0,48)]:[])];
    if(p===enemy&&!up)figure.skills=[attack(1199,3,50)];
  }}
  const actions=structuredClone(source.record.all_moves.filter(move=>!['spin','declare_battle'].includes(move.value.type)));
  actions.push({selective_side:'white',value:{type:'null_move'}},{selective_side:'black',value:{type:'mp_move',route:[29,27,20]}},{selective_side:'white',value:{type:'mp_move',route:[35,6]}});
  if(owner===6)actions.push({selective_side:'black',value:{type:'mp_move',route:[30,21]}});
  if(mode==='respin')actions.push({selective_side:side,value:{type:'declare_plate',plate_id:5015,value:{type:'select_pokemon',pokemon:owner}}});
  const battle={selective_side:side,value:{type:'declare_battle',from_pokemon:owner,to_pokemon:enemy}};actions.push(battle);
  if(mode==='respin')actions.push({selective_side:side,value:{type:'declare_respin',pokemons:[owner]}});
  if(mode==='lifetime'){
    actions.push({selective_side:opposite,value:{type:'mp_move',route:up?(owner===0?[6,11]:[20,15]):(owner===0?[6,5]:[20,27])}});
    if(up)actions.push({selective_side:opposite,value:{type:'null_move'}});
    actions.push({selective_side:side,value:{type:'declare_battle',from_pokemon:owner,to_pokemon:up?enemy+1:enemy}});
  }
  const spin=(p,num=0,displace=0)=>({pokemon:p,results:[{num,displace,type:'battle'}]}),expectedSpins=[[spin(owner),spin(enemy)]];
  if(mode==='respin')expectedSpins.push([spin(owner,48)]);
  if(mode==='lifetime')expectedSpins.push([spin(owner),spin(up?enemy+1:enemy,0,up?0:1)]);
  const notice=[{pokemon:owner,pokepower:ability,type:'pokepower_notice'},{pokemon:up?owner:enemy,skill_id:[1199],type:up?'speedup_skill':'speeddown_skill'}];
  const positions={[owner]:owner===0?15:11,[enemy]:enemy===0?15:11};
  if(up&&mode!=='respin')positions[enemy]=nativeCenterEntry[opposite];
  if(!up&&(mode==='respin'||mode==='lifetime'&&first))positions[owner]=nativeCenterEntry[side];
  if(up&&mode==='lifetime')positions[enemy+1]=enemy===0?15:11;
  const conditions=up?(mode==='base'?{[owner]:'normal'}:{[owner]:'panic',[mode==='lifetime'?enemy+1:enemy]:'normal'}):{[enemy]:mode==='respin'?'normal':'panic'};
  const count=mode==='base'?1:2;
  return {name:`battle-color-owner-${owner}-${ability}-${mode}`,rule:'damage_aura',evidence_kind:'original_description',owner,holder:owner,ability,mode,record,actions,final_turn:opposite,
    expected_damage:[up?50:1,...(mode==='base'?[]:[mode==='respin'?0:up?50:1])],expected_notices:Array.from({length:count},()=>[]),
    expected_colors:[[up?3:2,up?2:1],...(mode==='base'?[]:[mode==='respin'?[0,up?2:1]:[up?1:2,up?2:first?3:1]])],
    expected_color_notices:[notice,...(mode==='base'?[]:[mode==='respin'||!first?notice:[]])],expected_conditions:conditions,
    expected_spins:expectedSpins,spin_units:{[owner]:mode==='respin'?[0,48]:mode==='lifetime'?[0,0]:[0],[enemy]:mode==='lifetime'&&!up?[0,0]:[0],...(mode==='lifetime'&&up?{[enemy+1]:[0]}:{})},
    expected_positions:positions,evidence:'Original first-battle and unconditional color clauses; original SpeedUpSkill typed up/down actions and Attack-ID iteration. Conflict/announcement ordering remains derived.'};
})));

const battleColorScopeCases=[0,6].flatMap(owner=>[1197,1392,1262].flatMap(ability=>
  (ability===1197?['near','enemy','wrong','far','bench','respin','departure']:
    ability===1392?['near','far','wrong','enemy_source','bench','respin','departure']:['near','far','opposing_turn','bench','both_gold','respin','departure']).map(mode=>{
  const sample=nativeCases.find(row=>row.name.endsWith('purple-primary-1018')),record=structuredClone(sample.record);record.all_moves=[];
  const enemy=owner===0?6:0,side=owner===0?'black':'white',opposite=owner===0?'white':'black',up=ability===1197;
  const source=up||mode==='departure'?owner:(['enemy_source','opposing_turn'].includes(mode)?enemy+1:owner+1);
  const attack=(id,color,power,width=96)=>({id,color,speed_or_damage:power,range:width});
  for(const player of record.players){player.plates=player.color===side&&mode==='respin'?[5015]:[];for(const figure of player.pokemons){
    const p=figure.pokemon_index;figure.id=1001;figure.pokepower=p===source?ability:-1;figure.skills=[attack(1009,2,1)];
    if(p===source)figure.id={1197:1318,1392:1544,1262:1342}[ability];
    if(up&&p===(['enemy','departure'].includes(mode)?enemy:owner+1)&&mode!=='wrong')figure.id=1318;
    if(ability===1392&&p===owner&&mode!=='wrong')figure.id=1544;
    if(p===owner)figure.skills=[attack(up?1199:mode==='both_gold'?1347:1009,up?1:mode==='both_gold'?3:2,up?50:mode==='both_gold'?99:1,mode==='respin'?48:96),...(mode==='respin'?[attack(1131,0,0,48)]:[])];
    if(p===enemy)figure.skills=[attack(up?1009:1199,up?2:3,up?1:50)];
    if(mode==='departure'&&!up){
      if(p===owner)figure.skills=[attack(1009,2,1,48),attack(1199,1,50,48)];
      if(p===enemy)figure.skills=[attack(1199,3,50,48),attack(1098,2,2,48)];
      if(p===owner+1&&ability===1392)figure.id=1544;
    }
  }}
  const actions=structuredClone(sample.record.all_moves.filter(move=>!['spin','declare_battle'].includes(move.value.type)));
  actions.push({selective_side:'white',value:{type:'null_move'}});
  if(mode==='bench'){
    if(owner===6)actions.push({selective_side:'black',value:{type:'mp_move',route:[29,27]}});
  }else{
    actions.push({selective_side:'black',value:{type:'mp_move',route:mode==='far'&&owner===0?[29,27]:[29,27,20]}},
      {selective_side:'white',value:{type:'mp_move',route:mode==='far'&&owner===6?[35,6,5]:[35,6]}});
    if(owner===6)actions.push({selective_side:'black',value:{type:'mp_move',route:[30,21]}});
  }
  if(mode==='respin')actions.push({selective_side:side,value:{type:'declare_plate',plate_id:5015,value:{type:'select_pokemon',pokemon:owner}}});
  actions.push({selective_side:side,value:{type:'declare_battle',from_pokemon:owner,to_pokemon:enemy}});
  if(mode==='respin')actions.push({selective_side:side,value:{type:'declare_respin',pokemons:[owner]}});
  if(mode==='departure'){
    if(up){actions.push({selective_side:opposite,value:{type:'mp_move',route:owner===0?[6,11]:[20,15]}},{selective_side:opposite,value:{type:'null_move'}},{selective_side:side,value:{type:'declare_battle',from_pokemon:owner,to_pokemon:enemy+1}});}
    else actions.push({selective_side:opposite,value:{type:'declare_battle',from_pokemon:enemy,to_pokemon:owner}},{selective_side:side,value:{type:'mp_move',route:owner===0?[20,15]:[6,11]}},{selective_side:side,value:{type:'declare_battle',from_pokemon:owner+1,to_pokemon:enemy}});
  }
  const active=!['wrong','bench','enemy_source','opposing_turn'].includes(mode)&&!(mode==='far'&&ability!==1392);
  const initialColors=[up?(active?3:1):mode==='both_gold'?1:2,up?2:active?1:3];
  const notice=active?[{pokemon:source,pokepower:ability,type:'pokepower_notice'},...(mode==='both_gold'?[{pokemon:owner,skill_id:[1347],type:'speeddown_skill'}]:[]),{pokemon:up?owner:enemy,skill_id:[1199],type:up?'speedup_skill':'speeddown_skill'}]:[];
  const spin=(pokemon,num=0,displace=0)=>({pokemon,results:[{num,displace,type:'battle'}]});
  const spins=[[spin(owner),spin(enemy)]],damage=[up?50:mode==='both_gold'?99:ability===1262&&mode==='departure'?2:1],colors=[initialColors],colorNotices=[notice],units={[owner]:[0],[enemy]:[0]};
  if(mode==='respin'){spins.push([spin(owner,48)]);damage.push(0);colors.push([0,up?2:1]);colorNotices.push(notice);units[owner].push(48);}
  const positions={[owner]:owner===0?15:11,[enemy]:enemy===0?15:11};let conditions={};
  if(up){
    if(active&&mode!=='respin')positions[enemy]=nativeCenterEntry[opposite];
    conditions={[owner]:active&&mode!=='respin'?'normal':'panic'};
  }else if(!active||mode==='respin'){
    positions[owner]=nativeCenterEntry[side];conditions={[enemy]:'normal'};
  }else if(mode==='both_gold')positions[enemy]=nativeCenterEntry[opposite];
  else conditions={[owner]:'normal',[enemy]:'panic'};
  if(mode==='departure'){
    if(up){spins.push([spin(owner),spin(enemy+1)]);damage.push(50);colors.push([1,2]);colorNotices.push([]);units[owner].push(0);units[enemy+1]=[0];positions[enemy+1]=enemy===0?15:11;conditions={[owner]:'panic',[enemy+1]:'normal'};}
    else{
      spins.push([spin(owner,48),spin(enemy,0,1)],[spin(owner+1),spin(enemy,48,1)]);damage.push(2,1);colors.push([2,1],[2,3]);colorNotices.push(ability===1392?notice:[],[]);
      units[owner].push(48);units[enemy].push(0,48);units[owner+1]=[0];positions[owner]=28+owner;positions[owner+1]=nativeCenterEntry[side];conditions={[owner]:'normal',[enemy]:'panic'};
    }
  }
  return {name:`battle-color-scope-${owner}-${ability}-${mode}`,rule:'damage_aura',evidence_kind:'original_description',owner,holder:source,ability,mode,record,actions,final_turn:opposite,
    expected_damage:damage,expected_notices:spins.map(()=>[]),expected_colors:colors,expected_color_notices:colorNotices,expected_conditions:conditions,expected_spins:spins,spin_units:units,expected_positions:positions,
    evidence:'Original adjacent-Durant, allied Dragon/Psychic and owner-turn/range2 color clauses. Source departure is exercised by knockout or supported Whirlwind benching; other ability clauses and native grouping/conflict order remain partial.'};
})));

const fieldCountDamageCases=[0,6].flatMap(owner=>[1,2,3,4,'departure'].map(mode=>{
  const source=nativeCases.find(row=>row.name.endsWith('purple-primary-1018')),record=structuredClone(source.record);record.all_moves=[];
  const enemy=owner===0?6:0,side=owner===0?'black':'white',opposite=owner===0?'white':'black',departure=mode==='departure',count=departure?3:mode;
  const members=departure?[owner,enemy,enemy+1]:[owner,enemy,owner+1,enemy+1].slice(0,count);
  for(const player of record.players){player.plates=[];for(const figure of player.pokemons){
    const p=figure.pokemon_index;figure.id=members.includes(p)?1281:1001;figure.pokepower=p===owner?1243:-1;
    figure.skills=[{id:1199,color:1,range:96,speed_or_damage:p===enemy?50+count*10+20-1:departure&&p===enemy+1?89:50}];
  }}
  const actions=structuredClone(source.record.all_moves.filter(move=>!['spin','declare_battle'].includes(move.value.type)));
  actions.push({selective_side:'white',value:{type:'null_move'}});
  if(count>=3){actions.push({selective_side:'black',value:{type:'mp_move',route:[29,27,20]}},{selective_side:'white',value:{type:'mp_move',route:[35,6]}});if(owner===6)actions.push({selective_side:'black',value:{type:'mp_move',route:[30,21]}});}
  else if(owner===6)actions.push({selective_side:'black',value:{type:'mp_move',route:[29,27]}});
  actions.push({selective_side:side,value:{type:'declare_battle',from_pokemon:owner,to_pokemon:enemy}});
  if(departure)actions.push({selective_side:opposite,value:{type:'mp_move',route:owner===0?[6,11]:[20,15]}},{selective_side:opposite,value:{type:'null_move'}},
    {selective_side:side,value:{type:'declare_battle',from_pokemon:owner,to_pokemon:enemy+1}});
  const counts=departure?[3,2]:[count],result={num:0,displace:0,type:'battle'};
  return {name:`field-count-owner-${owner}-${mode}`,rule:'damage_aura',evidence_kind:'original_description',owner,holder:owner,ability:1243,bonus:20,mode:'field_count',record,actions,final_turn:opposite,
    expected_damage:counts.map(n=>50+n*10+20),expected_notices:counts.map(n=>[
      {pokemon:owner,source:owner,type:'pokepower_damage_notice',value:{current:50,multiplicand:10,multiplier:n,result:50+n*10,type:'damage_product_sum_notice'}},
      {pokemon:owner,source:owner,type:'pokepower_damage_notice',value:{current:50+n*10,addend:20,result:70+n*10,type:'damage_sum_notice'}}]),
    expected_spins:counts.map((_,index)=>[{pokemon:owner,results:[result]},{pokemon:enemy+index,results:[result]}]),
    spin_units:{[owner]:counts.map(()=>0),[enemy]:[0],...(departure?{[enemy+1]:[0]}:{})},
    expected_positions:{[owner]:owner===0?15:11,[enemy]:nativeCenterEntry[opposite]-(departure?1:0),...(departure?{[enemy+1]:nativeCenterEntry[opposite]}:{})},
    evidence:'Original Intense Shell Cannon: +10 self damage per field Water figure across both teams; separately +20 allied Water damage. Existing native Center entry/shift contract; count recalculated at each battle.'};
}));
const plateProhibitionCases=[0,6].flatMap(owner=>[
  {power:1411,mode:'condition'},{power:1411,mode:'holder_bench'},{power:1038,mode:'holder_bench'},{power:1038,mode:'member_bench'},
].map(({power,mode})=>{
  const source=nativeCases.find(row=>row.name.endsWith('purple-primary-1018')),record=structuredClone(source.record);record.all_moves=[];
  const enemy=owner===0?6:0,side=owner===0?'black':'white',opposite=owner===0?'white':'black',holder=mode==='member_bench'?enemy+1:enemy;
  for(const player of record.players){player.plates=player.color===side?[5022,5022]:[];for(const figure of player.pokemons){
    const p=figure.pokemon_index;figure.pokepower=p===holder?power:-1;
    figure.id=power===1411&&p===holder?1410:power===1038&&[enemy,owner+1,enemy+1].includes(p)?1242:1002;
    figure.skills=[p===owner?{id:mode==='condition'?1009:1027,color:2,range:96,speed_or_damage:1}:{id:1199,color:1,range:96,speed_or_damage:100}];
  }}
  const actions=structuredClone(source.record.all_moves.filter(move=>!['spin','declare_battle'].includes(move.value.type)));
  actions.push({selective_side:'white',value:{type:'null_move'}});
  if(power===1038) {
    actions.push({selective_side:'black',value:{type:'mp_move',route:[29,27,20]}},{selective_side:'white',value:{type:'mp_move',route:[35,6]}});
    if(owner===6)actions.push({selective_side:'black',value:{type:'mp_move',route:[30,21]}});
  }else if(owner===6)actions.push({selective_side:'black',value:{type:'mp_move',route:[29,27]}});
  const rejected={selective_side:side,value:{type:'declare_plate',plate_id:5022,value:{type:'select_pokemon',pokemon:owner+2}}},rejectAfter=actions.length;
  actions.push({selective_side:side,value:{type:'declare_battle',from_pokemon:owner,to_pokemon:enemy}},
    {selective_side:opposite,value:{type:'mp_move',route:owner===0?(power===1038?[37,0]:[35,6]):power===1038?[21,22]:[27,20]}},
    structuredClone(rejected),{selective_side:side,value:{type:'declare_turn_end'}});
  return {name:`plate-prohibition-owner-${owner}-${power}-${mode}`,rule:'plate_prohibition',evidence_kind:'original_description',owner,power,mode,holder,record,actions,rejected,reject_after:rejectAfter,
    final_turn:opposite,spin_units:{[owner]:[0],[enemy]:[0]},expected_spins:[[{pokemon:owner,results:[{num:0,displace:0,type:'battle'}]},{pokemon:enemy,results:[{num:0,displace:0,type:'battle'}]}]],
    evidence:'Intimidating Aura stops with a special condition or field departure. Big Chorus stops when either its holder leaves or fewer than three Politoed remain.'};
}));
const plateRestrictionCases=[0,6].flatMap(owner=>[
  ...[5015,5022,5426,5023,5306].map(id=>({id,power:1425})),...[5023,5306].map(id=>({id,power:1372})),
].map(({id,power})=>{
  const source=nativeCases.find(row=>row.name.endsWith('purple-primary-1018')),record=structuredClone(source.record);record.all_moves=[];
  const enemy=owner===0?6:0,side=owner===0?'black':'white',opposite=owner===0?'white':'black';
  for(const player of record.players){player.plates=player.color===side?[id,5022]:[];for(const figure of player.pokemons)
    figure.pokepower=figure.pokemon_index===(power===1425?enemy:owner)?power:-1;}
  const actions=structuredClone(source.record.all_moves.filter(move=>!['spin','declare_battle'].includes(move.value.type)));
  actions.push({selective_side:'white',value:{type:'null_move'}});
  if(owner===6)actions.push({selective_side:'black',value:{type:'mp_move',route:[29,27]}});
  const rejected={selective_side:side,value:{type:'declare_plate',plate_id:id,value:id===5023?{type:'swap_move',pokemons:[owner+1,owner]}
    :id===5306?{type:'spot_move',from:owner===0?15:11,to:owner===0?24:3}
    :{type:id===5426?'select_pokemon_and_declare_aura':'select_pokemon',pokemon:owner}}};
  const rejectAfter=actions.length;
  actions.push({selective_side:side,value:{type:'declare_plate',plate_id:5022,value:{type:'select_pokemon',pokemon:power===1372?owner:owner+1}}},
    {selective_side:side,value:{type:'declare_turn_end'}});
  return {name:`plate-restriction-owner-${owner}-${power}-${id}`,rule:'plate_restriction',evidence_kind:'original_description',owner,power,plate:id,record,actions,
    rejected,reject_after:rejectAfter,final_turn:opposite,spin_units:{},expected_spins:[],evidence:'Original Wily Jaws target prohibition and Slow Start field movement prohibition.'};
}));
const benchScopeCases=[0,6].flatMap(owner=>[
  ...[1052,1467,1630].map(id=>({id,mode:'base'})),{id:1052,mode:'protected'},{id:1467,mode:'trap'},{id:1630,mode:'protected'},
  {id:1467,mode:'decline'},{id:1467,mode:'respin'},{id:1052,mode:'secondary'},{id:1467,mode:'secondary'},
].map(({id,mode})=>{
  const source=nativeCases.find(row=>row.name.endsWith('purple-primary-1018')),record=structuredClone(source.record);record.all_moves=[];
  const enemy=owner===0?6:0,side=owner===0?'black':'white',opposite=owner===0?'white':'black',chance=['decline','respin'].includes(mode),secondary=mode==='secondary';
  for(const player of record.players){if(player.color===side)player.plates=[5015];for(const figure of player.pokemons){
    const p=figure.pokemon_index;figure.id=[owner+1,enemy+1].includes(p)?1001:1002;figure.pokepower=-1;
    figure.skills=[{id:secondary&&p===enemy?1001:1199,color:1,range:96,speed_or_damage:100}];
    if(p===owner)figure.skills=[{id,color:2,range:chance?48:96,speed_or_damage:{1052:1,1467:3,1630:2}[id]},...(chance?[{id:1122,color:4,range:48,speed_or_damage:0}]:[])];
    if(mode==='trap'&&p===enemy)figure.pokepower=1426;
    if(mode==='protected'&&p===(id===1052?owner+1:enemy))figure.pokepower=1018;
  }}
  const actions=structuredClone(source.record.all_moves.filter(move=>!['spin','declare_battle'].includes(move.value.type)));
  actions.push({selective_side:'white',value:{type:'null_move'}},
    {selective_side:'black',value:{type:'mp_move',route:[29,27,20]}},
    {selective_side:'white',value:{type:'mp_move',route:[35,6]}});
  if(owner===6)actions.push({selective_side:'black',value:{type:'mp_move',route:[30,21]}});
  if(chance)actions.push({selective_side:side,value:{type:'declare_plate',plate_id:5015,value:{type:'select_pokemon',pokemon:owner}}});
  actions.push({selective_side:side,value:{type:'declare_battle',from_pokemon:owner,to_pokemon:enemy}});
  if(mode==='decline')actions.push({selective_side:side,value:{type:'null_move'}});
  if(mode==='respin')actions.push({selective_side:side,value:{type:'declare_respin',pokemons:[owner]}});
  const initialPoints={[owner]:owner===0?15:11,[enemy]:owner===0?11:15,[owner+1]:owner===0?20:6,[enemy+1]:owner===0?6:20};
  const finalPoints={...initialPoints},finalWaits=Object.fromEntries(Object.keys(initialPoints).map(p=>[p,0]));
  if(mode!=='respin') {
    if(id===1467){if(mode!=='trap')finalPoints[owner]=28+owner;finalWaits[owner]=1;}
    else {if(!(id===1630&&mode==='protected'))finalPoints[enemy]=28+enemy;finalWaits[enemy]=id===1630?2:1;}
    if(id===1052){if(mode!=='protected')finalPoints[owner+1]=29+owner;finalWaits[owner+1]=1;}
    if(id===1630)finalWaits[enemy+1]=2;
  }
  const result=(num=0,type='battle')=>({num,displace:0,type});
  const expectedSpins=[[{pokemon:owner,results:[result()]},{pokemon:enemy,results:[result()]}],
    ...(secondary?[[{pokemon:owner,results:[result(0,'probability')]},{pokemon:owner+1,results:[result(0,'probability')]}]]:mode==='respin'?[[{pokemon:owner,results:[result(48)]}]]:[])];
  return {name:`bench-scope-owner-${owner}-${id}-${mode}`,rule:'bench_scope',evidence_kind:'original_description',owner,skill:id,mode,record,actions,final_turn:opposite,
    initial_points:initialPoints,final_points:finalPoints,final_waits:finalWaits,expected_spins:expectedSpins,
    spin_units:{[owner]:secondary?[0,0]:mode==='respin'?[0,48]:[0],[enemy]:[0],...(secondary?{[owner+1]:[0]}:{})},
    evidence:'Original target scopes and Flying12; Wait2, traps and mixed-secondary ordering remain derived and partial.'};
}));
const benchCases=[0,6].flatMap(owner=>[
  ...[1027,1098,1329,1499].map(id=>({id,mode:'base'})),
  ...['protected','decline','respin','secondary'].map(mode=>({id:1027,mode})),
].map(({id,mode})=>{
  const source=nativeCases.find(row=>row.name.endsWith('purple-primary-1018'));
  const record=structuredClone(source.record);record.all_moves=[];
  const enemy=owner===0?6:0,side=owner===0?'black':'white',opponent=owner===0?'white':'black',secondary=mode==='secondary';
  for(const player of record.players){if(player.color===opponent)player.plates=[5015];for(const p of player.pokemons){
    p.pokepower=mode==='protected'&&p.pokemon_index===owner?1007:-1;
    p.skills=[{id:secondary&&p.pokemon_index===owner?1001:1199,color:1,range:96,speed_or_damage:100}];
    if(p.pokemon_index===enemy)p.skills=[{id:1009,color:2,range:48,speed_or_damage:2},{id,color:2,range:48,speed_or_damage:{1027:2,1098:1,1329:1,1499:4}[id]}];
  }}
  const actions=structuredClone(source.record.all_moves.filter(move=>move.value.type!=='spin'));
  if(owner===6)actions.splice(actions.length-1,1,{selective_side:'white',value:{type:'null_move'}},{selective_side:'black',value:{type:'declare_battle',from_pokemon:0,to_pokemon:6}});
  if(!secondary){
    actions.push({selective_side:side,value:{type:'mp_move',route:owner===0?[29,21]:[35,0]}});
    if(['decline','respin'].includes(mode))actions.push({selective_side:opponent,value:{type:'declare_plate',plate_id:5015,value:{type:'select_pokemon',pokemon:enemy}}});
    actions.push({selective_side:opponent,value:{type:'declare_battle',from_pokemon:enemy,to_pokemon:owner}});
    if(mode==='decline')actions.push({selective_side:opponent,value:{type:'null_move'}});
    if(mode==='respin')actions.push({selective_side:opponent,value:{type:'declare_respin',pokemons:[enemy]}});
    if(mode==='base')actions.push({selective_side:side,value:{type:'mp_move',route:owner===0?[21,22]:[0,1]}},
      {selective_side:opponent,value:{type:'mp_move',route:owner===0?[35,0]:[29,21]}},
      {selective_side:side,value:{type:'mp_move',route:owner===0?[28,27]:[34,6]}});
  }
  const result=(num,displace=0,type='battle')=>({num,displace,type});
  const spins=secondary?[[{pokemon:owner,results:[result(0)]},{pokemon:enemy,results:[result(48)]}],[{pokemon:enemy,results:[result(48,0,'probability')]}]]:
    [[{pokemon:owner,results:[result(0)]},{pokemon:enemy,results:[result(0)]}],
      [{pokemon:owner,results:[result(0,1)]},{pokemon:enemy,results:[result(48)]}],
      ...(mode==='respin'?[[{pokemon:enemy,results:[result(0)]}]]:[])];
  return {name:`bench-owner-${owner}-${id}-${mode}`,rule:'bench',evidence_kind:'original_description',owner,skill:id,mode,record,actions,
    final_turn:mode==='base'?opponent:side,expected_spins:spins,
    spin_units:{[owner]:secondary?[0]:[0,0],[enemy]:secondary?[48,48]:mode==='respin'?[0,48,0]:[0,48]},
    evidence:'Original shared bench descriptions and movement protection; Wait2, protected Wait and secondary ordering remain derived.'};
}));
const immunityCases=[0,6].flatMap(owner=>[
  {mode:'self-sleep',ability:1064,skill:1018,condition:'sleep',self:true},
  {mode:'self-multiple',ability:1027,skill:1023,condition:'burn',self:true},
  {mode:'water-aura',ability:1151,skill:1023,condition:'burn',figure:1002},
  {mode:'grass-aura',ability:1396,skill:1073,condition:'poison',figure:1022},
  {mode:'all-aura',ability:1427,skill:1319,condition:'freeze'},
  {mode:'adjacent-aura',ability:1485,skill:1018,condition:'sleep'},
  {mode:'wrong-type',ability:1151,skill:1023,condition:'burn',figure:1001,blocked:false},
  {mode:'bench-aura',ability:1427,skill:1018,condition:'sleep',bench:true,blocked:false},
].map(spec=>{
  const source=nativeCases.find(row=>row.name.endsWith('purple-primary-1018'));
  const record=structuredClone(source.record);record.all_moves=[];
  const enemy=owner===0?6:0,side=owner===0?'black':'white';
  for(const figure of record.players.flatMap(player=>player.pokemons)) {
    figure.pokepower=figure.pokemon_index===(spec.self?owner:owner+1)?spec.ability:-1;
    if(figure.pokemon_index===owner&&spec.figure)figure.id=spec.figure;
    figure.skills=[{id:1199,color:1,range:96,speed_or_damage:100}];
    if(figure.pokemon_index===enemy)figure.skills=[{id:spec.skill,color:2,range:96,speed_or_damage:2}];
  }
  const actions=structuredClone(source.record.all_moves.filter(move=>!['spin','declare_battle'].includes(move.value.type)));
  if(owner===6||(!spec.self&&!spec.bench))actions.push({selective_side:'white',value:{type:'null_move'}});
  if(!spec.self&&!spec.bench) {
    if(owner===0)actions.push({selective_side:'black',value:{type:'mp_move',route:spec.ability===1485?[29,27,20]:[29,21]}});
    else actions.push({selective_side:'black',value:{type:'mp_move',route:[29,21]}},{selective_side:'white',value:{type:'mp_move',route:[35,6]}});
  }
  actions.push({selective_side:enemy===0?'black':'white',value:{type:'declare_battle',from_pokemon:enemy,to_pokemon:owner}});
  return {name:`condition-immunity-owner-${owner}-${spec.mode}`,rule:'condition_immunity',evidence_kind:'original_description',owner,record,actions,
    final_turn:side,condition:spec.condition,ability:spec.ability,expected_condition:spec.blocked===false?spec.condition:'normal',
    spin_units:{[owner]:[0],[enemy]:[0]},evidence:'Original condition immunity descriptions; native prevention notices and ordering remain unverified.'};
}));

const panicCases=[0,6].flatMap(owner=>['respin','secondary'].map(mode=>{
  const source=nativeCases.find(row=>row.name.endsWith('purple-primary-1009'));
  const record=structuredClone(source.record);record.all_moves=[];
  const enemy=owner===0?6:0,side=owner===0?'black':'white';
  for(const player of record.players) {
    if(player.color===side)player.plates=[5015,...player.plates.filter(id=>id!==5015).slice(0,5)];
    for(const figure of player.pokemons) {
      figure.pokepower=-1;
      if(figure.pokemon_index===owner)figure.skills=mode==='respin'?
        [{id:1131,color:0,range:32,speed_or_damage:0},{id:1168,color:1,range:32,speed_or_damage:30},{id:1003,color:3,range:32,speed_or_damage:100}]:
        [{id:1199,color:1,range:32,speed_or_damage:50},{id:1122,color:4,range:32,speed_or_damage:0},{id:1131,color:0,range:32,speed_or_damage:0}];
      if(figure.pokemon_index===enemy)figure.skills=[{id:1009,color:2,range:48,speed_or_damage:2},{id:mode==='respin'?1199:1001,color:1,range:48,speed_or_damage:mode==='respin'?50:100}];
    }
  }
  const actions=structuredClone(source.record.all_moves.filter(move=>move.value.type!=='spin'));
  if(owner===6)actions.splice(actions.length-1,1,{selective_side:'white',value:{type:'null_move'}},{selective_side:'black',value:{type:'declare_battle',from_pokemon:0,to_pokemon:6}});
  if(mode==='respin')actions.push({selective_side:side,value:{type:'declare_plate',plate_id:5015,value:{type:'select_pokemon',pokemon:owner}}});
  actions.push({selective_side:side,value:{type:'declare_battle',from_pokemon:owner,to_pokemon:enemy}});
  if(mode==='respin')actions.push({selective_side:side,value:{type:'declare_respin',pokemons:[owner]}});
  const result=(num,displace=0,type='battle')=>({num,displace,type});
  return {name:`panic-description-owner-${owner}-${mode}`,rule:'panic',mode,evidence_kind:'original_description',owner,record,actions,final_turn:owner===0?'white':'black',
    spin_units:{[owner]:mode==='respin'?[32,64,64,0,0,32]:[0,64,0],[enemy]:[0,48]},
    expected_spins:[[{pokemon:owner,results:mode==='respin'?[result(32),result(64,0,'probability')]:[result(0)]},{pokemon:enemy,results:[result(0)]}],
      [{pokemon:owner,results:[result(64,1)]},{pokemon:enemy,results:[result(48)]}],
      [{pokemon:owner,results:mode==='respin'?[result(0,1),result(0,1,'probability'),result(32,1,'probability')]:[result(0,1,'probability')]}]],
    evidence:'Original panic description and original filtered signed-segment displacement IL. Panic-specific native sign/secondary behavior remains unobserved.'};
}));
const conditionDamageCases=[['burn',10,1023],['poison',20,1073],['bad_poison',40,1075]].flatMap(([condition,penalty,id])=>[0,6].map(owner=>{
  const source=nativeCases.find(row=>row.name.endsWith(`purple-primary-${id}`));
  const record=structuredClone(source.record);record.all_moves=[];
  const side=owner===0?'black':'white',enemy=owner===0?6:0;
  for(const player of record.players) {
    if(player.color===side)player.plates=[5015,...player.plates.filter(id=>id!==5015).slice(0,5)];
    for(const figure of player.pokemons) {
      figure.pokepower=-1;
      if(figure.pokemon_index===owner)figure.skills=[{id:1199,color:1,range:48,speed_or_damage:50},{id:1003,color:3,range:32,speed_or_damage:100},{id:1122,color:4,range:16,speed_or_damage:0}];
      if(figure.pokemon_index===enemy)figure.skills=[{id,color:2,range:48,speed_or_damage:2},{id:1370,color:1,range:48,speed_or_damage:40}];
    }
  }
  const actions=structuredClone(source.record.all_moves.filter(move=>move.value.type!=='spin'));
  if(owner===6)actions.splice(actions.length-1,1,{selective_side:'white',value:{type:'null_move'}},{selective_side:'black',value:{type:'declare_battle',from_pokemon:0,to_pokemon:6}});
  actions.push({selective_side:side,value:{type:'declare_plate',plate_id:5015,value:{type:'select_pokemon',pokemon:owner}}},
    {selective_side:side,value:{type:'declare_battle',from_pokemon:owner,to_pokemon:enemy}},
    {selective_side:side,value:{type:'declare_respin',pokemons:[owner]}});
  return {name:`condition-damage-${condition}-owner-${owner}-respin`,rule:'condition_damage',evidence_kind:'original_description',condition,penalty,owner,record,actions,
    final_turn:owner===0?'white':'black',spin_units:{[owner]:[0,0,48],[enemy]:[0,48]},condition_choices:[],
    evidence:'Original condition damage descriptions and official smallest-Attack burn rule. Typed ConditionDamageNotice_Sum from original IL; native ordering remains unverified.'};
}));
const frozenCases=[0,6].map(owner=>{
  const source=nativeCases.find(row=>row.name.endsWith('purple-primary-1319'));
  const record=structuredClone(source.record);record.all_moves=[];
  const side=owner===0?'black':'white',enemy=owner===0?6:0,enemySide=owner===0?'white':'black';
  for(const player of record.players) {
    if(player.color===enemySide)player.plates=[5015,...player.plates.filter(id=>id!==5015).slice(0,5)];
    for(const figure of player.pokemons) {
      figure.pokepower=-1;
      if(figure.pokemon_index===owner)figure.skills=[{id:1199,color:1,range:16,speed_or_damage:50},{id:1003,color:3,range:16,speed_or_damage:50},
        {id:1009,color:2,range:16,speed_or_damage:1},{id:1122,color:4,range:16,speed_or_damage:0},{id:1122,color:4,range:16,speed_or_damage:0},{id:1131,color:0,range:16,speed_or_damage:0}];
      if(figure.pokemon_index===enemy)figure.skills=[{id:1319,color:2,range:32,speed_or_damage:1},{id:1122,color:4,range:32,speed_or_damage:0},{id:1621,color:1,range:32,speed_or_damage:50}];
    }
  }
  const actions=structuredClone(source.record.all_moves.filter(move=>move.value.type!=='spin'));
  if(owner===6)actions.splice(actions.length-1,1,{selective_side:'white',value:{type:'null_move'}},
    {selective_side:'black',value:{type:'declare_battle',from_pokemon:0,to_pokemon:6}});
  actions.push({selective_side:side,value:{type:'mp_move',route:owner===0?[29,21]:[35,0]}},
    {selective_side:enemySide,value:{type:'declare_plate',plate_id:5015,value:{type:'select_pokemon',pokemon:enemy}}},
    {selective_side:enemySide,value:{type:'declare_battle',from_pokemon:enemy,to_pokemon:owner}},
    {selective_side:enemySide,value:{type:'declare_respin',pokemons:[enemy]}});
  return {name:`freeze-description-owner-${owner}-respin`,rule:'freeze',evidence_kind:'original_description',owner,record,actions,
    final_turn:side,spin_units:{[owner]:[0,64],[enemy]:[0,32,64]},condition_choices:[],
    evidence:'Original ConditionDescription.freeze: all Attacks miss; incoming battle and Double Chance integration are description-derived.'};
});
const paralysisCases=[0,6].map(owner=>{
  const source=nativeCases.find(row=>row.name.endsWith('purple-primary-1045'));
  const record=structuredClone(source.record);record.all_moves=[];
  const side=owner===0?'black':'white',enemy=owner===0?6:0;
  for(const player of record.players) {
    if(player.color===side&&!player.plates.includes(5015))player.plates=[5015,...player.plates.slice(1)];
    for(const figure of player.pokemons) {
      figure.pokepower=-1;
      if(figure.pokemon_index===owner)figure.skills=[{id:1199,color:1,range:48,speed_or_damage:50},
        {id:1122,color:4,range:16,speed_or_damage:0},{id:1003,color:3,range:16,speed_or_damage:50},{id:1009,color:2,range:16,speed_or_damage:1}];
      else if(figure.pokemon_index===enemy)figure.skills=[{id:1045,color:2,range:96,speed_or_damage:2}];
    }
  }
  const actions=structuredClone(source.record.all_moves.filter(move=>move.value.type!=='spin'));
  if(owner===6)actions.splice(actions.length-1,1,{selective_side:'white',value:{type:'null_move'}},
    {selective_side:'black',value:{type:'declare_battle',from_pokemon:0,to_pokemon:6}});
  actions.push({selective_side:side,value:{type:'declare_plate',plate_id:5015,value:{type:'select_pokemon',pokemon:owner}}},
    {selective_side:side,value:{type:'declare_battle',from_pokemon:owner,to_pokemon:enemy}},
    {selective_side:side,value:{type:'declare_respin',pokemons:[owner]}});
  return {name:`paralysis-description-owner-${owner}-respin`,rule:'paralysis',evidence_kind:'original_description',owner,record,actions,
    final_turn:owner===0?'white':'black',spin_units:{[owner]:[0,48,64],[enemy]:[0,0]},
    condition_choices:[{pokemon:owner,maximum:3,index:0}],evidence:'Original condition description; smallest-Attack official guide; retained native grouped-segment selections; explicit tied-choice control.'};
});
const scenarios = [null, ...['pNTxjA-tackle','MwInsm-ice-shard-followup','lpQUX7-double-chance-repeat','lpQUX7-double-chance-decline','50GwDF-single-retry-1283-hit','50GwDF-single-retry-1676-hit','GIuc81-black-attacker-repeat','GIuc81-black-attacker-ice-shard','GIuc81-retry-1676-x-attack'].map(suffix => {
  const entry=nativeCases.find(row=>row.name.endsWith(suffix));assert(entry);return entry;
}), ...nativeCases.filter(entry=>entry.name.startsWith('native-multispin-rkcpj1-purple-primary-')), ...blackoutCases, ...paralysisCases, ...frozenCases, ...conditionDamageCases, ...panicCases, ...immunityCases, ...benchCases, ...benchScopeCases, ...plateRestrictionCases, ...plateProhibitionCases, ...damageAuraCases, ...fieldCountDamageCases, ...battleColorCases, ...battleColorScopeCases, ...purpleStarNetworkCases(nativeCases), ...effectKnockoutNetworkCases(nativeCases), ...conditionalKnockoutNetworkCases(nativeCases), ...purpleWaitNetworkCases(nativeCases), ...purpleConditionNetworkCases(nativeCases)];
scenarios.push(...surroundingNetworkCases(nativeCases));
scenarios.push(...surroundingPlateNetworkCases(nativeCases));
scenarios.push(...purpleFlyNetworkCases(nativeCases));
scenarios.push(...doubleFlightNetworkCases(nativeCases));
scenarios.push(...doubleFlightConditionNetworkCases(nativeCases));
scenarios.push(...doubleFlightInteractionNetworkCases(nativeCases));
scenarios.push(...doubleFlightOwnerTurnNetworkCases(nativeCases));
scenarios.push(...fieldEntryRecoveryNetworkCases(nativeCases));
scenarios.push(...duelEntryRecoveryNetworkCases(nativeCases));
scenarios.push(...battleDamageReductionNetworkCases(nativeCases));
scenarios.push(...fieldDamageReductionNetworkCases(nativeCases));
scenarios.push(...movementTransitNetworkCases(nativeCases));
scenarios.push(...postMpBattleNetworkCases(nativeCases));
scenarios.push(...waitConditionalNetworkCases(nativeCases));
scenarios.push(...waterProviderNetworkCases(nativeCases));
scenarios.push(...typedArrowNetworkCases(nativeCases));
scenarios.push(...floatingCandleNetworkCases());
scenarios.push(...(await import('../tests/curse-history-network-cases.mjs')).curseHistoryNetworkCases());
scenarios.push(...(await import('../tests/grudge-entry-network-cases.mjs')).grudgeEntryNetworkCases());
scenarios.push(...(await import('../tests/touch-recovery-network-cases.mjs')).touchRecoveryNetworkCases());
scenarios.push(...(await import('../tests/battle-condition-network-cases.mjs')).battleConditionNetworkCases());
for (const scenario of scenarios) test(`real Godot bootstrap/match clients complete a human WS match through disconnect restore and results: ${scenario?.name ?? 'goal'}`, {
  timeout: 60000,
  skip: !existsSync(godot) ? "Set DUEL_TEST_GODOT to the headless Godot executable" : false,
}, async (t) => {
  const ruleCase=scenario?.evidence_kind==='original_description'||scenario?.curse_history_case||scenario?.grudge_entry_case||scenario?.touch_recovery_case||scenario?.condition_transition_case?scenario:null;
  const nativeCase=ruleCase?null:scenario;
  const directory = mkdtempSync(join(tmpdir(), "kiwi-duel-godot-human-"));
  const roaming = join(directory, "roaming");
  const xdg = join(directory, "xdg");
  mkdirSync(roaming); mkdirSync(xdg);
  const players = [0, 1].map((index) => ({
    email: `godot-human-${index}@example.test`, displayName: `Godot_Human_${index}`,
    password: `godot-password-${randomUUID()}`, deviceToken: `godot-device-${randomUUID()}`,
  }));
  const privateValues = new Set(players.flatMap((player) => [player.password, player.deviceToken]));
  const seedPath = join(directory, "private-test-seeds.json");
  const fixturePath = join(directory, "private-godot-fixture.json");
  writeFileSync(seedPath, JSON.stringify({ accounts: players }));
  let server;
  let runner;
  try {
    const httpPort = await freePort();
    let gamePort = await freePort();
    while (gamePort === httpPort) gamePort = await freePort();
    const base = `http://127.0.0.1:${httpPort}`;
    writeFileSync(fixturePath, JSON.stringify({
      isolation_root: directory, base_url: base, players: players.map((player) => ({ device_token: player.deviceToken })),
      ...(nativeCase ? {native_case:nativeCase}:{}),
      ...(ruleCase ? {rule_case:ruleCase}:{}),
    }));
    const preload = scenario ? ['--import',new URL('../tests/isolated-native-match-loader.mjs',import.meta.url).href] : [];
    server = childProcess(process.execPath, [...preload,fileURLToPath(new URL("./custom-bootstrap-server.mjs", import.meta.url))], {
      ...process.env, NODE_ENV: "test", DUEL_SERVER_HOST: "127.0.0.1", DUEL_SERVER_PORT: String(httpPort),
      DUEL_SERVER_PUBLIC_BASE: base, DUEL_GAME_SERVER_HOST: "127.0.0.1", DUEL_GAME_SERVER_PORT: String(gamePort),
      DUEL_GAME_SERVER_PUBLIC_HOST: "127.0.0.1", DUEL_ACCOUNT_DATABASE: join(directory, "accounts.sqlite"),
      DUEL_SEED_ACCOUNTS_PATH: seedPath, DUEL_DEFAULT_MATCH_MODE: "human", DUEL_GAME_MOVE_DELAY_MS: "1",
      DUEL_GAME_OPPONENT_PLATE_MODE: "off", DUEL_GAME_BATTLE_EVIDENCE_MODE: "off",
      ...(scenario ? {DUEL_NATIVE_FIXTURE_PATH:fixturePath}:{}),
    });
    let ready = false;
    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (server.launchError || server.child.exitCode != null) throw new Error("isolated_bootstrap_failed");
      try {
        const health = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(500) }).then((response) => response.json());
        if (health.ok && health.data.game_port === gamePort) { ready = true; break; }
      } catch {}
      await delay(20);
    }
    assert.equal(ready, true, "disposable bootstrap is healthy");
    runner = childProcess(godot, ["--headless", "--path", project, "--log-file", join(directory, "godot-private.log"),
      "--script", "res://tests/human_connection_runner.gd", "--", `--human-fixture=${fixturePath}`], {
      ...process.env, APPDATA: roaming, XDG_DATA_HOME: xdg,
    });
    const deadline = Date.now() + 45000;
    while (runner.child.exitCode == null && runner.child.signalCode == null) {
      if (runner.launchError) throw new Error("isolated_godot_launch_failed");
      if (runner.output.includes('SCRIPT ERROR:')) throw new Error(`isolated_godot_script_failed: ${runner.output.split(/\r?\n/u).filter(line=>/SCRIPT ERROR:|at:/.test(line)).slice(-8).join(' | ')}`);
      if (Date.now() >= deadline) throw new Error("isolated_godot_timeout");
      await delay(20);
    }
    for (const secret of privateValues) {
      assert.equal(server.output.includes(secret), false, "server output leaks no fixture secret");
      assert.equal(runner.output.includes(secret), false, "Godot output leaks no fixture secret");
    }
    const line = runner.output.split(/\r?\n/u).find((value) => value.startsWith("GODOT_HUMAN_CONNECTION="));
    if (!line) {
      const diagnostics = runner.output.split(/\r?\n/u).filter((value) => /SCRIPT ERROR|Parse Error|ERROR:|at:/.test(value));
      throw new Error(`Godot proof missing: ${diagnostics.slice(-12).join(" | ")}`);
    }
    const proof = JSON.parse(line.slice("GODOT_HUMAN_CONNECTION=".length));
    const serverRejections=server.output.split(/\r?\n/u).filter(line=>line.startsWith('MATCH_COMPLETION_REJECTED '));
    assert.equal(proof.ok, true, `Godot integration failed: ${proof.error}; ${JSON.stringify({step:proof.native_step,diagnostics:proof.diagnostics,server_rejections:serverRejections.slice(-6)})}`);
    assert.equal(runner.child.exitCode, 0);
    assert.equal(proof.real_battle_clients, 2);
    if (!scenario) assert.equal(proof.move_count, 17);
    else assert.equal(proof.reason,'resign');
    assert.equal(proof.socket_disconnect_restore, true);
    assert.equal(proof.reset_complete, true);
    assert.equal(proof.user_directory_isolated, true);
    assert.equal(proof.bootstrap_proofs.length, 2);
    for (const bootstrap of proof.bootstrap_proofs) {
      assert.equal(bootstrap.protocol_contract, 2);
      assert.equal(bootstrap.authenticated_room_owner_verified, true);
      assert.equal(bootstrap.remote_master_binding_verified, true);
      assert.equal(bootstrap.figure_master_count, 583);
      assert.equal(bootstrap.resolved, 14);
      assert.equal(bootstrap.completed, 10);
      assert.equal(bootstrap.total, 14);
      assert.ok(bootstrap.completed < bootstrap.total, "resolved unsupported gates must not become completed original fidelity");
      assert.equal(bootstrap.full_original_ready, false);
      assert.ok(bootstrap.fidelity_boundaries.includes("tutorial_progress"));
      assert.equal(bootstrap.fidelity_boundaries.length, 8);
      assert.deepEqual(bootstrap.cached_master_counts, { boot_constants: 259, chapter_masters: 71, arena_league_masters: 9, arena_reward_box_masters: 7 });
      assert.deepEqual(bootstrap.cached_master_digests, packagedMasterBinding().digests);
      assert.equal(bootstrap.master_source_revision, 800);
      assert.equal(bootstrap.master_join_count, 17503);
      assert.equal(bootstrap.runtime_league_index_count, 9);
      assert.equal(bootstrap.startup_audio_scheduled, true);
      assert.equal(bootstrap.startup_audio_expected, 18);
      assert.equal(bootstrap.startup_audio_loaded_after_match, 18);
      assert.equal(bootstrap.audio_completion_is_boot_barrier, false);
    }
    for (const operations of proof.boot_operations) {
      for (const operation of ["service_state", "revision_master", "login", "asset_manifest", "asset", "figure_masters", "room_preload", "matching_entry", "battle_challenge", "matching_result", "matching_reset_active"]) {
        assert.ok(operations.includes(operation), `real Godot operation missing: ${operation}`);
      }
    }
    const newPhaseRecoveries = side => (ruleCase?.actions ?? []).filter(action => action.selective_side === side).reduce((total, action) => total + Number(Boolean(action.grudge_reconnect)) + Number(Boolean(action.touch_reconnect)) + (action.touch_rejections ? 2 : 0) + (action.condition_extra_declaration ? 4 : 0), 0);
    if (ruleCase?.touch_recovery_case || ruleCase?.grudge_entry_case || ruleCase?.condition_transition_case) {
      for (const [index, side] of ['black', 'white'].entries()) {
        assert.equal(proof.boot_operations[index].filter(operation => operation === 'battle_challenge').length, 1 + Number(side === 'white') + newPhaseRecoveries(side), `${side}: each pending-phase restore and final White reconnect obtains a fresh HTTP ticket`);
      }
    }
    assert.equal(proof.boot_operations[['plate_restriction','plate_prohibition'].includes(ruleCase?.rule)?ruleCase.owner/6:1].filter((operation) => operation === "battle_challenge").length, 2 + newPhaseRecoveries('white') + (ruleCase?.purple_wait_case || ruleCase?.purple_condition_case || ruleCase?.surrounding_case || ruleCase?.field_entry_recovery_case || ruleCase?.battle_damage_reduction_case || ruleCase?.field_damage_reduction_case || ruleCase?.movement_transit_case || ruleCase?.post_mp_battle_case ? ruleCase.actions.filter(action=>action.expected_rejection && action.selective_side==='white').length : 0) + (ruleCase?.purple_jump_case && ruleCase.owner === 6 ? 1 : 0) + (ruleCase?.double_flight_case && ruleCase.owner === 6 ? ruleCase.actions.filter(action=>action.pending_extra_battle).length : 0),
      "recovery asks real HTTP for a new ticket rather than replaying the old proof");
    for (const [index, player] of players.entries()) {
      const login = await api(base, "/v1/session/login", { device_token: player.deviceToken });
      privateValues.add(login.access_token);
      assert.equal(login.user.user_id, index === 0 ? proof.first_user_id : proof.second_user_id);
      const completion = await api(base, "/v1/matches/get", { matchId: proof.match_id }, login.access_token);
      assert.equal(completion.record.all_moves.length, scenario ? proof.move_count : 17);
      if (ruleCase) {
        const paralysis=ruleCase.rule==='paralysis',plateRestriction=ruleCase.rule==='plate_restriction',plateProhibition=ruleCase.rule==='plate_prohibition',aura=ruleCase.rule==='damage_aura';
        const frozen=ruleCase.rule==='freeze',damage=ruleCase.rule==='condition_damage',panic=ruleCase.rule==='panic',immunity=ruleCase.rule==='condition_immunity',bench=['bench','bench_scope'].includes(ruleCase.rule),condition=paralysis||frozen||damage;
        const commands=completion.record.all_moves.filter(move=>!['spin','add_z_gauge'].includes(move.value.type)).map(move=>move.value);
        let battles=0;
        const expected=ruleCase.expected_commands??ruleCase.actions.flatMap(move=>move.value.type==='declare_battle'&&++battles===2&&!panic&&!bench&&!aura&&(!damage||ruleCase.condition==='burn')
          ?[move.value,{pokemon:condition?ruleCase.owner:ruleCase.owner===0?6:0,skill_id:frozen?[1199,1003,1009,1122]:[1122],type:'disable_skill'}]:[move.value]);
        assert.deepEqual(commands,[...expected,{type:'resign'}]);
        const spins=completion.record.all_moves.filter(move=>move.value.type==='spin');
        assert.equal(spins.length,plateRestriction?0:plateProhibition?1:bench||aura?ruleCase.expected_spins.length:immunity?1:condition||panic||ruleCase.ending==='secondary_ko'?3:2);
        for(const [index,move] of spins.entries()) {
          if(panic||bench||plateProhibition||aura) {
            assert.deepEqual([...move.value.spins].sort((a,b)=>a.pokemon-b.pokemon),[...ruleCase.expected_spins[index]].sort((a,b)=>a.pokemon-b.pokemon));
            if(ruleCase.exact_spin_order)assert.deepEqual(move.value.spins,ruleCase.expected_spins[index],'durable native Spin wire order');
            continue;
          }
          // Both secondary spins and Double Chance publish only the affected
          // wheel. The previous opponent result remains in the record prefix.
          assert.deepEqual(move.value.spins.map(spin=>spin.pokemon).sort((a,b)=>a-b),index===2?[frozen?(ruleCase.owner===0?6:0):ruleCase.owner]:[0,6]);
          for(const spin of move.value.spins) assert.deepEqual(spin.results,[{displace:0,
            num:damage?(spin.pokemon===ruleCase.owner?[0,0,48][index]:[0,48][index]):frozen?(spin.pokemon===ruleCase.owner?[0,64][index]:[0,32,64][index]):paralysis?(spin.pokemon===ruleCase.owner?[0,48,64][index]:0):index===1?60:0,type:index===2&&!condition?'probability':'battle'}]);
        }
        assert.equal(proof.rule_evidence_kind,ruleCase.evidence_kind);
        if(ruleCase.curse_history_case){assert.equal(proof.curse_acquisition_and_exclusion_verified,true);assert.equal(proof.curse_state_checks,ruleCase.actions.length*24);}
        if(ruleCase.grudge_entry_case){assert.equal(proof.grudge_entry_verified,true);assert.equal(proof.grudge_state_checks,ruleCase.actions.filter(a=>a.grudge_expected_state).length*24);}
        if(ruleCase.touch_recovery_case){assert.equal(proof.touch_recovery_verified,true);assert.equal(proof.touch_state_checks,ruleCase.actions.length*24);assert.equal(proof.touch_rejections,2);}
        if(ruleCase.condition_transition_case){assert.equal(proof.condition_transitions_verified,true);assert.equal(proof.condition_state_checks,ruleCase.actions.length*24);assert.equal(proof.condition_gauge_checks,ruleCase.actions.length*2);
          if(ruleCase.exact_spin_order)assert.equal(proof.exact_spin_order_verified,true);
          const extra=ruleCase.actions.filter(a=>a.condition_extra_declaration).length;assert.equal(proof.condition_extra_rejections,extra*3);assert.equal(proof.condition_extra_reconnects,extra);}
        if(aura){
          assert.equal(proof.damage_aura_verified,true);assert.deepEqual(proof.aura_final_positions,ruleCase.expected_positions);
          if(ruleCase.expected_colors)assert.equal(proof.battle_colors_verified,true);
          if(ruleCase.expected_values)assert.equal(proof.purple_stars_verified,true);
          if(ruleCase.effect_knockout_case)assert.equal(proof.effect_knockouts_verified,true);
          if(ruleCase.conditional_knockout_case)assert.equal(proof.conditional_knockouts_verified,true);
          if(ruleCase.purple_wait_case){
            assert.equal(proof.purple_wait_verified,true);
            assert.equal(proof.rejected_wait_movements,ruleCase.actions.filter(action=>action.expected_rejection).length);
          }
          if(ruleCase.purple_condition_case){
            assert.equal(proof.purple_conditions_verified,true);
            assert.equal(proof.rejected_condition_movements,ruleCase.actions.filter(action=>action.expected_rejection).length);
          }
          if(ruleCase.surrounding_case){
            assert.equal(proof.surrounding_verified,true);
            assert.equal(proof.rejected_surround_movements,ruleCase.actions.filter(action=>action.expected_rejection).length);
          }
          if(ruleCase.field_entry_recovery_case){
            assert.equal(proof.field_entry_recovery_verified,true);
            assert.equal(proof.rejected_entry_actions,ruleCase.actions.filter(action=>action.expected_rejection).length);
          }
          if(ruleCase.battle_damage_reduction_case){
            assert.equal(proof.battle_damage_reduction_verified,true);
            assert.equal(proof.rejected_reduction_actions,ruleCase.actions.filter(action=>action.expected_rejection).length);
          }
          if(ruleCase.field_damage_reduction_case){
            assert.equal(proof.field_damage_reduction_verified,true);
            assert.equal(proof.rejected_field_reduction_actions,ruleCase.actions.filter(action=>action.expected_rejection).length);
          }
          if(ruleCase.post_mp_battle_case){
            assert.equal(proof.post_mp_battle_verified,true);
            assert.equal(proof.rejected_post_mp_actions,ruleCase.actions.filter(action=>action.expected_rejection).length);
            assert.equal(proof.post_mp_completed_turns,ruleCase.expected_completed_turns);
          }
          if(ruleCase.water_provider_damage_case){
            assert.equal(proof.water_provider_damage_verified,true);
            assert.equal(proof.provider_completed_turns,ruleCase.expected_completed_turns);
          }
          if(ruleCase.movement_transit_case){
            assert.equal(proof.movement_transit_verified,true);
            assert.equal(proof.rejected_transit_actions,ruleCase.actions.filter(action=>action.expected_rejection).length);
            assert.equal(proof.transit_completed_turns,ruleCase.expected_completed_turns);
          }
        }
        else if(plateProhibition){assert.equal(proof.plate_prohibition_verified,true);assert.equal(proof.rejected_plate_restored,true);}
        else if(plateRestriction){assert.equal(proof.plate_restriction_verified,true);assert.equal(proof.rejected_plate_restored,true);}
        else if(paralysis)assert.equal(proof.paralysis_respin_choice_verified,true);
        else if(frozen)assert.equal(proof.freeze_respin_verified,true);
        else if(damage)assert.equal(proof.condition_damage_respin_verified,true);
        else if(panic)assert.equal(proof.panic_displacement_verified,true);
        else if(immunity)assert.equal(proof.condition_immunity_verified,true);
        else if(bench)assert.equal(proof.bench_verified,true);
        else assert.equal(proof.blackout_battles_verified,2);
      }
      if (nativeCase) {
        const final=nativeCase.continuations.at(-1)??nativeCase;
        // Native commands and output effects are separate channels. The owned
        // protocol additionally records gauge effects; compare those to the
        // native effect channel below instead of mistaking them for commands.
        const substantive=record=>record.all_moves.filter(move=>move.value.type!=='add_z_gauge').map(move=>move.value);
        assert.deepEqual(substantive(completion.record),[...substantive(final.record),{type:'resign'}]);
        const battleIndex=completion.record.all_moves.findLastIndex(move=>move.value.type==='spin');
        const gaugeEffects=completion.record.all_moves.slice(battleIndex+1).filter(move=>move.value.type==='add_z_gauge').map(move=>move.value);
        assert.deepEqual(gaugeEffects,final.effects.filter(move=>move.value.type==='add_z_gauge').map(move=>move.value));
      }
      const hash = createHash("sha256").update(JSON.stringify(canonical(completion.record))).digest("hex");
      assert.equal(hash, proof.record_sha256, "both real Godot clients converge with durable server authority");
      const result = await api(base, "/v1/matching/result", { matchId: proof.match_id }, login.access_token);
      assert.equal(result.won, index === (proof.winner === 'black' ? 0 : 1));
      assert.equal(result.chest_award.created, false);
    }
    const runtimeFiles = filesBelow(roaming).concat(filesBelow(xdg));
    assert.equal(runtimeFiles.some((path) => /battle-(?:move-command|move-result|engine-record)\.json$/.test(path)), false,
      "mailbox disabled for this multi-client fixture");
    for (const path of runtimeFiles.filter((path) => path.endsWith(".json") || path.endsWith(".log"))) {
      const text = readFileSync(path, "utf8");
      for (const secret of privateValues) assert.equal(text.includes(secret), false, "no auth credentials in cache or logs");
    }
    t.diagnostic(JSON.stringify({ ...proof, live_service_touched: false, durable_server_record_verified: true }));
  } finally {
    await stop(runner);
    await stop(server);
    const resolvedDirectory = resolve(directory);
    if (dirname(resolvedDirectory) !== resolve(tmpdir()) || !basename(resolvedDirectory).startsWith("kiwi-duel-godot-human-")) {
      throw new Error("unsafe_godot_test_cleanup_target");
    }
    rmSync(resolvedDirectory, { recursive: true, force: true });
  }
});
