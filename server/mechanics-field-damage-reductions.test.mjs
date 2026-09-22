import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {CustomMatchService,customMatchTestHooks as engine,customMatchContract} from './custom-match-engine.mjs';
import {fieldDamageReductionSources,applyFieldDamageReductions} from './field-damage-reductions.mjs';
const edges=customMatchContract.fieldEdges,abilities=[1102,1219,1248,1322,1401];
const special=['bad_poison','burn','freeze','melt','panic','paralyze','poison','sleep'];
const catalog=JSON.parse(readFileSync(new URL('../data/z_skill_catalog.json',import.meta.url))).figures;
const attack=(id,color,power,range=96)=>({id,color,speed_or_damage:power,range});
const amount=a=>a===1248?1:a===1401?20:10;
function fixture(owner,ability,color=1,power=100){
 const service=new CustomMatchService({port:0,clockSource:()=>0}),match=service.createMatch('field-damage-reduction-isolated'),enemy=owner===0?6:0,source=owner+1,figures=match.record.players.flatMap(p=>p.pokemons),figure=p=>figures.find(f=>f.pokemon_index===p);
 for(const f of figures){f.id=1005;f.mp=2;f.pokepower=-1;f.skills=[attack(1199,1,80)];}
 figure(source).id=({1248:1362,1322:1478,1401:1436})[ability]??1005;figure(source).pokepower=ability;
 figure(owner).id=ability===1322?1478:ability===1401?1106:1005;figure(enemy).id=1018;figure(enemy).skills=[attack(1199,color,power)];
 match.positions.set(owner,owner===0?15:11);match.positions.set(enemy,enemy===0?15:11);
 match.positions.set(source,[1102,1219].includes(ability)?owner===0?6:20:owner===0?21:0);
 return {service,match,owner,enemy,source,figure};
}
const sources=f=>fieldDamageReductionSources(f.match.record,f.match.positions,f.enemy,f.owner,{color:1},edges);
const selected=f=>{const skill=engine.selectedSkill(f.match,f.enemy,0);engine.applyConditionBattleDamage(f.match,f.enemy,f.owner,skill);return skill;};
test('five descriptions and three original field-reduction bindings remain exact; Gleam Eyes has no catalog binding',()=>{
 const figures=JSON.parse(readFileSync(new URL('../data/figure_master_map.json',import.meta.url))).figures;
 for(const [id,ability] of [[1362,1248],[1478,1322],[1436,1401]])assert.equal(figures[id].pokepower_id,ability);
 for(const ability of [1102,1219])assert(!Object.values(figures).some(f=>f.pokepower_id===ability));
 const doc=JSON.parse(readFileSync(new URL('../docs/generated/mechanics-20260913/field-damage-reduction-contract.json',import.meta.url))),texts=JSON.parse(readFileSync(new URL('../docs/generated/battle-route-20260906/candidate-boot-cache-audit.json',import.meta.url))).resources.localization_phase_1;
 for(const row of doc.descriptions)for(const proof of row.evidence)assert.equal(texts.find(t=>t.text_key===proof.key).text,proof.text);
 for(const [id,name] of [[5,'Normal'],[12,'Flying'],[15,'Ghost']])assert(texts.some(t=>t.text_key==='FigureMaster.TypeName.'+id&&t.text===name));
});
for(const ability of abilities)for(const owner of [0,6])for(const color of [0,1,2,3,4])test(`${owner}: field reduction ${ability} gates damage color ${color} and preserves authored wheels`,()=>{
 const f=fixture(owner,ability,color),before=structuredClone(f.figure(f.enemy).skills),skill=selected(f),reduction=[1,3].includes(color)?amount(ability):0;
 assert.equal(skill.speed_or_damage,100-reduction);assert.deepEqual(f.figure(f.enemy).skills,before);
 assert.equal(skill.field_damage_reductions?.length??0,reduction?1:0);
 if(reduction)assert.deepEqual(skill.field_damage_reductions[0],{source:f.source,pokepower:ability,addend:-reduction,...(ability===1401?{multiplicand:-20,multiplier:1,counted:[owner]}:{}),current:100,result:100-reduction});
});
for(const ability of abilities)for(const owner of [0,6])test(`${owner}: field reduction ${ability} rejects non-field battlers/holders, wrong teams and missing participants`,()=>{
 const f=fixture(owner,ability);assert.equal(sources(f).length,1);
 for(const p of [owner,f.enemy,f.source]){const saved=f.match.positions.get(p);for(const point of [-1,28+p,40,41,42,43]){f.match.positions.set(p,point);assert.deepEqual(sources(f),[]);}f.match.positions.set(p,saved);}
 for(const [a,b] of [[-1,owner],[12,owner],[0.5,owner],[NaN,owner],[f.enemy,-1],[f.enemy,12],[owner+2,owner]])assert.deepEqual(fieldDamageReductionSources(f.match.record,f.match.positions,a,b,{color:1},edges),[]);
 f.figure(f.source).pokepower=-1;f.figure(f.enemy+1).pokepower=ability;f.match.positions.set(f.enemy+1,20);assert.deepEqual(sources(f),[],'opposing holder does not protect receiving team');
 f.figure(f.source).pokepower=ability;for(const p of [owner,f.enemy]){const record=structuredClone(f.match.record);for(const player of record.players)player.pokemons=player.pokemons.filter(f=>f.pokemon_index!==p);assert.deepEqual(fieldDamageReductionSources(record,f.match.positions,f.enemy,owner,{color:1},edges),[]);}
});
for(const ability of [1102,1219])for(const owner of [0,6])test(`${owner}: Gleam Eyes ${ability} measures adjacency to incoming battler, not receiving ally`,()=>{
 const f=fixture(owner,ability),point=f.match.positions.get(f.enemy),neighbors=edges.flatMap(([a,b])=>a===point?[b]:b===point?[a]:[]);
 for(let p=0;p<28;p++){if(p===point||p===f.match.positions.get(owner))continue;f.match.positions.set(f.source,p);assert.equal(sources(f).length,neighbors.includes(p)?1:0,`point ${p}`);}
});
for(const ability of [1248,1322])for(const owner of [0,6])test(`${owner}: field-wide ${ability} works at every free field point and exits/re-enters with its source`,()=>{
 const f=fixture(owner,ability);for(let p=0;p<28;p++){if([f.match.positions.get(owner),f.match.positions.get(f.enemy)].includes(p))continue;f.match.positions.set(f.source,p);assert.equal(selected(f).speed_or_damage,100-amount(ability));}
 f.match.positions.set(f.source,28+f.source);assert.equal(selected(f).speed_or_damage,100);f.match.positions.set(f.source,0);assert.equal(selected(f).speed_or_damage,100-amount(ability));
});
for(const owner of [0,6])test(`${owner}: Cotton Bird Song checks every original canonical/alias recipient type once and ignores overrides`,()=>{
 const f=fixture(owner,1322);for(const [id,row] of Object.entries(catalog)){f.figure(owner).id=Number(id);f.figure(owner).type=5;assert.equal(sources(f).length,row.playable&&[row.type0,row.type1].some(t=>[5,12].includes(t))?1:0,id);}
 f.figure(owner).id=900000099;assert.deepEqual(sources(f),[]);f.figure(owner).id=1478;assert.equal(selected(f).speed_or_damage,90,'dual Normal/Flying only once');
});
for(const owner of [0,6])test(`${owner}: Gloomdweller checks every canonical/alias Ghost type and every board adjacency/count`,()=>{
 const f=fixture(owner,1401);for(const [id,row] of Object.entries(catalog)){f.figure(owner).id=Number(id);f.figure(owner).type=15;assert.equal(sources(f).length,row.playable&&[row.type0,row.type1].includes(15)?1:0,id);}
 f.figure(owner).id=900000099;assert.deepEqual(sources(f),[]);
 for(let target=0;target<28;target++){
  const adjacent=edges.flatMap(([a,b])=>a===target?[b]:b===target?[a]:[]),free=Array.from({length:28},(_,p)=>p).find(p=>p!==target&&!adjacent.includes(p));
  for(let count=0;count<=adjacent.length;count++){
   for(let p=owner;p<owner+6;p++){f.match.positions.set(p,28+p);f.figure(p).id=1005;f.figure(p).pokepower=-1;}
   f.match.positions.set(f.enemy,target);f.match.positions.set(owner,adjacent[0]);f.match.positions.set(f.source,free);f.figure(f.source).id=1436;f.figure(f.source).pokepower=1401;
   const members=[owner,owner+2,owner+3,owner+4];for(let i=0;i<adjacent.length;i++){f.match.positions.set(members[i],adjacent[i]);f.figure(members[i]).id=i<count?1106:1005;}
   const result=sources(f);assert.equal(result.length,count?1:0);if(count){assert.deepEqual(result[0].counted,members.slice(0,count));assert.equal(result[0].addend,-20*count);}assert.equal(selected(f).speed_or_damage,100-20*count);
  }
 }
});
for(const owner of [0,6])test(`${owner}: Gloomdweller counts its adjacent Ghost source, excludes enemy Ghosts, and does not stack`,()=>{
 const f=fixture(owner,1401);f.figure(owner).id=1005;f.match.positions.set(f.source,owner===0?6:20);assert.deepEqual(sources(f)[0].counted,[f.source]);
 f.figure(owner+2).id=1436;f.figure(owner+2).pokepower=1401;f.match.positions.set(owner+2,owner===0?21:0);assert.equal(sources(f).length,1);assert.equal(sources(f)[0].source,f.source);
 f.figure(owner).id=1106;assert.deepEqual(sources(f)[0].counted,[owner,f.source]);assert.equal(selected(f).speed_or_damage,60);
 f.match.record.players.reverse();for(const p of f.match.record.players)p.pokemons.reverse();assert.equal(sources(f)[0].source,f.source,'stable lowest source regardless record order');
 f.match.positions.set(f.source,28+f.source);assert.equal(sources(f)[0].source,owner+2);assert.deepEqual(sources(f)[0].counted,[owner]);
 f.figure(owner).id=1005;f.figure(f.enemy+1).id=1106;f.match.positions.set(f.enemy+1,owner===0?6:20);assert.deepEqual(sources(f),[],'enemy Ghost does not count');
});
for(const ability of abilities)for(const owner of [0,6])test(`${owner}: ${ability} has no printed healthy gate, keeps thresholds, and composes with prior damage terms`,()=>{
 const f=fixture(owner,ability);for(const condition of [...special,'normal','faint','curse']){f.match.conditions.set(f.source,condition);f.match.waits.set(f.source,7);assert.equal(selected(f).speed_or_damage,100-amount(ability));}
 for(const raw of [0,1,9,10,11,19,20,21,49,50,51,100]){const skill={color:1,speed_or_damage:raw};applyFieldDamageReductions(f.match.record,f.match.positions,f.enemy,owner,skill,edges);assert.equal(skill.speed_or_damage,Math.max(0,raw-amount(ability)));}
 f.figure(f.enemy+1).id=1542;f.figure(f.enemy+1).pokepower=1466;f.match.positions.set(f.enemy+1,owner===0?27:6);f.match.damageBonuses.set(f.enemy,30);f.match.conditions.set(f.enemy,'poison');
 for(const receiving of [1301,1377]){f.figure(owner).pokepower=receiving;f.match.conditions.set(owner,'poison');for(const id of [1168,1172,1201,1261,1273,1310,1361,1369,1596,1283,1301,1307,1492,1533,1676]){
  const repeat=[1168,1172,1201,1261,1273,1310,1361,1369,1596].includes(id);f.figure(f.enemy).skills=[attack(id,1,50,48),attack(1131,0,0,48)];
  const skill=engine.selectedSpinSkill(f.match,f.enemy,(repeat?[0,0,0,48]:[0,0]).map((num,i)=>({num,displace:0,type:i?'probability':'battle'})));engine.applyConditionBattleDamage(f.match,f.enemy,owner,skill);
  const raw=repeat?150:id===1301?70:100,current=raw+20+30-20-(receiving===1301?30:50);assert.equal(skill.speed_or_damage,Math.max(0,current-amount(ability)),`${receiving}/${id}`);assert.equal(skill.field_damage_reductions[0].current,current);assert.equal(skill.battle_damage_reduction.current,raw+30);
 }}
});
for(const ability of [1102,1219,1248,1322])for(const owner of [0,6])test(`${owner}: flat ${ability} copies add once each in ascending source order (derived)`,()=>{
 const f=fixture(owner,ability);f.figure(owner).pokepower=ability;const skill=selected(f);assert.deepEqual(skill.field_damage_reductions.map(r=>r.source),[owner,f.source]);assert.equal(skill.speed_or_damage,100-2*amount(ability));
});
for(const owner of [0,6])test(`${owner}: heterogeneous field sources retain individual arithmetic and non-stacking Ghost count`,()=>{
 const f=fixture(owner,1401);for(const [p,ability,point] of [[owner,1102,owner===0?15:11],[owner+2,1248,2],[owner+3,1322,3],[owner+4,1401,4]]){f.figure(p).pokepower=ability;f.match.positions.set(p,point);}
 f.figure(owner).id=1478;f.match.positions.set(f.source,owner===0?6:20);const skill=selected(f);assert.deepEqual(skill.field_damage_reductions.map(r=>[r.source,r.current,r.result]),[[owner,100,90],[owner+1,90,70],[owner+2,70,69],[owner+3,69,59]]);
});
for(const ability of abilities)for(const owner of [0,6])for(const defending of [false,true])test(`${owner}: ${ability} determines actual winner and P.C. cleanup when protected ally ${defending?'defends':'attacks'}`,()=>{
 for(const offset of [-1,0,1]){const f=fixture(owner,ability);f.figure(owner).skills=[attack(1199,1,100-amount(ability)+offset)];const actor=defending?f.enemy:owner,target=defending?owner:f.enemy,result=f.service.applyBaseBattleOutcome(f.match,actor,target,0,0),victim=offset<0?owner:f.enemy;
  assert.equal(result.winner,offset<0?f.enemy:offset>0?owner:-1);assert.equal((defending?result.attackerSkill:result.defenderSkill).speed_or_damage,100-amount(ability));assert.equal(f.match.positions.get(victim),offset===0?victim===0?15:11:victim<6?41:43);assert.equal(f.match.positions.get(f.source),[1102,1219].includes(ability)?owner===0?6:20:owner===0?21:0);
 }
});
for(const ability of abilities)test(`${ability}: 256 seeded actual battle comparisons with prior condition, field scope and zero floor`,()=>{
 let seed=(0x721e0000+ability)>>>0;const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return Math.floor(seed/0x100000000*n);};
 for(let i=0;i<256;i++){const owner=random(2)*6,raw=random(180),power=random(180),condition=['normal','burn','poison','bad_poison'][random(4)],active=!!random(2),f=fixture(owner,ability,1,raw);f.match.conditions.set(f.enemy,condition);if(!active)f.match.positions.set(f.source,28+f.source);f.figure(owner).skills=[attack(1199,1,power)];const penalty={burn:10,poison:20,bad_poison:40}[condition]??0,expected=Math.max(0,Math.max(0,raw-penalty)-(active?amount(ability):0)),result=f.service.applyBaseBattleOutcome(f.match,owner,f.enemy,0,0);assert.equal(result.defenderSkill.speed_or_damage,expected);assert.equal(result.attackerSkill.speed_or_damage,power);assert.equal(result.winner,power>expected?owner:power<expected?f.enemy:-1);}
});
