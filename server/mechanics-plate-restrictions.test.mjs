import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CustomMatchService,customMatchTestHooks as engine,customMatchContract} from './custom-match-engine.mjs';
import {plateRestrictionSources,plateTargetIndexes} from './plate-restrictions.mjs';
const edges=customMatchContract.fieldEdges,ids=[5002,5015,5022,5426,5023,5026,5306];
function fixture(owner,id,power=1425) {
  const service=new CustomMatchService({port:0,clockSource:()=>0}),match=service.createMatch('plate-restriction');
  const enemy=owner===0?6:0,side=owner===0?'black':'white',target=owner===0?15:11;
  match.phase='started';match.turn=side;
  for(const player of match.record.players)for(const figure of player.pokemons)figure.pokepower=-1;
  match.record.players[owner/6].plates=[id,id];match.plateState=null;
  match.positions.set(owner,target);match.positions.set(enemy,owner===0?11:15);
  match.conditions.set(owner,'sleep');match.waits.set(owner,2);
  const holder=power===1372?owner:enemy;
  match.record.players.flatMap(p=>p.pokemons).find(p=>p.pokemon_index===holder).pokepower=power;
  const nested=id===5002?{type:'put_circle',condition:'normal',pokemons:[owner]}
    :id===5023?{type:'swap_move',pokemons:[owner,owner+1]}
    :id===5026?{type:'spot_move',from:29+owner,to:owner===0?16:1}
    :id===5306?{type:'spot_move',from:target,to:owner===0?24:3}
    :{type:id===5426?'select_pokemon_and_declare_aura':'select_pokemon',pokemon:owner};
  const action={selective_side:side,value:{type:'declare_plate',plate_id:id,value:nested}};
  return {service,match,owner,enemy,side,action,nested,holder};
}
const state=match=>JSON.stringify({record:match.record,turn:match.turn,positions:[...match.positions],conditions:[...match.conditions],waits:[...match.waits],battled:[...match.battledAfterField],plates:engine.plateStateSnapshot(match),pending:match.pendingPlate});
test('plate restrictions are pinned to the original two ability clauses',()=>{
  const text=JSON.parse(readFileSync(new URL('../docs/generated/battle-route-20260906/candidate-boot-cache-audit.json',import.meta.url))).resources.localization_phase_1;
  assert(text.some(row=>row.text_key==='FigureMaster.PokepowerDescription.1425'&&row.text.startsWith('Plates cannot be used on opposing Pokémon next to this Pokémon.')));
  assert(text.some(row=>row.text_key==='FigureMaster.PokepowerDescription.1372'&&row.text.includes('This Pokémon cannot be moved by plates, Abilities, or other Pokémon’s Attacks.')));
});
for(const owner of [0,6])for(const id of ids)for(const power of [1425,1372])test(`${owner}: plate ${id} targeting under ability ${power}`,()=>{
  const f=fixture(owner,id,power),{match,nested,side,action}=f;
  try {
    const blocked=power===1425?id!==5026:[5023,5306].includes(id);
    const before=state(match);
    assert.equal(engine.validatePlateMove(match,side,action),!blocked);
    assert.equal(plateRestrictionSources(match.record,match.positions,nested,edges).length,blocked?1:0);
    if(blocked) {
      f.service.acceptPlayerMove(match,action,side);
      assert.equal(state(match),before,'rejected actions cannot move, heal, consume, age Wait or change the turn');
      f.service.acceptPlayerMove(match,action,side);
      assert.equal(state(match),before,'repeated rejection remains effect-free');
    }
  }finally{match.phase='finished';}
});
for(const owner of [0,6])test(`${owner}: Wily Jaws scope is current adjacent enemies, with both swap participants checked`,()=>{
  const f=fixture(owner,5023),{match,side,action,enemy,nested}=f;
  try {
    nested.pokemons.reverse();assert.equal(engine.validatePlateMove(match,side,action),false,'second participant is protected');
    const figure=match.record.players.flatMap(p=>p.pokemons).find(p=>p.pokemon_index===enemy);
    figure.pokepower=1426;assert.equal(engine.validatePlateMove(match,side,action),true,'Fang Trap has no plate clause');
    figure.pokepower=1425;
    for(const point of [0,28+enemy,40,41,42,43,-1]) {
      match.positions.set(enemy,point);assert.equal(engine.validatePlateMove(match,side,action),true,'nonadjacent or off-field source '+point);
    }
    match.positions.set(enemy,owner===0?11:15);
    figure.pokepower=-1;
    match.positions.set(owner+1,owner===0?11:15);match.positions.set(enemy,28+enemy);
    match.record.players.flatMap(p=>p.pokemons).find(p=>p.pokemon_index===owner+1).pokepower=1425;
    assert.equal(engine.validatePlateMove(match,side,action),true,'allied holder does not prohibit plates');
  }finally{match.phase='finished';}
});
test('all field points use the board adjacency and source/target identities',()=>{
  for(const owner of [0,6])for(let point=0;point<28;point++)for(let source=0;source<28;source++) {
    if(point===source)continue;
    const enemy=owner===0?6:0,record={players:[{pokemons:[{pokemon_index:enemy,pokepower:1425}]}]},positions=new Map([[owner,point],[enemy,source]]);
    const expected=edges.some(([a,b])=>(a===point&&b===source)||(b===point&&a===source));
    assert.equal(plateRestrictionSources(record,positions,{type:'select_pokemon',pokemon:owner},edges).length,Number(expected),`${owner}/${point}/${source}`);
  }
});
for(const owner of [0,6])test(`${owner}: string-valued legacy target fields cannot bypass prevention`,()=>{
  for(const id of [5015,5022,5426,5306]) {
    const {match,side,action,nested}=fixture(owner,id);
    try {if('pokemon' in nested)nested.pokemon=String(nested.pokemon);else nested.from=String(nested.from);
      assert.equal(engine.validatePlateMove(match,side,action),false);
    }finally{match.phase='finished';}
  }
});
test('spot destinations do not retarget a plate; duplicate targets do not duplicate prevention sources',()=>{
  const f=fixture(0,5306),{match,nested}=f;
  try {
    match.positions.set(0,21);nested.from=21;nested.to=15;
    assert.deepEqual(plateTargetIndexes(match.positions,nested),[0]);
    assert.deepEqual(plateRestrictionSources(match.record,match.positions,nested,edges),[]);
    match.positions.set(0,15);
    assert.equal(plateRestrictionSources(match.record,match.positions,{type:'swap_move',pokemons:[0,0]},edges).length,1);
  }finally{match.phase='finished';}
});
for(const owner of [0,6])test(`${owner}: source departure permits the same plate and consumes one copy`,()=>{
  const {service,match,side,action,enemy}=fixture(owner,5002);
  try {
    service.acceptPlayerMove(match,action,side);assert.equal(match.record.all_moves.length,0);
    match.positions.set(enemy,28+enemy);
    service.acceptPlayerMove(match,action,side);
    assert.equal(match.conditions.get(owner),'normal');assert.equal(match.waits.get(owner),2);assert.equal(match.turn,side);
    const copies=engine.plateStateSnapshot(match).plate_conditions.find(row=>row.color===side).plates;
    assert.equal(copies.filter(row=>row.condition==='used').length,1);assert.equal(copies.filter(row=>row.condition==='unused').length,1);
    const before=state(match);service.acceptPlayerMove(match,action,side);assert.equal(state(match),before);
  }finally{match.phase='finished';}
});
