import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {catalogText} from '../scripts/extract-z-skill-catalog.mjs';
import {deriveZChoices,deriveZPower,effectiveZSkill,resolveRecordFigure,zSkillCatalog,
  validateZSkillCatalog,createZSkillCatalog,Z_SKILL_CATALOG_IDENTITY} from './z-skill-catalog.mjs';

const hash=data=>createHash('sha256').update(data).digest('hex');
const read=url=>JSON.parse(readFileSync(url,'utf8'));
const root=new URL('../',import.meta.url);
const catalog=zSkillCatalog();
const capDirectory=new URL('docs/generated/z-gauge-rules-20260910/native-cap-exact-routes/',root);
function archive(directory) {
  const manifest=read(new URL('manifest.json',directory));
  assert.equal(manifest.complete,true);
  return {directory,manifest};
}
function verified(data,query) {
  const output={};
  for(const kind of ['request','response']) {
    const bytes=readFileSync(new URL(query[kind+'_file'],data.directory));
    assert.equal(hash(bytes),query[kind+'_sha256']);output[kind]=JSON.parse(bytes);
  }
  assert.equal(hash(JSON.stringify(output.request.record)),query.record_sha256);
  return output;
}
function contexts(data) {
  return data.manifest.queries.filter(q=>q.operation==='legal_moves').flatMap(q=>{
    const statusQuery=data.manifest.queries.find(s=>s.operation==='status'&&s.record_sha256===q.record_sha256);
    if(!statusQuery)return [];
    const {request,response}=verified(data,q),status=verified(data,statusQuery).response.status;
    if(!['black','white'].includes(status.turn))return [];
    return [{label:q.label,record:request.record,legal:response.legal_moves,status,options:{
      side:status.turn,gauges:Object.fromEntries(status.z_gauge_conditions.map(x=>[x.color,x.z_gauge])),
      positions:new Map(status.pokemon_conditions.map(x=>[x.pokemon_index,x.index])),
      waits:new Map(status.pokemon_conditions.map(x=>[x.pokemon_index,x.wait])),
      conditions:new Map(status.pokemon_conditions.map(x=>[x.pokemon_index,x.marker.circle])),
      phaseAllowed:status.selective_side===status.turn&&!status.pokemon_conditions.some(x=>x.marker.z_state),
      supportedSkillIds:[1717]}}];
  });
}
const cap=archive(capDirectory), capContexts=contexts(cap);
const baseline=capContexts.find(x=>x.label==='cap-white-miss-miss-after-black-approach');
assert.ok(baseline);
const fresh=()=>structuredClone(baseline);

