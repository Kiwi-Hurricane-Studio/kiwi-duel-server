import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {CustomMatchService,customMatchTestHooks as rules} from './custom-match-engine.mjs';

const special = ['bad_poison','burn','freeze','melt','panic','paralyze','poison','sleep'];
const text = JSON.parse(fs.readFileSync(new URL('../docs/generated/battle-route-20260906/candidate-boot-cache-audit.json',import.meta.url),'utf8')).resources.localization_phase_1;
test('Full Heal category is the eight original special conditions, excluding Wait and markers', () => {
  assert.deepEqual(text.filter(row => row.text_key.startsWith('ConditionMaster.ConditionDescription.')
    && row.text.startsWith('Special condition effect')).map(row=>row.text_key.split('.').at(-1)).sort(),special);
  const plate=JSON.parse(fs.readFileSync(new URL('../data/reference_match_plate_contract.json',import.meta.url),'utf8')).plate_masters.find(p=>p.item_master_id===5002);
  assert.equal(plate.description,'Choose one of your Pokémon on the field. Remove all special conditions from that Pokémon. (This excludes Wait.)');
});
function fixture(side, condition, point) {
  const service=new CustomMatchService({port:0,clockSource:()=>0}), match=service.createMatch('full-heal-'+side);
  const target=side==='black'?0:6;
  match.phase='started'; match.turn=side;
  match.record.players[side==='black'?0:1].plates=[5002,5002];
  // Bind equipment only before first action, as normal deck construction does.
  match.plateState=null;
  match.positions.set(target,point); match.conditions.set(target,condition); match.waits.set(target,2);
  const action={selective_side:side,value:{type:'declare_plate',plate_id:5002,value:{type:'put_circle',condition:'normal',pokemons:[target]}}};
  return {service,match,target,action};
}
for(const side of ['black','white']) {
  for(const condition of special) test(`${side}: Full Heal clears ${condition}, keeps Wait and turn, consumes exactly one copy`,()=>{
    const {service,match,target,action}=fixture(side,condition,side==='black'?21:6);
    try {
      assert.equal(rules.validatePlateMove(match,side,action),true);
      service.acceptPlayerMove(match,action,side);
      assert.equal(match.conditions.get(target),'normal');
      assert.equal(match.waits.get(target),2);
      assert.equal(match.turn,side);
      assert.equal(match.record.all_moves.length,1);
      const plates=rules.plateStateSnapshot(match).plate_conditions.find(p=>p.color===side).plates;
      assert.equal(plates.filter(p=>p.id===5002&&p.condition==='used').length,1);
      assert.equal(plates.filter(p=>p.id===5002&&p.condition==='unused').length,1);
      service.acceptPlayerMove(match,action,side);
      assert.equal(match.record.all_moves.length,1,'duplicate action is effect-free');
    } finally {match.phase='finished';}
  });
  for(const point of [-1,28,34,40,41,42,43,44]) test(`${side}: Full Heal rejects nonfield target ${point} without consumption`,()=>{
    const {service,match,action}=fixture(side,'sleep',point),before=JSON.stringify(match.record);
    try {service.acceptPlayerMove(match,action,side); assert.equal(JSON.stringify(match.record),before);}
    finally {match.phase='finished';}
  });
  test(`${side}: Full Heal rejects every original non-special condition marker`,()=>{
    const markers=text.filter(row=>row.text_key.startsWith('ConditionMaster.ConditionDescription.'))
      .map(row=>row.text_key.split('.').at(-1)).filter(id=>!special.includes(id));
    for(const condition of ['normal',...markers]) {
      const {match,action}=fixture(side,condition,side==='black'?21:6);
      assert.equal(rules.validatePlateMove(match,side,action),false,condition);
    }
  });
}
