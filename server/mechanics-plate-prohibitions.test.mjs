import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CustomMatchService,customMatchTestHooks as engine,customMatchContract} from './custom-match-engine.mjs';
import {plateRestrictionSources} from './plate-restrictions.mjs';
const edges=customMatchContract.fieldEdges,plateIds=[5002,5015,5022,5426,5023,5026,5306];
const special=['bad_poison','burn','freeze','melt','panic','paralyze','poison','sleep'];
const masters=JSON.parse(readFileSync(new URL('../data/figure_master_map.json',import.meta.url))).figures;
const catalog=JSON.parse(readFileSync(new URL('../data/z_skill_catalog.json',import.meta.url)));
function fixture(owner,id,power) {
  const service=new CustomMatchService({port:0,clockSource:()=>0}),match=service.createMatch('plate-prohibition');
  const enemy=owner===0?6:0,side=owner===0?'black':'white';match.phase='started';match.turn=side;
  const figures=match.record.players.flatMap(p=>p.pokemons);
  for(const figure of figures){figure.pokepower=-1;figure.id=1002;}
  const figure=p=>figures.find(f=>f.pokemon_index===p);
  match.record.players[owner/6].plates=[id,id];match.plateState=null;
  match.positions.set(owner,owner===0?21:6);match.conditions.set(owner,'sleep');
  match.positions.set(enemy,0);figure(enemy).pokepower=power;figure(enemy).id=power===1411?1410:1242;
  if(power===1038)for(const [p,point]of [[owner+1,1],[enemy+1,2]]){match.positions.set(p,point);figure(p).id=1242;}
  const nested=id===5002?{type:'put_circle',condition:'normal',pokemons:[owner]}
    :id===5023?{type:'swap_move',pokemons:[owner,owner+2]}
    :id===5026?{type:'spot_move',from:30+owner,to:owner===0?16:7}
    :id===5306?{type:'spot_move',from:match.positions.get(owner),to:owner===0?24:3}
    :{type:id===5426?'select_pokemon_and_declare_aura':'select_pokemon',pokemon:owner+2};
  const action={selective_side:side,value:{type:'declare_plate',plate_id:id,value:nested}};
  return {service,match,owner,enemy,side,figure,nested,action};
}
const snapshot=m=>JSON.stringify({record:m.record,turn:m.turn,points:[...m.positions],conditions:[...m.conditions],waits:[...m.waits],plates:engine.plateStateSnapshot(m),pending:m.pendingPlate});
test('Big Chorus has a single original species/rule binding; unlinked descriptions do not invent aliases',()=>{
  const politoed=Object.values(masters).filter(f=>f.poke_no===186);
  assert.deepEqual(politoed.map(f=>f.item_master_id),[1242]);assert.equal(politoed[0].pokepower_id,1038);
  assert.equal(masters[1410].pokepower_id,1411);
  const original=JSON.parse(readFileSync(new URL('../assets/authentic/android_data/boot_masters/arena_reward_box_masters.json',import.meta.url))).ItemMasters;
  assert.equal(original[1242].FigureMaster.PokeNo,186);assert.equal(original[1242].FigureMaster.RulePokeId,1242);
  assert.equal(original[1242].FigureMaster.PokepowerId,1038);assert.equal(original[1410].FigureMaster.PokepowerId,1411);
  assert.deepEqual(Object.values(masters).filter(f=>[1039,1040].includes(f.pokepower_id)),[]);
  assert.equal(politoed[0].pokepower_description,'If there are 3 or more Politoed on the field (including this Pokémon), the opposing player cannot use plates.');
  assert.equal(masters[1410].pokepower_description,'If this Pokémon is on the field and is not affected by a special condition, the opposing player cannot use plates. Your Dark-type Pokémon deal +20 damage.');
});
for(const owner of [0,6])for(const power of [1038,1411])for(const id of plateIds)test(`${owner}: ${power} rejects plate ${id} before any mutation, including bench targets`,()=>{
  const f=fixture(owner,id,power),{match,side,action}=f;
  try {
    assert.equal(engine.validatePlateMove(match,side,action),false);
    const before=snapshot(match);f.service.acceptPlayerMove(match,action,side);assert.equal(snapshot(match),before);
    f.service.acceptPlayerMove(match,action,side);assert.equal(snapshot(match),before);
    // Moving the source off field releases this player's plate choices.
    match.positions.set(f.enemy,28+f.enemy);assert.equal(engine.validatePlateMove(match,side,action),true);
  }finally{match.phase='finished';}
});
for(const owner of [0,6])for(const condition of special)test(`${owner}: Intimidating Aura is disabled by ${condition}, then restored after condition removal`,()=>{
  const f=fixture(owner,5022,1411),{match,side,action,enemy}=f;
  try {
    match.conditions.set(enemy,condition);assert.equal(engine.validatePlateMove(match,side,action),true);
    match.conditions.set(enemy,'normal');match.waits.set(enemy,3);assert.equal(engine.validatePlateMove(match,side,action),false,'Wait is not a special condition');
  }finally{match.phase='finished';}
});
for(const owner of [0,6])test(`${owner}: healthy aura sources are independent; allied and off-field holders do not prohibit the player`,()=>{
  const f=fixture(owner,5022,1411),{match,side,action,enemy,figure}=f;
  try {
    match.positions.set(enemy+1,7);figure(enemy+1).pokepower=1411;
    match.conditions.set(enemy,'sleep');assert.equal(engine.validatePlateMove(match,side,action),false);
    match.conditions.set(enemy+1,'poison');assert.equal(engine.validatePlateMove(match,side,action),true);
    for(const point of [28+enemy,40,41,42,43,-1]) {
      match.conditions.set(enemy,'normal');match.positions.set(enemy,point);assert.equal(engine.validatePlateMove(match,side,action),true);
    }
    figure(owner).pokepower=1411;match.conditions.set(owner,'normal');assert.equal(engine.validatePlateMove(match,side,action),true);
  }finally{match.phase='finished';}
});
for(const owner of [0,6])test(`${owner}: Big Chorus counts both teams at the threshold and stops if a counted figure leaves`,()=>{
  const f=fixture(owner,5022,1038),{match,side,action,enemy,figure}=f;
  try {
    const members=[owner+1,enemy+1,owner+2];
    for(let count=1;count<=4;count++) {
      for(const [index,pokemon]of members.entries()){figure(pokemon).id=1242;match.positions.set(pokemon,index<count-1?index+1:28+pokemon);}
      assert.equal(engine.validatePlateMove(match,side,action),count<3,`total ${count}`);
    }
    match.positions.set(enemy,28+enemy);assert.equal(engine.validatePlateMove(match,side,action),true,'three other Politoed cannot activate an off-field holder');
    match.positions.set(enemy,0);match.positions.set(owner+2,28+owner+2);
    for(const condition of special){match.conditions.set(enemy,condition);assert.equal(engine.validatePlateMove(match,side,action),false,'Big Chorus has no healthy-holder clause');}
    figure(enemy).pokepower=1039;assert.equal(engine.validatePlateMove(match,side,action),true);
    figure(enemy).pokepower=1040;assert.equal(engine.validatePlateMove(match,side,action),true);
  }finally{match.phase='finished';}
});
test('every catalog item alias is counted by original species binding, not display names or supplied types',()=>{
  const f=fixture(0,5022,1038),{match,side,action,figure}=f;
  try {
    for(const [id,row]of Object.entries(catalog.figures)) {
      figure(1).id=Number(id);figure(1).name='Politoed';figure(1).poke_no=186;
      assert.equal(engine.validatePlateMove(match,side,action),!(row.playable&&masters[id]?.poke_no===186),id);
    }
    for(const id of [-1,900000099]){figure(1).id=id;assert.equal(engine.validatePlateMove(match,side,action),true);}
  }finally{match.phase='finished';}
});
for(const owner of [0,6])for(const power of [1038,1411])test(`${owner}: source recovery allows one real plate use without replaying the rejected action (${power})`,()=>{
  const {service,match,side,action,enemy}=fixture(owner,5022,power);
  try {
    service.acceptPlayerMove(match,action,side);assert.equal(match.record.all_moves.length,0);
    match.positions.set(enemy,28+enemy);service.acceptPlayerMove(match,action,side);
    assert.equal(match.record.all_moves.filter(m=>m.value.type==='declare_plate').length,1);
    const copies=engine.plateStateSnapshot(match).plate_conditions.find(row=>row.color===side).plates;
    assert.equal(copies.filter(row=>row.condition==='active').length,1);assert.equal(copies.filter(row=>row.condition==='unused').length,1);
    service.acceptPlayerMove(match,{selective_side:side,value:{type:'declare_turn_end'}},side);
    assert.equal(match.turn,side==='black'?'white':'black');
    assert.equal(engine.plateStateSnapshot(match).plate_conditions.find(row=>row.color===side).plates.filter(row=>row.condition==='used').length,1);
  }finally{match.phase='finished';}
});
test('player-wide and target-specific restrictions coexist in a deterministic source list',()=>{
  const {match,side,enemy,figure}=fixture(0,5306,1411);
  try {
    figure(0).pokepower=1372;figure(enemy+1).pokepower=1425;match.positions.set(enemy+1,16);
    assert.deepEqual(plateRestrictionSources(match.record,match.positions,{type:'spot_move',from:21,to:24},edges,side,match.conditions).map(s=>s.scope),['healthy_field_opposing_player','field_self_movement','adjacent_opposing_target']);
  }finally{match.phase='finished';}
});