test('catalog exact deterministic extraction, counts and SHA',()=>{
  const bytes=readFileSync(new URL('data/z_skill_catalog.json',root));
  assert.equal(catalogText(),bytes.toString('utf8'));
  assert.equal(hash(bytes),Z_SKILL_CATALOG_IDENTITY.sha256);
  assert.equal(bytes.length,Z_SKILL_CATALOG_IDENTITY.bytes);
  assert.deepEqual(catalog.counts,{figure_occurrences:1490,figures:583,rules:579,playable_figures:564,
    item_rule_aliases:11,repeated_rule_groups:4,type_mappings:18,special_rows:19,z_skills:30,skill_masters:585});
});
test('every master source hash, JSON pointer and typed ID joins to original data',()=>{
  const source=new Map(catalog.provenance.map(row=>{
    const bytes=readFileSync(new URL(row.path,root));assert.equal(hash(bytes),row.sha256);assert.equal(bytes.length,row.bytes);
    return [row.path,row.path.endsWith('.json')?JSON.parse(bytes):null];
  }));
  const at=row=>row.json_pointer.split('/').slice(1).reduce((value,key)=>value[key.replaceAll('~1','/').replaceAll('~0','~')],source.get(row.source));
  for(const figure of Object.values(catalog.figures)) {
    const raw=at(figure);assert.equal(raw.ItemMasterId,figure.item_master_id);assert.equal(raw.RulePokeId,figure.rule_poke_id);
    assert.equal(raw.Type0,figure.type0);assert.equal(raw.Type1,figure.type1);
    assert.deepEqual((raw.TypeZSkillMasters??[]).map(row=>row.ZSkill),figure.type_z_skill_ids);
  }
  for(const master of Object.values(catalog.skill_masters))assert.equal(at(master).SkillMasterId,master.SkillMasterId);
  for(const master of Object.values(catalog.z_skills)) {
    const raw=at(master);for(const key of ['SkillMasterId','SkillColor','FormatType','AttackEffectId'])assert.equal(raw[key],master[key]);
  }
  assert.equal(catalog.z_skills[1696],undefined,'Text-only Catastropika must not create master');
});
test('RulePokeId and verified legacy ItemMasterId aliases resolve without array-position assumptions',()=>{
  assert.equal(resolveRecordFigure(1399).rule_id,1004);
  assert.equal(resolveRecordFigure(1399).identity,'verified_legacy_item_master_alias');
  assert.equal(resolveRecordFigure(1004).rule_id,1004);
  assert.equal(resolveRecordFigure(1648).rule_id,1504);
  assert.equal(resolveRecordFigure(1150).rule_id,1150);
  for(const id of [0,-1,999999,'1150',NaN])assert.equal(resolveRecordFigure(id).ok,false);
});
test('copied catalog and effective master cannot mutate shared data',()=>{
  const copy=zSkillCatalog();copy.z_skills[1717].SkillColor=99;
  const effective=effectiveZSkill({dst_skill_id:1717,speed_or_damage:4});
  assert.equal(effective.id,1717);assert.equal(effective.range,96);assert.equal(effective.speed_or_damage,4);
  assert.equal(effective.skill_master.SkillColor,2);assert.equal(effective.skill_master.FormatType,0);
  assert.equal(effective.skill_master.AttackEffectId,58);
  effective.skill_master.SkillColor=9;assert.equal(effectiveZSkill({dst_skill_id:1717,speed_or_damage:4}).skill_master.SkillColor,2);
  for(const value of [{dst_skill_id:1692,speed_or_damage:4},{dst_skill_id:1717,speed_or_damage:5},null])assert.throws(()=>effectiveZSkill(value));
});
for(const [label,mutate]of [
  ['schema',x=>x.schema='wrong'],
  ['missing destination',x=>delete x.z_skills[1717]],
  ['wrong typed master',x=>x.skill_masters[1717].SkillColor='2'],
  ['conflicting linked destination',x=>x.z_skills[1717].SkillColor=1],
  ['bad special source join',x=>x.rules[1092].special_z_mappings[0].skill_id=999999],
  ['ambiguous item alias',x=>x.figures[1399].type0=14],
  ['wrong reverse alias',x=>x.rules[1004].item_master_ids.push(1150)],
  ['noncanonical index',x=>x.rules['01150']=x.rules[1150]],
])test('catalog rejects '+label,()=>{const value=zSkillCatalog();mutate(value);assert.throws(()=>validateZSkillCatalog(value));});

for(const fixture of capContexts.filter(f=>f.legal.some(a=>a.value.type==='z_skill')))
  test('exact native supported1717 choices: '+fixture.label,()=>{
    const before=JSON.stringify(fixture.record),actual=deriveZChoices(fixture.record,fixture.options);
    assert.deepEqual(actual.choices,fixture.legal.filter(a=>a.value.type==='z_skill'&&a.value.dst_skill_id===1717));
    assert.equal(JSON.stringify(fixture.record),before);
    assert.ok(actual.diagnostics.some(d=>d.code==='z_handler_not_supported'));
  });
