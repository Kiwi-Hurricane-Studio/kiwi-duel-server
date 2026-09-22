import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {CustomMatchService,customMatchTestHooks as hooks,customMatchContract as battleContract} from './custom-match-engine.mjs';
import {fieldEntryRecoveryPlan} from './field-entry-recovery.mjs';
const contract=JSON.parse(readFileSync(new URL('../docs/generated/mechanics-20260913/field-entry-recovery-contract.json',import.meta.url)));
const special=['bad_poison','burn','freeze','melt','panic','paralyze','poison','sleep'];
const state=m=>JSON.stringify({record:m.record,points:[...m.positions],conditions:[...m.conditions],waits:[...m.waits],disabled:[...m.disabledSkills],turn:m.turn,ledger:m.completedTurnLedger,plates:m.plateState});
function fixture(t,owner,ability,binding){
 t.mock.method(globalThis,'setTimeout',()=>({unref(){}}));
 const service=new CustomMatchService({port:0,clockSource:()=>0}),match=service.createMatch('field-entry-recovery-isolated'),errors=[],side=owner===0?'black':'white',enemy=owner===0?6:0,rotate=p=>owner===0?p:27-p;
 match.phase='started';match.socket={destroyed:false,write(){},destroy(e){errors.push(e?.message)}};service.playOpponentTurn=()=>{};service.rejectPlayerMove=(_m,reason)=>errors.push(reason);
 for(const player of match.record.players){player.plates=[5023,5026];for(const f of player.pokemons){f.id=1005;f.mp=2;f.pokepower=-1;f.skills=[{id:1199,color:1,range:96,speed_or_damage:50}];}}
 const figure=p=>match.record.players.flatMap(p=>p.pokemons).find(f=>f.pokemon_index===p);figure(owner).id=binding;figure(owner).pokepower=ability;match.turn=side;
 match.positions.set(owner+1,rotate(11));match.positions.set(owner+2,rotate(10));match.positions.set(owner+4,owner===0?41:43);match.positions.set(owner+5,-1);match.positions.set(enemy,rotate(5));
 for(const p of [owner+1,owner+3,owner+4,owner+5,enemy]){match.conditions.set(p,'poison');match.waits.set(p,4);match.battledAfterField.set(p,true);}
 hooks.ensurePlateState(match);
 t.after(()=>{match.phase='finished'});
 return {service,match,errors,owner,enemy,side,rotate,figure,send(move){service.acceptPlayerMove(match,move,move.selective_side)}};
}
function movement(f,kind){return {selective_side:f.side,value:kind==='mp'?{type:'mp_move',route:[28+f.owner,f.rotate(27)]}:{type:'declare_plate',plate_id:kind==='switch'?5023:5026,value:kind==='switch'?{type:'swap_move',pokemons:[f.owner,f.owner+2]}:{type:'spot_move',from:28+f.owner,to:f.rotate(20)}}};}
for(const description of contract.descriptions)for(const binding of description.figures)for(const owner of [0,6])for(const kind of ['mp','throw','switch']){
 const ability=Number(description.key.split(':')[1]);
 test(`${owner}: entry ${ability} figure${binding} through ${kind} preserves separate condition and Wait scope`,t=>{
  for(const prior of special){
   const f=fixture(t,owner,ability,binding),m=f.match;for(const p of [owner+1,owner+3,owner+4,owner+5,f.enemy])m.conditions.set(p,prior);
   const beforePoints=new Map(m.positions),beforeHistory=new Map(m.battledAfterField),move=movement(f,kind);f.send(move);assert.deepEqual(f.errors,[],prior);
   for(let p=0;p<12;p++){
    const selected=p===owner+1;
    assert.equal(m.conditions.get(p),selected&&ability===1186?'normal':[owner+1,owner+3,owner+4,owner+5,f.enemy].includes(p)?prior:'normal');
    assert.equal(m.waits.get(p),selected&&ability===1198?0:[owner+1,owner+3,owner+4,owner+5,f.enemy].includes(p)?3:0);
    assert.equal(m.battledAfterField.get(p),p===owner||kind==='switch'&&p===owner+2?false:beforeHistory.get(p));
    if(p!==owner&&!(kind==='switch'&&p===owner+2))assert.equal(m.positions.get(p),beforePoints.get(p));
   }
   assert.equal(m.completedTurnLedger.completed_turns,1);assert.equal(m.turn,owner===0?'white':'black');assert.equal(new Set([...m.positions.values()].filter(p=>p>=0)).size,11);
   const completed=state(m);f.send(move);assert.deepEqual(f.errors,['stale_player_turn']);assert.equal(state(m),completed);
  }
 });
}
for(const owner of [0,6])for(const ability of [1186,1198])test(`${owner}: entry ${ability} source and recipient boundaries and order are deterministic`,t=>{
 const f=fixture(t,owner,ability,ability===1186?1159:1332),m=f.match,before=new Map(m.positions),after=new Map(before);after.set(owner,f.rotate(27));
 m.conditions.set(owner,'burn');m.waits.set(owner,3);
 const plan=fieldEntryRecoveryPlan(m.record,before,after,m.conditions,m.waits);assert.equal(plan.length,1);
 assert.deepEqual(plan[0].condition_targets,ability===1186?[owner,owner+1]:[]);assert.deepEqual(plan[0].wait_targets,ability===1198?[owner,owner+1]:[]);
 const reverse=structuredClone(m.record);reverse.players.reverse();for(const p of reverse.players)p.pokemons.reverse();assert.deepEqual(fieldEntryRecoveryPlan(reverse,new Map([...before].reverse()),new Map([...after].reverse()),m.conditions,m.waits),plan);
 const alternate=new Map(before);alternate.set(owner,28+owner+1);assert.deepEqual(fieldEntryRecoveryPlan(m.record,alternate,after,m.conditions,m.waits),plan);
 for(const from of [-1,0,27,40,41,42,43,28+f.enemy]){const p=new Map(before);p.set(owner,from);assert.deepEqual(fieldEntryRecoveryPlan(m.record,p,after,m.conditions,m.waits),[]);}
 for(const to of [-1,28+owner,40,41,42,43]){const p=new Map(after);p.set(owner,to);assert.deepEqual(fieldEntryRecoveryPlan(m.record,before,p,m.conditions,m.waits),[]);}
 f.figure(owner).pokepower=-1;assert.deepEqual(fieldEntryRecoveryPlan(m.record,before,after,m.conditions,m.waits),[]);
});
for(const owner of [0,6])test(`${owner}: recovery before surrounding can restore a sleeping contributor; failed admission is atomic`,t=>{
 const f=fixture(t,owner,1186,1159),m=f.match;m.positions.set(f.enemy,f.rotate(15));m.conditions.set(f.enemy,'normal');m.conditions.set(owner+1,'sleep');
 const move=movement(f,'throw');f.send(move);assert.deepEqual(f.errors,[]);assert.equal(m.positions.get(f.enemy),f.enemy===0?41:43);assert.equal(m.conditions.get(owner+1),'normal');assert.equal(m.waits.get(owner+1),3);assert.equal(m.completedTurnLedger.completed_turns,1);
 const invalid=fixture(t,owner,1186,1159);invalid.match.positions.set(invalid.enemy,invalid.rotate(15));invalid.figure(invalid.enemy).pokepower=1054;invalid.match.conditions.set(owner+1,'sleep');
 const before=state(invalid.match);invalid.send(movement(invalid,'throw'));assert.deepEqual(invalid.errors,['illegal_player_plate']);assert.equal(state(invalid.match),before);
});
for(const ability of [1186,1198])test(`training opponent executes entry ${ability} through the real plate path`,t=>{
 const f=fixture(t,6,ability,ability===1186?1159:1332);f.service.chooseObservedOpponentPlate=()=>movement(f,'throw');
 CustomMatchService.prototype.playOpponentTurn.call(f.service,f.match);assert.deepEqual(f.errors,[]);assert.equal(f.match.conditions.get(7),ability===1186?'normal':'poison');assert.equal(f.match.waits.get(7),ability===1198?0:3);assert.equal(f.match.turn,'black');
});
for(const owner of [0,6])for(const ability of [1186,1198])test(`${owner}: entry ${ability} returns from its personal bench slot after Switch`,t=>{
 const f=fixture(t,owner,ability,ability===1186?1159:1332),m=f.match;m.positions.set(owner,f.rotate(27));m.positions.set(owner+2,28+owner+2);
 f.send({selective_side:f.side,value:{type:'declare_plate',plate_id:5023,value:{type:'swap_move',pokemons:[owner,owner+2]}}});
 assert.deepEqual(f.errors,[]);assert.equal(m.positions.get(owner),28+owner);assert.equal(m.conditions.get(owner+1),'poison');assert.equal(m.waits.get(owner+1),3);
 f.send({selective_side:f.enemy===0?'black':'white',value:{type:'mp_move',route:[28+f.enemy+1,f.enemy===0?27:0]}});assert.deepEqual(f.errors,[]);assert.equal(m.turn,f.side);
 f.send({selective_side:f.side,value:{type:'mp_move',route:[28+owner,f.rotate(21)]}});assert.deepEqual(f.errors,[]);
 assert.equal(m.positions.get(owner),f.rotate(21));assert.equal(m.conditions.get(owner+1),ability===1186?'normal':'poison');assert.equal(m.waits.get(owner+1),ability===1198?0:1);assert.equal(m.completedTurnLedger.completed_turns,3);
});
for(const owner of [0,6])for(const ability of [1186,1198])test(`${owner}: seeded entry ${ability} matches field-only recovery across 128 actual MP actions`,t=>{
 let seed=(0x71ab0000+owner+ability)>>>0;const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return Math.floor(seed/0x100000000*n);};
 for(let iteration=0;iteration<128;iteration++){
  const f=fixture(t,owner,ability,ability===1186?1159:1332),m=f.match,entry=f.rotate(27),available=Array.from({length:28},(_,p)=>p).filter(p=>p!==entry);
  for(let p=0;p<12;p++)if(p!==owner){
   // Gaseous Form excludes every other figure from surrounding while still
   // permitting an ordinary adjacent battle choice after this MP action.
   f.figure(p).pokepower=1122;f.figure(p).id=1192;
   m.positions.set(p,random(3)===0?28+p:available.splice(random(available.length),1)[0]);m.conditions.set(p,[...special,'normal'][random(9)]);m.waits.set(p,random(6));
  }
  const before={points:new Map(m.positions),conditions:new Map(m.conditions),waits:new Map(m.waits)};
  const adjacent=[...before.points].some(([p,point])=>Math.floor(p/6)!==Math.floor(owner/6)&&point>=0&&point<28&&battleContract.fieldEdges.some(([a,b])=>a===entry&&b===point||b===entry&&a===point));
  // Native Touch contract: surviving adjacent allied Sleep/Freeze/Melt opens
  // the same uncompleted MP phase as an adjacent battle. Aroma removes these.
  const touchTargets=[...before.points].filter(([p,point])=>ability!==1186&&p!==owner&&Math.floor(p/6)===Math.floor(owner/6)&&point>=0&&point<28&&['sleep','freeze','melt'].includes(before.conditions.get(p))&&battleContract.fieldEdges.some(([a,b])=>a===entry&&b===point||b===entry&&a===point)).sort((a,b)=>a[1]-b[1]).map(([p])=>p);
  const pending=adjacent||touchTargets.length>0;
  f.send(movement(f,'mp'));assert.deepEqual(f.errors,[],`seed ${iteration}`);
  assert.deepEqual(f.service.touchChoices(m,f.side).map(a=>a.value.to_pokemon),touchTargets,'native-backed recovery leaves exact Touch targets');
  for(let p=0;p<12;p++){
   const selected=p!==owner&&Math.floor(p/6)===Math.floor(owner/6)&&before.points.get(p)>=0&&before.points.get(p)<28;
   assert.equal(m.conditions.get(p),selected&&ability===1186?'normal':before.conditions.get(p));
   assert.equal(m.waits.get(p),selected&&ability===1198?0:Math.max(0,before.waits.get(p)-(pending?0:1)));
   assert.equal(m.positions.get(p),p===owner?entry:before.points.get(p));
  }
  assert.equal(m.completedTurnLedger.completed_turns,pending?0:1);assert.equal(new Set(m.positions.values()).size,12);
 }
});
