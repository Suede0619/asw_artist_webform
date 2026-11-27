import test from 'node:test';
import assert from 'node:assert/strict';
import { itineraryRequest, planItinerary } from '../server/itinerary.mjs';

const now=new Date('2026-11-25T15:00:00Z');
const request = fields => itineraryRequest.parse({
  date:'2026-11-27',startTime:'10:00',hours:'6',interest:'art',transport:'walk',...fields,
});

test('published hours, seasonal schedules and a starting landmark constrain every Taos route',async()=>{
  const result=await planItinerary(request({ start:'fechin' }),{}, {now});
  assert.equal(result.stops.length,3);
  assert.match(result.map,/origin=Taos\+Art\+Museum/);
  assert.match(result.map,/travelmode=walking/);
  for(const stop of result.stops){
    assert.ok(stop.time>='11:00' && stop.endTime<='16:00');
    if(stop.id==='fechin') assert.ok(stop.time>='12:00');
    assert.ok(stop.availability);
  }
  const monday=await planItinerary(request({date:'2026-11-30'}),{}, {now});
  assert.ok(monday.stops.every(stop=>!['harwood','fechin','couse-sharp'].includes(stop.id)));
  const holiday=await planItinerary(request({date:'2026-11-26'}),{}, {now});
  assert.deepEqual(holiday.stops.map(stop=>stop.id),['historic-plaza']);
  await assert.rejects(planItinerary(request({date:'2026-11-25',startTime:'08:00'}),{},
    {now:new Date('2026-11-25T17:00:00Z')}),{status:422});
});

test('a swap retains the other stops and the model can only choose an application-generated route',async()=>{
  const input=request({interest:'mixed'});
  const baseline=await planItinerary(input,{}, {now});
  const old=baseline.stops[0].id;
  const retain=baseline.stops.slice(1).map(stop=>stop.id);
  const edited=request({interest:'mixed',avoid:[old],retain});
  const result=await planItinerary(edited,{itineraryKey:'fixture', itineraryModel:'fixture'},{
    now,fetcher:async()=>Response.json({output:[{content:[{type:'output_text',text:'{"route":"0"}'}]}]}),
  });
  assert.equal(result.mode,'ai');
  assert.ok(result.stops.every(stop=>stop.id!==old));
  assert.ok(retain.every(id=>result.stops.some(stop=>stop.id===id)));
  const fallback=await planItinerary(input,{itineraryKey:'fixture', itineraryModel:'fixture'},{
    now,fetcher:async()=>Response.json({output:[{content:[{type:'output_text',text:'{"route":"invalid"}'}]}]}),
  });
  assert.equal(fallback.mode,'suggested');
  assert.deepEqual(fallback.stops,baseline.stops);
});