test('all38 native accepted action instances have source destination/type identity joins',()=>{
  const unique=new Map();
  for(const q of cap.manifest.queries.filter(q=>q.operation==='legal_moves')) {
    const pair=verified(cap,q),actions=pair.response.legal_moves.filter(a=>a.value.type==='z_skill');
    if(actions.length&&!unique.has(q.record_sha256))unique.set(q.record_sha256,{record:pair.request.record,actions});
  }
  let count=0;
  for(const {record,actions}of unique.values())for(const action of actions) {
    const actor=record.players.flatMap(p=>p.pokemons).find(p=>p.pokemon_index===action.value.pokemon);
    const resolved=resolveRecordFigure(actor.id);assert.equal(resolved.ok,true);
    assert.ok(resolved.rule.type_rows.some(row=>row.z_skill_id===action.value.dst_skill_id));count++;
  }
  assert.equal(count,38);
});
test('actor/player reorder cannot change valid choices',()=>{
  const f=fresh(),expected=deriveZChoices(f.record,f.options).choices;
  f.record.players.reverse();for(const p of f.record.players)p.pokemons.reverse();
  assert.deepEqual(deriveZChoices(f.record,f.options).choices,expected);
});
test('snapshot objects and Maps preserve identical actor joins',()=>{
  const f=fresh();const expected=deriveZChoices(f.record,f.options).choices;
  for(const key of ['positions','waits','conditions'])f.options[key]=Object.fromEntries(f.options[key]);
  assert.deepEqual(deriveZChoices(f.record,f.options).choices,expected);
});
for(const [label,mutate]of [
  ['phase false',f=>f.options.phaseAllowed=false],['phase missing',f=>delete f.options.phaseAllowed],
  ['own99 other100',f=>{f.options.gauges.white=99;f.options.gauges.black=100;}],
  ['gauge malformed',f=>f.options.gauges.white='100'],['empty support',f=>f.options.supportedSkillIds=[]],
  ['unsupported cannot be enabled',f=>f.options.supportedSkillIds=[1692,1718,1721,999999]],
  ['duplicate actor index',f=>f.record.players[1].pokemons[1].pokemon_index=6],
  ['side ownership conflict',f=>f.record.players[1].pokemons[1].pokemon_index=1],
  ['null player',f=>f.record.players[1]=null],['null actor',f=>f.record.players[1].pokemons[0]=null],
])test('fails closed: '+label,()=>{const f=fresh();mutate(f);assert.deepEqual(deriveZChoices(f.record,f.options).choices,[]);});
for(const [label,mutate]of [
  ['wait',f=>f.options.waits.set(6,1)],['sleep',f=>f.options.conditions.set(6,'sleep')],
  ['paralyze unproved',f=>f.options.conditions.set(6,'paralyze')],['missing condition',f=>f.options.conditions.delete(6)],
  ['PC',f=>f.options.positions.set(6,41)],['other bench',f=>f.options.positions.set(6,35)],
  ['missing point',f=>f.options.positions.delete(6)],['MP0',f=>f.record.players[1].pokemons[0].mp=0],
  ['unknown figure',f=>f.record.players[1].pokemons[0].id=999999],
  ['wrong total',f=>f.record.players[1].pokemons[0].skills[0].range=95],
  ['zero range',f=>f.record.players[1].pokemons[0].skills.push({id:1131,range:0,speed_or_damage:0})],
  ['negative power',f=>f.record.players[1].pokemons[0].skills[0].speed_or_damage=-1],
  ['unknown skill',f=>f.record.players[1].pokemons[0].skills[0].id=999999],
  ['null skill',f=>f.record.players[1].pokemons[0].skills[0]=null],
])test('actor exclusion: '+label,()=>{const f=fresh();mutate(f);const choices=deriveZChoices(f.record,f.options).choices;
  assert.equal(choices.some(a=>a.value.pokemon===6),false);assert.ok(choices.some(a=>a.value.pokemon===9));});

