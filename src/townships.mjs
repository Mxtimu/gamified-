// Soweto townships (kasis) and the parts inside them (extensions, zones,
// phases). Drop Pin shows the townships first; tapping one lists its parts so a
// reporter can say exactly which part of the township they mean.
//
// lat/lng are APPROXIMATE centre points. They are only used to zoom the map to
// a township and to guess the township from a dropped pin. The pin itself is
// what pinpoints the incident. Correct any centre here and restart the server:
// existing rows are updated by name on start-up.
//
// Adding a township or a part: add it below and restart. Nothing is deleted
// automatically, so renaming one leaves the old name in the database.

const range = (prefix, from, to) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix} ${from + i}`);

export const TOWNSHIPS = [
  // ── Orlando Crew (north-east) ──────────────────────────────────────────
  { name: 'Orlando West', crew: 'Orlando Crew', lat: -26.2385, lng: 27.9056, landmark: 'Vilakazi Street',
    sections: ['Orlando West', 'Orlando West Ext', 'Vilakazi Precinct'] },
  { name: 'Orlando East', crew: 'Orlando Crew', lat: -26.2489, lng: 27.9270, landmark: 'Orlando Stadium',
    sections: ['Orlando East', 'Orlando Ekhaya', 'Orlando East Hostel'] },
  { name: 'Dube', crew: 'Orlando Crew', lat: -26.2370, lng: 27.8930, landmark: 'Dube Station',
    sections: ['Dube', 'Dube Hostel', 'Dube Village'] },
  { name: 'Mzimhlophe', crew: 'Orlando Crew', lat: -26.2290, lng: 27.9000, landmark: 'Mzimhlophe Station',
    sections: ['Mzimhlophe', 'Mzimhlophe Hostel'] },
  { name: 'Elias Motsoaledi', crew: 'Orlando Crew', lat: -26.2250, lng: 27.9110, landmark: 'Elias Motsoaledi centre',
    sections: ['Elias Motsoaledi'] },
  { name: 'Noordgesig', crew: 'Orlando Crew', lat: -26.2410, lng: 27.9380, landmark: 'Noordgesig centre',
    sections: ['Noordgesig', 'Noordgesig Ext'] },
  { name: 'Pennyville', crew: 'Orlando Crew', lat: -26.2350, lng: 27.9440, landmark: 'Pennyville flats',
    sections: ['Pennyville'] },

  // ── Diepkloof Crew (east) ──────────────────────────────────────────────
  { name: 'Diepkloof', crew: 'Diepkloof Crew', lat: -26.2500, lng: 27.9500, landmark: 'Diepkloof Hostel',
    sections: [...range('Zone', 1, 6), 'Diepkloof Extension', 'Diepkloof Hostel'] },

  // ── Meadowlands Crew (north) ───────────────────────────────────────────
  { name: 'Meadowlands', crew: 'Meadowlands Crew', lat: -26.2170, lng: 27.8780, landmark: 'Meadowlands Zone 9',
    sections: [...range('Zone', 1, 12), 'Meadowlands Hostel'] },

  // ── Central Crew ───────────────────────────────────────────────────────
  { name: 'Jabulani', crew: 'Central Crew', lat: -26.2564, lng: 27.8640, landmark: 'Jabulani Mall',
    sections: ['Jabulani', 'Jabulani Flats', 'Jabulani Hostel'] },
  { name: 'Klipspruit', crew: 'Central Crew', lat: -26.2647, lng: 27.8878, landmark: 'Maponya Mall',
    sections: ['Klipspruit', 'Klipspruit Ext', 'Klipspruit West'] },
  { name: 'Mofolo', crew: 'Central Crew', lat: -26.2420, lng: 27.8800, landmark: 'Mofolo Park',
    sections: ['Central Mofolo', 'Mofolo North', 'Mofolo South', 'Mofolo Village'] },
  { name: 'Moroka', crew: 'Central Crew', lat: -26.2560, lng: 27.8770, landmark: 'Thokoza Park',
    sections: ['Moroka', 'Moroka North'] },
  { name: 'Jabavu', crew: 'Central Crew', lat: -26.2490, lng: 27.8710, landmark: 'Jabavu Stadium',
    sections: ['Central Western Jabavu', 'White City Jabavu', 'Jabavu'] },
  { name: 'Zondi', crew: 'Central Crew', lat: -26.2450, lng: 27.8620, landmark: 'Zondi centre',
    sections: ['Zondi 1', 'Zondi 2'] },
  { name: 'Molapo', crew: 'Central Crew', lat: -26.2480, lng: 27.8570, landmark: 'Molapo centre',
    sections: ['Molapo'] },
  { name: 'Moletsane', crew: 'Central Crew', lat: -26.2430, lng: 27.8500, landmark: 'Moletsane centre',
    sections: ['Moletsane'] },
  { name: 'Tladi', crew: 'Central Crew', lat: -26.2520, lng: 27.8490, landmark: 'Tladi centre',
    sections: ['Tladi'] },
  { name: 'Phiri', crew: 'Central Crew', lat: -26.2610, lng: 27.8560, landmark: 'Phiri centre',
    sections: ['Phiri'] },
  { name: 'Mapetla', crew: 'Central Crew', lat: -26.2660, lng: 27.8520, landmark: 'Mapetla centre',
    sections: ['Mapetla', 'Mapetla Ext'] },
  { name: 'Senaoane', crew: 'Central Crew', lat: -26.2690, lng: 27.8620, landmark: 'Senaoane centre',
    sections: ['Senaoane'] },
  { name: 'Dlamini', crew: 'Central Crew', lat: -26.2640, lng: 27.8720, landmark: 'Dlamini centre',
    sections: ['Dlamini 1', 'Dlamini 2'] },
  { name: 'Chiawelo', crew: 'Central Crew', lat: -26.2770, lng: 27.8650, landmark: 'Chiawelo centre',
    sections: ['Chiawelo', ...range('Chiawelo Ext', 1, 5)] },
  { name: 'Power Park', crew: 'Central Crew', lat: -26.2700, lng: 27.8790, landmark: 'Power Park centre',
    sections: ['Power Park'] },

  // ── Pimville Crew (south-east) ─────────────────────────────────────────
  { name: 'Pimville', crew: 'Pimville Crew', lat: -26.2760, lng: 27.8990, landmark: 'Pimville Zone 6',
    sections: range('Zone', 1, 7) },
  { name: 'Kliptown', crew: 'Pimville Crew', lat: -26.2770, lng: 27.8870, landmark: 'Walter Sisulu Square',
    sections: ['Kliptown', 'Kliptown Ext'] },
  { name: 'Nancefield', crew: 'Pimville Crew', lat: -26.2740, lng: 27.8830, landmark: 'Nancefield Station',
    sections: ['Nancefield', 'Nancefield Hostel'] },
  { name: 'Devland', crew: 'Pimville Crew', lat: -26.2790, lng: 27.9180, landmark: 'Devland centre',
    sections: ['Devland', 'Devland Ext'] },
  { name: 'Freedom Park', crew: 'Pimville Crew', lat: -26.2880, lng: 27.8820, landmark: 'Freedom Park centre',
    sections: ['Freedom Park'] },

  // ── Dobsonville Crew (north-west) ──────────────────────────────────────
  { name: 'Dobsonville', crew: 'Dobsonville Crew', lat: -26.2280, lng: 27.8390, landmark: 'Dobsonville Centre',
    sections: ['Dobsonville', ...range('Dobsonville Ext', 1, 5), 'Dobsonville Gardens'] },
  { name: 'Braamfischerville', crew: 'Dobsonville Crew', lat: -26.2080, lng: 27.8600, landmark: 'Braamfischerville centre',
    sections: [...range('Phase', 1, 4), 'Braamfischerville Ext'] },
  { name: 'Mmesi Park', crew: 'Dobsonville Crew', lat: -26.2290, lng: 27.8560, landmark: 'Mmesi Park centre',
    sections: ['Mmesi Park'] },
  { name: 'Doornkop', crew: 'Dobsonville Crew', lat: -26.2220, lng: 27.8200, landmark: 'Doornkop centre',
    sections: ['Doornkop', 'Doornkop Ext'] },
  { name: 'Tshepisong', crew: 'Dobsonville Crew', lat: -26.1990, lng: 27.8170, landmark: 'Tshepisong centre',
    sections: ['Tshepisong', 'Tshepisong West', 'Tshepisong Ext'] },

  // ── Deep West Crew (west) ──────────────────────────────────────────────
  { name: 'Zola', crew: 'Deep West Crew', lat: -26.2480, lng: 27.8420, landmark: 'Zola Taxi Rank',
    sections: ['Zola', 'Zola North', 'Zola South'] },
  { name: 'Naledi', crew: 'Deep West Crew', lat: -26.2610, lng: 27.8330, landmark: 'Naledi Hall',
    sections: ['Naledi', 'Naledi Ext 1', 'Naledi Ext 2'] },
  { name: 'Emdeni', crew: 'Deep West Crew', lat: -26.2400, lng: 27.8290, landmark: 'Emdeni Square',
    sections: ['Emdeni', 'Emdeni Ext 1', 'Emdeni Ext 2'] },
  { name: 'Thulani', crew: 'Deep West Crew', lat: -26.2400, lng: 27.8130, landmark: 'Thulani centre',
    sections: ['Thulani', 'Thulani Ext'] },
  { name: 'Snake Park', crew: 'Deep West Crew', lat: -26.2310, lng: 27.8020, landmark: 'Snake Park centre',
    sections: ['Snake Park'] },
  { name: 'Slovoville', crew: 'Deep West Crew', lat: -26.2560, lng: 27.8120, landmark: 'Slovoville centre',
    sections: ['Slovoville'] },
  { name: 'Lufhereng', crew: 'Deep West Crew', lat: -26.2470, lng: 27.7800, landmark: 'Lufhereng centre',
    sections: ['Lufhereng'] },

  // ── Protea Crew (south-west) ───────────────────────────────────────────
  { name: 'Protea Glen', crew: 'Protea Crew', lat: -26.2790, lng: 27.8090, landmark: 'Protea Glen Ext 12',
    sections: ['Protea Glen', ...range('Protea Glen Ext', 1, 31)] },
  { name: 'Protea North', crew: 'Protea Crew', lat: -26.2720, lng: 27.8400, landmark: 'Protea North centre',
    sections: ['Protea North', 'Protea North Ext 1'] },
  { name: 'Protea South', crew: 'Protea Crew', lat: -26.2870, lng: 27.8350, landmark: 'Protea South centre',
    sections: ['Protea South', 'Protea South Ext 1'] },
];
