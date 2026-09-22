import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {CustomMatchService,customMatchTestHooks as rules} from './custom-match-engine.mjs';

// Original PokepowerDescription1326 explicitly limits this trigger to the
// first battle after field entry. The retained native matrix establishes
// paralysis/Wait3 and defeated-owner ordering for that first battle.
for(let owner=0;owner<12;owner++) test(`Blackout1326 follows figure ${owner}, first battle, cure, and field re-entry`,()=>{
  const service=new CustomMatchService({port:0}),match=service.createMatch('isolated-blackout');
  const enemy=owner<6?6:0,side=owner<6?'black':'white';
  for(const figure of match.record.players.flatMap(p=>p.pokemons)) {
    figure.pokepower=figure.pokemon_index===owner?1326:-1;
    figure.skills=[{id:1122,color:4,range:96,speed_or_damage:0}];
  }
  match.positions.set(owner,15);match.positions.set(enemy,11);
  const battle=()=>service.applyBaseBattleOutcome(match,owner,enemy,0,0);
  battle();assert.equal(match.conditions.get(enemy),'paralyze');assert.equal(match.waits.get(enemy),3);
  assert.equal(match.battledAfterField.get(owner),true);
  // A Full Heal does not count as leaving and re-entering the field.
  rules.applyPositionMove(match,{selective_side:enemy<6?'black':'white',value:{type:'declare_plate',plate_id:5002,
    value:{type:'put_circle',condition:'normal',pokemons:[enemy]}}});
  match.waits.set(enemy,0);
  battle();assert.equal(match.conditions.get(enemy),'normal');assert.equal(match.waits.get(enemy),0);
  rules.applyPositionMove(match,{selective_side:side,value:{type:'spot_move',from:15,to:16}});
  battle();assert.equal(match.conditions.get(enemy),'normal','on-field relocation cannot rearm first battle');
  rules.applyPositionMove(match,{selective_side:side,value:{type:'spot_move',from:16,to:28+owner}});
  assert.equal(match.battledAfterField.get(owner),false);
  rules.applyPositionMove(match,{selective_side:side,value:{type:'spot_move',from:28+owner,to:15}});
  battle();assert.equal(match.conditions.get(enemy),'paralyze');assert.equal(match.waits.get(enemy),3);
});

const primary=JSON.parse(fs.readFileSync(new URL('../docs/generated/mechanics-20260913/native-multispin.json',import.meta.url))).cases.find(c=>c.name.endsWith('purple-primary-1009'));
for(const owner of [0,6]) for(const ending of ['survive','damage_ko','secondary_ko']) test(`Blackout${owner}/${ending}: two battles through actual accepted actions do not reapply first-battle Wait`,async()=>{
  const units=new Map([[0,[0,60,0]],[6,[0,60,0]]]);
  const service=new CustomMatchService({port:0,moveDelayMs:0,opponentTurnDelayMs:0,clockSource:()=>0,spinUnitSource:(_,pokemon)=>units.get(pokemon).shift()});
  service.playOpponentTurn=()=>{}; // Test controls both players, including their decisions.
  const match=service.createMatch('isolated-blackout-actions'),rejections=[];
  match.record=structuredClone(primary.record);match.record.all_moves=[];match.plateState=null;match.phase='started';
  match.socket={destroyed:false,write:()=>{}};
  service.rejectPlayerMove=(_,reason)=>rejections.push(reason);
  for(const figure of match.record.players.flatMap(p=>p.pokemons)) {
    figure.pokepower=figure.pokemon_index===owner?1326:-1;
    if([0,6].includes(figure.pokemon_index)) {
      // Paralysis disables the smaller Blue Attack. Keep the KO controls'
      // later White selection available so they isolate Blackout retaliation.
      figure.skills=[{id:1122,color:4,range:ending==='survive'?96:4,speed_or_damage:0}];
      if(ending!=='survive') figure.skills.push(figure.pokemon_index===owner?{id:1131,color:0,range:92,speed_or_damage:0}
        :{id:ending==='secondary_ko'?1001:1199,color:1,range:92,speed_or_damage:50});
    }
  }
  const accept=action=>{service.acceptPlayerMove(match,structuredClone(action),action.selective_side);assert.deepEqual(rejections,[]);};
  const settled=async count=>{
    for(let i=0;i<120;i++) {
      if(match.record.all_moves.filter(m=>m.value.type==='spin').length===count&&!match.battleResolutionPending)return;
      await delay(5);
    }
    assert.fail('actual battle did not settle');
  };
  try {
    for(const action of primary.record.all_moves.slice(0,-1))accept(action);
    await settled(1);
    const enemy=owner===0?6:0;
    assert.equal(match.conditions.get(enemy),'paralyze');assert.equal(match.waits.get(enemy),2);
    // Keep the unrelated white figure outside Ice Shard's two-step radius.
    for(const [side,route] of [['black',[29,27]],['white',[35,ending==='secondary_ko'?0:6]]])accept({selective_side:side,value:{type:'mp_move',route}});
    assert.equal(match.waits.get(enemy),0);
    accept({selective_side:'black',value:{type:'declare_battle',from_pokemon:0,to_pokemon:6}});
    await settled(ending==='secondary_ko'?3:2);
    assert.equal(match.waits.get(enemy),0,'later battle must not restart Blackout Wait3');
    assert.equal(match.battledAfterField.get(owner),ending==='survive');assert.equal(match.turn,'white');
    assert.equal(match.positions.get(owner)<28,ending==='survive');
    if(ending!=='survive') assert.equal(match.positions.get(owner),owner===0?41:43);
  } finally {match.phase='finished';}
});