for(const name of ['native-power-mp-controls','native-mixed-power']) {
  const data=archive(new URL('docs/generated/z-skill-lifecycle-20260910/'+name+'/',root));
  for(const fixture of contexts(data))test('bounded native MP/power: '+fixture.label,()=>{
    const actors=fixture.record.players.flatMap(p=>p.pokemons);
    const derived=deriveZChoices(fixture.record,fixture.options);
    assert.deepEqual(derived.choices,fixture.legal.filter(a=>a.value.type==='z_skill'&&a.value.dst_skill_id===1717));
    for(const action of fixture.legal.filter(a=>a.value.type==='z_skill')) {
      const actor=actors.find(p=>p.pokemon_index===action.value.pokemon);
      const power=deriveZPower(actor,action.value.dst_skill_id);
      if(power.ok)assert.equal(power.power,action.value.speed_or_damage);
    }
  });
}
test('trusted SkillMaster ignores forged extra color; unproved format fails closed',()=>{
  const actor=structuredClone(baseline.record.players[1].pokemons.find(p=>p.id===1025));
  for(const slot of actor.skills)slot.color=2;
  assert.equal(deriveZPower(actor,1692).power,180);
  actor.skills.find(s=>s.id===1293).speed_or_damage=123;
  assert.equal(deriveZPower(actor,1692).code,'z_positive_nondamage_format_unproven');
});
test('unknown or special power remains explicit; source special mapping retained',()=>{
  const resolved=resolveRecordFigure(1092);assert.deepEqual(resolved.rule.special_z_mappings,[{skill_id:1782,z_skill_id:1772}]);
  const pokemon={id:1092,skills:[{id:1782,range:96,speed_or_damage:100}]};
  assert.equal(deriveZPower(pokemon,1772).ok,false);
  assert.equal(deriveZPower(pokemon,1692).ok,false);
});

// Tectonic Rage is a second explicitly enrolled handler, not generic Z support.
// Archived source/receipts remain independent of fresh engine effect controls.
const tectonicFixture=()=>{const f=fresh();f.options.supportedSkillIds=[1715];return f;};
for(const fixture of capContexts.filter(f=>f.legal.some(a=>a.value.type==='z_skill')))
  test('1715 exact native type/power/actor choices: '+fixture.label,()=>{
    const before=JSON.stringify(fixture.record);
    const actual=deriveZChoices(fixture.record,{...fixture.options,supportedSkillIds:[1715]});
    assert.deepEqual(actual.choices,fixture.legal.filter(a=>a.value.type==='z_skill'&&a.value.dst_skill_id===1715));
    assert.equal(JSON.stringify(fixture.record),before);
    assert.ok(actual.choices.every(a=>a.value.speed_or_damage===4));
  });

test('1715 explicit combined enrollment preserves native sorted choices and default1717 compatibility',()=>{
  const f=fresh(),before=JSON.stringify(f.record);
  assert.deepEqual(deriveZChoices(f.record,{...f.options,supportedSkillIds:[1715,1717]}).choices,
    f.legal.filter(a=>a.value.type==='z_skill'&&[1715,1717].includes(a.value.dst_skill_id)));
  const {supportedSkillIds,...withoutEnrollment}=f.options;
  assert.deepEqual(deriveZChoices(f.record,withoutEnrollment).choices,
    f.legal.filter(a=>a.value.type==='z_skill'&&a.value.dst_skill_id===1717));
  assert.equal(JSON.stringify(f.record),before);
});

test('1715 immutable effective wheel uses its own source master, not1717 effect58',()=>{
  const before=JSON.stringify(catalog.z_skills[1715]);
  const result=effectiveZSkill({dst_skill_id:1715,speed_or_damage:4});
  assert.deepEqual({id:result.id,range:result.range,power:result.speed_or_damage}, {id:1715,range:96,power:4});
  assert.equal(result.skill_master.SkillColor,2);assert.equal(result.skill_master.FormatType,0);
  assert.equal(result.skill_master.AttackEffectId,56);assert.equal(result.skill_master.DefenseTypeId,0);
  assert.equal(result.skill_master.NextFieldId,0);assert.equal(result.skill_master.name,'Tectonic Rage');
  result.skill_master.AttackEffectId=58;
  assert.equal(JSON.stringify(zSkillCatalog().z_skills[1715]),before);
  for(const value of [0,3,5,'4',null,NaN])assert.throws(()=>effectiveZSkill({dst_skill_id:1715,speed_or_damage:value}));
});

