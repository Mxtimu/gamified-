// Populates a believable night of activity across Soweto so the Hood
// Leaderboard has rivals in it. Run with the server up: `npm run seed`.
const B = process.env.BASE || 'http://localhost:7788';

const post = async (p, body) => {
  const r = await fetch(B + p, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${p} -> ${r.status} ${await r.text()}`);
  return r.json();
};

const AGENTS = [
  ['Ma2000',    6, 'Meadowlands Crew'],
  ['ShozaZ9',   9, 'Deep West Crew'],
  ['GridCat',   1, 'Orlando Crew'],
  ['Pimville4L', 7, 'Pimville Crew'],
  ['DobsoKid',  8, 'Dobsonville Crew'],
  ['MaponyaEye', 5, 'Central Crew'],
];

// lat, lng, category, severity, narrative, verified?
const DROPS = [
  [-26.2170, 27.8780, 'cable_theft', 5, 'Two guys with a grinder on the pole behind the shops, sparks flying', true],
  [-26.2175, 27.8792, 'open_chamber', 3, 'Chamber cover missing next to the spaza, kids playing around it', true],
  [-26.2480, 27.8420, 'substation_vandalism', 4, 'Mini-sub door hanging open at the taxi rank, cables exposed', true],
  [-26.2610, 27.8330, 'illegal_connection', 2, 'Izinyoka wires strung over the road from the pole', false],
  [-26.2385, 27.9056, 'cable_theft', 5, 'Fresh trench dug along the pavement, cable pulled out overnight', true],
  [-26.2489, 27.9270, 'streetlight_out', 1, 'Whole street of lights dead since Thursday', true],
  [-26.2760, 27.8990, 'substation_vandalism', 5, 'Transformer box smashed open, loud humming and burning smell', true],
  [-26.2765, 27.8975, 'cable_theft', 4, 'White bakkie loading cable drums at 2am near the field', true],
  [-26.2280, 27.8390, 'open_chamber', 3, 'Open chamber flooded with water outside the shopping centre', true],
  [-26.2647, 27.8878, 'illegal_connection', 3, 'Bundle of illegal connections feeding the informal settlement', false],
  [-26.2564, 27.8640, 'streetlight_out', 2, 'Lights out around the mall parking area, very dark', true],
  [-26.2500, 27.9500, 'cable_theft', 4, 'Cable cut clean at the hostel side, section is dark', true],
  [-26.2790, 27.8090, 'open_chamber', 2, 'Exposed cable at the corner, cover stolen', true],
  [-26.2400, 27.8290, 'substation_vandalism', 3, 'Mini-sub tagged and panel forced open at the square', false],
];

console.log('seeding agents…');
for (const [callsign, zone] of AGENTS) {
  await post('/api/agent', { callsign, home_zone_id: zone });
}

console.log('seeding drops…');
let i = 0;
for (const [lat, lng, category, severity, narrative, verified] of DROPS) {
  const [callsign] = AGENTS[i % AGENTS.length];
  const res = await post('/api/reports', { callsign, category, severity, narrative, lat, lng });
  if (verified) {
    await post('/api/verify', { ref: res.report.ref, authority: 'City Power Control' });
  }
  i++;
}

const lb = await (await fetch(B + '/api/leaderboard')).json();
console.log('\nHood Leaderboard:');
lb.crews.forEach((c, n) => console.log(
  `  ${n + 1}. ${c.crew.padEnd(18)} score ${String(c.score).padStart(3)}  ${c.verified}/${c.reports} verified  ${c.coins} MC`
));
console.log('\nseeded. open', B);