test('1715 source mapping is Ground only and has no guessed special destination aliases',()=>{
  const ground=Object.values(catalog.rules).filter(r=>r.type_rows.some(t=>t.z_skill_id===1715));
  assert.equal(ground.length,38);
  assert.ok(ground.every(r=>r.type_rows.some(t=>t.type===11&&t.z_skill_id===1715)));
  assert.ok(ground.every(r=>r.special_z_mappings.length===0));
  assert.ok(!Object.values(catalog.rules).some(r=>r.special_z_mappings.some(t=>t.z_skill_id===1715)));
  const f=tectonicFixture();
  const actor=f.record.players.flatMap(p=>p.pokemons).find(p=>p.pokemon_index===6);
  actor.id=1025;actor.type0=11;actor.dst_skill_id=1715;
  assert.equal(deriveZChoices(f.record,f.options).choices.some(a=>a.value.pokemon===6),false);
  actor.id=1092;actor.skills=[{id:1782,range:96,speed_or_damage:100}];
  assert.equal(deriveZChoices(f.record,f.options).choices.some(a=>a.value.pokemon===6),false);
  assert.equal(deriveZPower(actor,1715).code,'z_special_or_unmapped_power_unproven');
});

test('1715 cannot enable any of the other28 destinations by passing a broad handler list',()=>{
  const f=fresh();
  const actual=deriveZChoices(f.record,{...f.options,supportedSkillIds:Object.keys(catalog.z_skills).map(Number)});
  assert.deepEqual(actual.choices,f.legal.filter(a=>a.value.type==='z_skill'&&[1715,1717].includes(a.value.dst_skill_id)));
  assert.ok(actual.diagnostics.some(d=>d.code==='z_handler_not_supported'&&d.dst_skill_id===1692));
});

for(const [label,mutate]of [
  ['Wait1',f=>f.options.waits.set(6,1)],['missing Wait',f=>f.options.waits.delete(6)],
  ['sleep',f=>f.options.conditions.set(6,'sleep')],['paralyze',f=>f.options.conditions.set(6,'paralyze')],
  ['poison',f=>f.options.conditions.set(6,'poison')],['missing condition',f=>f.options.conditions.delete(6)],
  ['P.C.',f=>f.options.positions.set(6,43)],['other bench',f=>f.options.positions.set(6,35)],
  ['removed',f=>f.options.positions.set(6,-1)],['MP0',f=>f.record.players[1].pokemons[0].mp=0],
  ['string MP',f=>f.record.players[1].pokemons[0].mp='2'],['missing MP',f=>delete f.record.players[1].pokemons[0].mp],
  ['unknown figure',f=>f.record.players[1].pokemons[0].id=999999],
  ['unknown skill',f=>f.record.players[1].pokemons[0].skills[0].id=999999],
])test('1715 actor fails closed: '+label,()=>{
  const f=tectonicFixture();mutate(f);
  const actual=deriveZChoices(f.record,f.options);
  assert.equal(actual.choices.some(a=>a.value.pokemon===6),false);
  assert.ok(actual.choices.some(a=>a.value.pokemon===9),'independent valid Ground actor remains available');
});

test('1715 exact own bench, global actor order and Map/object joins are unchanged',()=>{
  const f=tectonicFixture();f.options.positions.set(6,34);
  const expected=deriveZChoices(f.record,f.options).choices;
  assert.deepEqual(expected.map(a=>a.value.pokemon),[6,9]);
  f.record.players.reverse();for(const p of f.record.players)p.pokemons.reverse();
  for(const key of ['positions','waits','conditions'])f.options[key]=Object.fromEntries(f.options[key]);
  assert.deepEqual(deriveZChoices(f.record,f.options).choices,expected);
});
