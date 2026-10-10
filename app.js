"use strict";

/* =====================================================================
   SmartRoute – app.js
   Hackathon prototype. Front-end only. No frameworks, no backend.
   All stored data lives in localStorage on this device.

   SECTIONS
    1. Config and constants
    2. Utilities (escape, formatting, storage)
    3. Sample data: makeCity() and the seven cities
    4. Routing engine (graph, DFS, legs, fares, ranking)
    5. App state and account (demo sign-in, profile)
    6. Screen navigation and accessibility helpers
    7. Home screen
    8. Plan screen (form, validation, GPS)
    9. Results screen (route cards)
   10. Map and distance breakdown (Google Maps + schematic fallback)
   11. Account screen
   12. Event wiring and start-up
   ===================================================================== */


/* =====================================================================
   1. CONFIG AND CONSTANTS
   ===================================================================== */
const STORAGE_PREFIX = "smartroute:";

// Optional: paste a Google Maps JavaScript API key here, or enter it in the
// app under "Connect Google Maps on this page". Restrict the key by HTTP
// referrer in Google Cloud Console, because a key in front-end code is public.
const DEFAULT_MAPS_KEY = "";

const FARE = { busFlat: 12, metroBase: 10, metroPerStop: 4 };   // ₹ (sample fares)
const WALK_MIN_PER_KM = 12;
const WAIT_MIN = { bus: 6, metro: 4 };                          // minutes (estimated)
const ROAD_FACTOR = { bus: 1.3, metro: 1.15 };                  // straight line -> path length allowance
const MAX_HOPS = 7;
const DETOUR_FACTOR = 2.2;                                      // drop routes slower than 2.2x the fastest
const PRUNE_FACTOR = DETOUR_FACTOR * 1.5;                       // DFS prune slack (waits are added later)
const MAX_PATHS = 20000;                                        // safety cap for DFS
const GPS_NEAR_KM = 60;
const DEMO_EMAIL = "demo@smartroute.example";

// Rough bounding box of India, enough for a "are you in India?" check.
const INDIA_BOX = { minLat: 6.5, maxLat: 35.7, minLng: 68.1, maxLng: 97.4 };

const MODE_META = {
  walk:  { icon: "\u{1F6B6}", label: "Walk",  color: "#ea580c" },
  bus:   { icon: "\u{1F68C}", label: "Bus",   color: "#2563eb" },
  metro: { icon: "\u{1F687}", label: "Metro", color: "#0f9d8f" }
};
const CAT_LABEL = { cheapest: "Cheapest", fastest: "Fastest", comfortable: "Most comfortable" };
const CATEGORIES = ["cheapest", "fastest", "comfortable"];
const PREF_KEYS = ["lessWalking", "fewerTransfers", "stepFree", "childFriendly", "lateNight"];
const PREF_LABEL = {
  lessWalking: "Less walking",
  fewerTransfers: "Fewer transfers",
  stepFree: "Step-free access",
  childFriendly: "Child-friendly",
  lateNight: "Minimise late-night walking"
};
const CROWD_LABEL = { 1: "Low", 2: "Medium", 3: "High" };


/* =====================================================================
   2. UTILITIES
   ===================================================================== */
function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

// Escape every piece of user-provided (or data-provided) text before it goes into HTML.
function esc(value) {
  return String(value === null || value === undefined ? "" : value).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function uid(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function round1(n) { return Math.round(n * 10) / 10; }
function round2(n) { return Math.round(n * 100) / 100; }
function fmtKm(k) { return round1(k).toFixed(1) + " km"; }
function fmtRs(n) { return "\u20B9" + Math.round(n).toLocaleString("en-IN"); }
function fmtMin(m) {
  m = Math.round(m);
  if (m < 60) { return m + " min"; }
  var h = Math.floor(m / 60), r = m % 60;
  return h + " h" + (r ? " " + r + " min" : "");
}
function plural(n, one, many) { return n + " " + (n === 1 ? one : (many || one + "s")); }

function haversineKm(lat1, lng1, lat2, lng2) {
  var R = 6371, rad = Math.PI / 180;
  var dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(a));
}

// localStorage wrapper that never throws.
var store = {
  get: function (key, fallback) {
    try {
      var raw = localStorage.getItem(STORAGE_PREFIX + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  },
  set: function (key, value) {
    try { localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value)); return true; }
    catch (e) { return false; }
  },
  remove: function (key) {
    try { localStorage.removeItem(STORAGE_PREFIX + key); } catch (e) { /* ignore */ }
  }
};


/* =====================================================================
   3. SAMPLE DATA
   Stop names are real places with approximate real coordinates.
   Lines, timings, fares, weather and crowd levels are SAMPLE / ESTIMATED.
   ===================================================================== */
var ALL_STOPS = {};   // every stop in every city, keyed by its city-prefixed id
var CITIES = {};      // city id -> city object

/*
  makeCity(cfg) builds one city:
    stops: [key, name, lat, lng]
    walks: [stopKeyA, stopKeyB, km]
    lines: { key, name, mode: "bus" | "metro", stops: [keys], mins: [minutes between stops], noLift: [keys] }
  Ids are prefixed with the city id so they never clash across cities.
*/
function makeCity(cfg) {
  var cityId = cfg.id;
  var city = {
    id: cityId, name: cfg.name, center: cfg.center,
    stops: {}, stopIds: [], lines: {}, edges: [], graph: {},
    weather: cfg.weather, crowd: cfg.crowd
  };
  function stopId(key) { return cityId + "_" + key; }
  function need(key) {
    var id = stopId(key);
    if (!city.stops[id]) { throw new Error("makeCity(" + cityId + "): unknown stop '" + key + "'"); }
    return id;
  }
  function addBoth(a, b, mode, km, min, lineId) {
    city.edges.push({ from: a, to: b, mode: mode, km: km, min: min, lineId: lineId });
    city.edges.push({ from: b, to: a, mode: mode, km: km, min: min, lineId: lineId });
  }

  cfg.stops.forEach(function (s) {
    var id = stopId(s[0]);
    var stop = { id: id, name: s[1], lat: s[2], lng: s[3], cityId: cityId, noLift: false };
    city.stops[id] = stop;
    city.stopIds.push(id);
    ALL_STOPS[id] = stop;
  });

  cfg.walks.forEach(function (w) {
    addBoth(need(w[0]), need(w[1]), "walk", w[2], w[2] * WALK_MIN_PER_KM, null);
  });

  cfg.lines.forEach(function (line) {
    var lineId = cityId + "_" + line.key;
    if (line.mins.length !== line.stops.length - 1) {
      throw new Error("makeCity(" + cityId + "): line " + line.key + " needs " + (line.stops.length - 1) + " timings");
    }
    var ids = line.stops.map(need);
    city.lines[lineId] = { id: lineId, name: line.name, mode: line.mode, stopIds: ids };
    (line.noLift || []).forEach(function (k) {
      if (line.mode === "metro") { city.stops[need(k)].noLift = true; }   // metro stations without a lift
    });
    for (var i = 0; i < ids.length - 1; i++) {
      var a = ALL_STOPS[ids[i]], b = ALL_STOPS[ids[i + 1]];
      var km = Math.max(0.3, round2(haversineKm(a.lat, a.lng, b.lat, b.lng) * ROAD_FACTOR[line.mode]));
      addBoth(ids[i], ids[i + 1], line.mode, km, line.mins[i], lineId);
    }
  });

  city.stopIds.forEach(function (id) { city.graph[id] = []; });
  city.edges.forEach(function (e) { city.graph[e.from].push(e); });

  CITIES[cityId] = city;
  return city;
}

makeCity({
  id: "jaipur", name: "Jaipur", center: [26.9124, 75.7873],
  weather: { cond: "Sunny", tempC: 33, rain: false },
  crowd: { peak: { bus: 3, metro: 2 }, off: { bus: 2, metro: 1 } },
  stops: [
    ["junction", "Jaipur Junction Railway Station", 26.9196, 75.7879],
    ["sindhi", "Sindhi Camp Bus Stand", 26.9213, 75.7960],
    ["chandpole", "Chandpole", 26.9246, 75.8100],
    ["badi", "Badi Chaupar", 26.9239, 75.8245],
    ["hawa", "Hawa Mahal", 26.9239, 75.8267],
    ["palace", "City Palace Jaipur", 26.9255, 75.8236],
    ["ramniwas", "Ram Niwas Garden", 26.9116, 75.8190],
    ["amer", "Amer Fort", 26.9855, 75.8513]
  ],
  walks: [
    ["junction", "sindhi", 1.0], ["sindhi", "chandpole", 1.5], ["chandpole", "badi", 1.4],
    ["badi", "hawa", 0.3], ["hawa", "palace", 0.5], ["badi", "palace", 0.4], ["palace", "ramniwas", 1.7]
  ],
  lines: [
    { key: "metro1", name: "Jaipur Metro Pink Line", mode: "metro", stops: ["sindhi", "chandpole", "badi"], mins: [3, 3], noLift: ["chandpole"] },
    { key: "bus1", name: "Bus 1 City Circular", mode: "bus", stops: ["junction", "sindhi", "chandpole", "hawa", "amer"], mins: [6, 7, 10, 22] },
    { key: "bus2", name: "Bus 2 Garden Link", mode: "bus", stops: ["ramniwas", "palace", "badi", "sindhi"], mins: [12, 5, 12] },
    { key: "bus3", name: "Bus 3 Station Shuttle", mode: "bus", stops: ["junction", "ramniwas"], mins: [18] }
  ]
});

makeCity({
  id: "delhi", name: "Delhi", center: [28.6139, 77.2090],
  weather: { cond: "Hazy", tempC: 31, rain: false },
  crowd: { peak: { bus: 3, metro: 3 }, off: { bus: 2, metro: 2 } },
  stops: [
    ["cp", "Connaught Place", 28.6315, 77.2167],
    ["ndls", "New Delhi Railway Station", 28.6428, 77.2194],
    ["chandni", "Chandni Chowk", 28.6506, 77.2303],
    ["redfort", "Red Fort", 28.6562, 77.2410],
    ["indiagate", "India Gate", 28.6129, 77.2295],
    ["lotus", "Lotus Temple", 28.5535, 77.2588],
    ["qutub", "Qutub Minar", 28.5245, 77.1855],
    ["igi", "Delhi Airport Terminal 3", 28.5562, 77.1000]
  ],
  walks: [["ndls", "cp", 2.2], ["chandni", "redfort", 1.2], ["cp", "indiagate", 2.5], ["ndls", "chandni", 1.6]],
  lines: [
    { key: "metro1", name: "Yellow Line", mode: "metro", stops: ["chandni", "ndls", "cp", "qutub"], mins: [3, 3, 22], noLift: ["chandni"] },
    { key: "metro2", name: "Airport Express", mode: "metro", stops: ["ndls", "igi"], mins: [20] },
    { key: "bus1", name: "Bus 1 Heritage Link", mode: "bus", stops: ["cp", "indiagate", "lotus"], mins: [14, 26] },
    { key: "bus2", name: "Bus 2 Old City", mode: "bus", stops: ["redfort", "chandni", "ndls", "cp"], mins: [5, 5, 8] },
    { key: "bus3", name: "Bus 3 Airport Feeder", mode: "bus", stops: ["igi", "qutub"], mins: [25] }
  ]
});

makeCity({
  id: "mumbai", name: "Mumbai", center: [19.0760, 72.8777],
  weather: { cond: "Light rain", tempC: 28, rain: true },
  crowd: { peak: { bus: 3, metro: 3 }, off: { bus: 2, metro: 2 } },
  stops: [
    ["csmt", "Chhatrapati Shivaji Maharaj Terminus", 18.9398, 72.8355],
    ["gateway", "Gateway of India", 18.9220, 72.8347],
    ["churchgate", "Churchgate Station", 18.9322, 72.8264],
    ["dadar", "Dadar Station", 19.0178, 72.8478],
    ["bkc", "Bandra Kurla Complex", 19.0690, 72.8685],
    ["bandra", "Bandra Station", 19.0544, 72.8402],
    ["juhu", "Juhu Beach", 19.0988, 72.8267],
    ["airport", "Mumbai Airport Terminal 2", 19.0974, 72.8745]
  ],
  walks: [["churchgate", "csmt", 1.6], ["gateway", "csmt", 2.0], ["gateway", "churchgate", 2.4], ["bkc", "bandra", 3.2]],
  lines: [
    { key: "metro1", name: "Metro Line 3 Aqua", mode: "metro", stops: ["churchgate", "csmt", "dadar", "bkc", "airport"], mins: [4, 8, 10, 10], noLift: ["dadar"] },
    { key: "bus1", name: "BEST Bus 1", mode: "bus", stops: ["gateway", "csmt", "dadar", "bandra", "juhu"], mins: [9, 28, 20, 22] },
    { key: "bus2", name: "BEST Bus 2", mode: "bus", stops: ["churchgate", "gateway"], mins: [12] },
    { key: "bus3", name: "BEST Bus 3", mode: "bus", stops: ["bandra", "bkc"], mins: [14] },
    { key: "bus4", name: "BEST Bus 4", mode: "bus", stops: ["juhu", "airport"], mins: [18] }
  ]
});

makeCity({
  id: "bengaluru", name: "Bengaluru", center: [12.9716, 77.5946],
  weather: { cond: "Partly cloudy", tempC: 26, rain: false },
  crowd: { peak: { bus: 3, metro: 3 }, off: { bus: 2, metro: 1 } },
  stops: [
    ["majestic", "Majestic (Kempegowda Bus Station)", 12.9767, 77.5713],
    ["vidhana", "Vidhana Soudha", 12.9797, 77.5907],
    ["cubbon", "Cubbon Park", 12.9763, 77.5929],
    ["mg", "MG Road", 12.9753, 77.6070],
    ["indira", "Indiranagar", 12.9784, 77.6408],
    ["lalbagh", "Lalbagh Botanical Garden", 12.9507, 77.5848],
    ["koramangala", "Koramangala", 12.9352, 77.6245],
    ["whitefield", "Whitefield", 12.9698, 77.7500]
  ],
  walks: [["vidhana", "cubbon", 0.3], ["cubbon", "mg", 1.5], ["majestic", "vidhana", 2.2]],
  lines: [
    { key: "metro1", name: "Purple Line", mode: "metro", stops: ["majestic", "vidhana", "cubbon", "mg", "indira", "whitefield"], mins: [4, 2, 3, 6, 22], noLift: ["indira"] },
    { key: "metro2", name: "Green Line", mode: "metro", stops: ["majestic", "lalbagh"], mins: [12] },
    { key: "bus1", name: "Bus 1 Central Link", mode: "bus", stops: ["majestic", "cubbon", "mg", "indira"], mins: [14, 8, 16] },
    { key: "bus2", name: "Bus 2 South Link", mode: "bus", stops: ["mg", "koramangala", "lalbagh"], mins: [24, 20] }
  ]
});

makeCity({
  id: "kolkata", name: "Kolkata", center: [22.5726, 88.3639],
  weather: { cond: "Humid", tempC: 32, rain: false },
  crowd: { peak: { bus: 3, metro: 3 }, off: { bus: 2, metro: 2 } },
  stops: [
    ["howrah", "Howrah Station", 22.5839, 88.3425],
    ["esplanade", "Esplanade", 22.5646, 88.3516],
    ["parkst", "Park Street", 22.5535, 88.3525],
    ["victoria", "Victoria Memorial", 22.5448, 88.3426],
    ["kalighat", "Kalighat Temple", 22.5200, 88.3427],
    ["scicity", "Science City", 22.5398, 88.3955],
    ["sectorv", "Salt Lake Sector V", 22.5760, 88.4320]
  ],
  walks: [["parkst", "victoria", 1.5], ["esplanade", "parkst", 1.3]],
  lines: [
    { key: "metro1", name: "Blue Line", mode: "metro", stops: ["esplanade", "parkst", "kalighat"], mins: [3, 7], noLift: ["kalighat"] },
    { key: "metro2", name: "Green Line", mode: "metro", stops: ["howrah", "esplanade"], mins: [8] },
    { key: "bus1", name: "Bus S-12", mode: "bus", stops: ["esplanade", "scicity", "sectorv"], mins: [32, 22] },
    { key: "bus2", name: "Bus 2 Maidan Link", mode: "bus", stops: ["victoria", "kalighat"], mins: [18] },
    { key: "bus3", name: "Bus 3 Southern Link", mode: "bus", stops: ["kalighat", "scicity"], mins: [28] }
  ]
});

makeCity({
  id: "chennai", name: "Chennai", center: [13.0827, 80.2707],
  weather: { cond: "Hot and humid", tempC: 34, rain: false },
  crowd: { peak: { bus: 3, metro: 2 }, off: { bus: 2, metro: 1 } },
  stops: [
    ["central", "Chennai Central", 13.0827, 80.2755],
    ["egmore", "Egmore Railway Station", 13.0732, 80.2609],
    ["fort", "Fort St George", 13.0797, 80.2870],
    ["marina", "Marina Beach", 13.0500, 80.2824],
    ["mylapore", "Kapaleeshwarar Temple (Mylapore)", 13.0339, 80.2698],
    ["tnagar", "T. Nagar (Pondy Bazaar)", 13.0418, 80.2341],
    ["guindy", "Guindy", 13.0067, 80.2206],
    ["airport", "Chennai International Airport", 12.9941, 80.1709]
  ],
  walks: [["central", "egmore", 1.9], ["central", "fort", 1.7], ["fort", "marina", 3.5], ["mylapore", "marina", 2.8]],
  lines: [
    { key: "metro1", name: "Blue Line", mode: "metro", stops: ["airport", "guindy", "central"], mins: [9, 22] },
    { key: "metro2", name: "Green Line", mode: "metro", stops: ["central", "egmore", "guindy"], mins: [4, 20], noLift: ["egmore"] },
    { key: "bus1", name: "Bus 1 Coastal Link", mode: "bus", stops: ["central", "fort", "marina", "mylapore"], mins: [8, 16, 14] },
    { key: "bus2", name: "Bus 2 South Link", mode: "bus", stops: ["mylapore", "tnagar", "guindy"], mins: [18, 16] },
    { key: "bus3", name: "Bus 3 Shopping Link", mode: "bus", stops: ["egmore", "tnagar"], mins: [20] }
  ]
});

makeCity({
  id: "hyderabad", name: "Hyderabad", center: [17.3850, 78.4867],
  weather: { cond: "Clear", tempC: 30, rain: false },
  crowd: { peak: { bus: 3, metro: 2 }, off: { bus: 2, metro: 1 } },
  stops: [
    ["secunderabad", "Secunderabad Junction", 17.4337, 78.5013],
    ["hussain", "Hussain Sagar (Tank Bund)", 17.4239, 78.4738],
    ["nampally", "Nampally Station", 17.3910, 78.4693],
    ["charminar", "Charminar", 17.3616, 78.4747],
    ["golconda", "Golconda Fort", 17.3833, 78.4011],
    ["hitec", "HITEC City", 17.4435, 78.3772],
    ["ameerpet", "Ameerpet", 17.4375, 78.4483],
    ["airport", "Rajiv Gandhi International Airport", 17.2403, 78.4294]
  ],
  walks: [["secunderabad", "hussain", 3.2], ["nampally", "charminar", 3.5], ["ameerpet", "hussain", 3.2]],
  lines: [
    { key: "metro1", name: "Red Line", mode: "metro", stops: ["ameerpet", "nampally"], mins: [12], noLift: ["nampally"] },
    { key: "metro2", name: "Blue Line", mode: "metro", stops: ["hitec", "ameerpet"], mins: [10] },
    { key: "bus1", name: "Bus 1 Twin Cities", mode: "bus", stops: ["secunderabad", "hussain", "nampally"], mins: [14, 18] },
    { key: "bus2", name: "Bus 2 Old City", mode: "bus", stops: ["nampally", "charminar"], mins: [18] },
    { key: "bus3", name: "Bus 3 Fort Link", mode: "bus", stops: ["nampally", "golconda"], mins: [35] },
    { key: "bus4", name: "Bus 4 Tech Link", mode: "bus", stops: ["hitec", "golconda"], mins: [30] },
    { key: "bus5", name: "Bus 5 Airport Link", mode: "bus", stops: ["airport", "hitec"], mins: [48] }
  ]
});

var CITY_LIST = Object.keys(CITIES).map(function (k) { return CITIES[k]; });


/* =====================================================================
   4. ROUTING ENGINE
   ===================================================================== */
function isPeakHour(h) { return (h >= 8 && h < 11) || (h >= 17 && h < 20); }
function isLateNightHour(h) { return h >= 21 || h < 5; }

// Depth-first search for simple paths (no repeated stops) of up to maxHops edges.
function findPaths(graph, src, dst, maxHops) {
  var out = [], path = [], visited = {}, bestRide = Infinity;
  visited[src] = true;
  function dfs(node, ride) {
    if (out.length >= MAX_PATHS) { return; }
    if (node === dst) {
      out.push(path.slice());
      if (ride < bestRide) { bestRide = ride; }
      return;
    }
    if (path.length >= maxHops) { return; }
    var edges = graph[node] || [];
    for (var i = 0; i < edges.length; i++) {
      var e = edges[i];
      if (visited[e.to]) { continue; }
      if (ride + e.min > bestRide * PRUNE_FACTOR) { continue; }   // clearly a detour
      visited[e.to] = true; path.push(e);
      dfs(e.to, ride + e.min);
      path.pop(); visited[e.to] = false;
    }
  }
  dfs(src, 0);
  return out;
}

// Merge consecutive edges on the same line (or consecutive walking edges) into legs.
function mergeLegs(edges, city) {
  var legs = [];
  edges.forEach(function (e) {
    var last = legs[legs.length - 1];
    if (last && last.mode === e.mode && last.lineId === e.lineId) {
      last.stops.push(e.to); last.min += e.min; last.km += e.km; last.nStops += 1;
    } else {
      legs.push({
        mode: e.mode, lineId: e.lineId,
        lineName: e.lineId ? city.lines[e.lineId].name : null,
        stops: [e.from, e.to], min: e.min, km: e.km, nStops: 1
      });
    }
  });
  return legs;
}

function legFare(leg) {
  if (leg.mode === "bus") { return FARE.busFlat; }
  if (leg.mode === "metro") { return FARE.metroBase + FARE.metroPerStop * leg.nStops; }
  return 0;
}

// Under 5 free, 5-12 half fare (rounded up), 13+ full fare.
function childFare(age, adultFare) {
  if (age < 5) { return 0; }
  if (age <= 12) { return Math.ceil(adultFare / 2); }
  return adultFare;
}
function groupFareFor(adultFare, query) {
  var adults = query.travellers - query.childAges.length;
  var total = adultFare * adults;
  query.childAges.forEach(function (age) { total += childFare(age, adultFare); });
  return total;
}

function buildRoute(edges, city, query, ctx) {
  var legs = mergeLegs(edges, city);
  var crowdPts = [], noLift = [], walkKm = 0, longestWalk = 0, transitLegs = 0, total = 0, adultFare = 0;
  var kmByMode = { walk: 0, bus: 0, metro: 0 };

  legs.forEach(function (leg) {
    leg.km = round2(leg.km);
    leg.wait = leg.mode === "walk" ? 0 : WAIT_MIN[leg.mode];
    leg.fare = legFare(leg);
    total += leg.min + leg.wait;
    adultFare += leg.fare;
    kmByMode[leg.mode] += leg.km;
    if (leg.mode === "walk") {
      walkKm += leg.km;
      longestWalk = Math.max(longestWalk, leg.km);
    } else {
      transitLegs += 1;
      crowdPts.push(ctx.crowd[leg.mode]);
      if (leg.mode === "metro") {
        // Only the stations where you board or alight need a lift.
        [leg.stops[0], leg.stops[leg.stops.length - 1]].forEach(function (id) {
          if (ALL_STOPS[id].noLift && noLift.indexOf(ALL_STOPS[id].name) === -1) { noLift.push(ALL_STOPS[id].name); }
        });
      }
    }
  });

  var crowdAvg = crowdPts.length ? crowdPts.reduce(function (a, b) { return a + b; }, 0) / crowdPts.length : 1;
  var transfers = Math.max(0, transitLegs - 1);
  var rainMult = ctx.weather.rain ? 1.6 : 1;                         // walking hurts more when it rains
  var route = {
    id: legs.map(function (l) { return l.mode + ":" + l.stops.join(">"); }).join("|"),
    legs: legs,
    totalMin: total,
    walkKm: round2(walkKm),
    longestWalkKm: longestWalk,
    transfers: transfers,
    crowdAvg: crowdAvg,
    stepFree: noLift.length === 0,
    noLiftStops: noLift,
    adultFare: adultFare,
    groupFare: groupFareFor(adultFare, query),
    kmByMode: kmByMode
  };
  route.avgFare = route.groupFare / query.travellers;
  // Comfort score: lower is better.
  route.comfort = transfers * 10 + route.walkKm * 8 * rainMult + crowdAvg * 5;
  route.pen = preferencePenalty(route, query, ctx);
  route.overBudget = !!(query.budget && route.groupFare > query.budget);
  return route;
}

// Penalty added to the ranking score from the person's preferences.
function preferencePenalty(r, query, ctx) {
  var p = query.prefs, pen = 0;
  if (p.lessWalking) { pen += r.walkKm * 12; }
  if (p.fewerTransfers) { pen += r.transfers * 15; }
  if (p.childFriendly) { pen += r.transfers * 6 + r.longestWalkKm * 10 + (r.crowdAvg - 1) * 4; }
  // Late-night walking only re-ranks routes. No route is ever labelled "safe".
  if (p.lateNight && ctx.lateNight) { pen += r.walkKm * 15 + r.longestWalkKm * 20; }
  return pen;
}

var SCORE = {
  cheapest: function (r) { return r.groupFare + r.totalMin * 0.05 + r.pen * 0.5 + (r.overBudget ? 1e6 : 0); },
  fastest: function (r) { return r.totalMin + r.pen + (r.overBudget ? 1e6 : 0); },
  comfortable: function (r) { return r.comfort + r.pen * 0.5 + r.totalMin * 0.05 + (r.overBudget ? 1e6 : 0); }
};
function bestBy(cat, list) {
  return list.slice().sort(function (a, b) {
    return (SCORE[cat](a) - SCORE[cat](b)) || (a.totalMin - b.totalMin) || (a.groupFare - b.groupFare);
  })[0];
}

function crowdLabel(avg) { return avg < 1.5 ? "Low" : (avg < 2.5 ? "Medium" : "High"); }

// Full pipeline: graph -> DFS -> routes -> dedupe -> detour filter -> preferences -> ranking.
function planRoutes(query) {
  var city = CITIES[query.cityId];
  var when = query.when ? new Date(query.when) : new Date();
  var hour = when.getHours();
  var peak = isPeakHour(hour);
  var ctx = {
    when: when, hour: hour, peak: peak, lateNight: isLateNightHour(hour),
    weather: city.weather, crowd: city.crowd[peak ? "peak" : "off"]
  };

  var paths = findPaths(city.graph, query.fromId, query.toId, MAX_HOPS);
  var seen = {}, routes = [];
  paths.forEach(function (p) {
    var r = buildRoute(p, city, query, ctx);
    if (!seen[r.id]) { seen[r.id] = true; routes.push(r); }
  });
  if (!routes.length) { return { error: "No route was found between these stops in the sample network." }; }

  var fastest = Math.min.apply(null, routes.map(function (r) { return r.totalMin; }));
  routes = routes.filter(function (r) { return r.totalMin <= fastest * DETOUR_FACTOR; });

  var notices = [];
  if (query.prefs.stepFree) {
    var sf = routes.filter(function (r) { return r.stepFree; });
    if (sf.length) {
      routes = sf;
    } else {
      notices.push({ type: "warn", text: "No step-free route exists between these stops in the sample data, so routes through stations without a lift are shown. Check the step-free line on each card." });
    }
  }

  var budgetMiss = false;
  if (query.budget) {
    var cheapestFare = Math.min.apply(null, routes.map(function (r) { return r.groupFare; }));
    if (cheapestFare > query.budget) {
      budgetMiss = true;
      notices.push({ type: "bad", text: "No route fits your budget of " + fmtRs(query.budget) + ". The cheapest option found costs " + fmtRs(cheapestFare) + " for the group (estimated)." });
    }
  }

  // Pick the best route for each category, then put the person's priority first.
  var order = [query.priority].concat(CATEGORIES.filter(function (c) { return c !== query.priority; }));
  var cards = [];
  order.forEach(function (cat) {
    var best = bestBy(cat, routes);
    var existing = cards.filter(function (c) { return c.route === best; })[0];
    if (existing) { existing.badges.push(cat); } else { cards.push({ route: best, badges: [cat] }); }
  });
  if (cards.length < 3) {
    var rest = routes.filter(function (r) { return !cards.some(function (c) { return c.route === r; }); });
    rest.sort(function (a, b) { return SCORE[query.priority](a) - SCORE[query.priority](b); });
    while (cards.length < 3 && rest.length) { cards.push({ route: rest.shift(), badges: [] }); }
  }
  if (cards.length < 3) {
    notices.push({ type: "info", text: "Only " + plural(cards.length, "distinct route") + " exist" + (cards.length === 1 ? "s" : "") + " between these stops in the sample network." });
  }
  if (query.prefs.lateNight && ctx.lateNight) {
    notices.push({ type: "info", text: "Your trip falls after 21:00 or before 05:00. Routes with long walks were ranked lower. This only changes the order. It does not mean any route is safe." });
  }

  return { query: query, ctx: ctx, cards: cards, routes: routes, notices: notices, budgetMiss: budgetMiss };
}


/* =====================================================================
   5. APP STATE AND ACCOUNT (demo only)
   ===================================================================== */
var state = {
  profile: null,
  screen: "auth",
  result: null,        // last planRoutes() result
  mapIndex: 0,         // which result card is shown on the map
  mapDist: [],         // per-leg distances for the map (estimate or Google)
  mapsFailed: false,
  gpsBusy: false
};

function defaultPrefs() {
  return { lessWalking: false, fewerTransfers: false, stepFree: false, childFriendly: false, lateNight: false, priority: "fastest" };
}
function profileKey(email) { return "profile:" + String(email).toLowerCase(); }
function loadProfile(email) { return store.get(profileKey(email), null); }
function saveProfile() { if (state.profile) { store.set(profileKey(state.profile.email), state.profile); } }

function newProfile(name, email, isDemo) {
  return {
    name: name, email: String(email).toLowerCase(), demo: !!isDemo, createdAt: new Date().toISOString(),
    places: [], trips: [], recents: [], fares: [], prefs: defaultPrefs()
  };
}

function isoDaysAgo(n) { var d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); }

function createDemoProfile() {
  var p = newProfile("Demo traveller", DEMO_EMAIL, true);
  p.places = [
    { id: uid("pl"), label: "Home station", stopId: "jaipur_junction" },
    { id: uid("pl"), label: "Weekend visit", stopId: "jaipur_hawa" },
    { id: uid("pl"), label: "Office", stopId: "delhi_cp" }
  ];
  p.fares = [
    { date: isoDaysAgo(2), cityId: "jaipur", trip: "Jaipur Junction Railway Station to Hawa Mahal", modes: "Metro + walk", fare: 30 },
    { date: isoDaysAgo(5), cityId: "jaipur", trip: "Sindhi Camp Bus Stand to Amer Fort", modes: "Bus", fare: 12 },
    { date: isoDaysAgo(9), cityId: "delhi", trip: "New Delhi Railway Station to Qutub Minar", modes: "Metro", fare: 38 },
    { date: isoDaysAgo(14), cityId: "mumbai", trip: "Churchgate Station to Dadar Station", modes: "Metro", fare: 26 },
    { date: isoDaysAgo(21), cityId: "bengaluru", trip: "Majestic (Kempegowda Bus Station) to MG Road", modes: "Metro", fare: 26 },
    { date: isoDaysAgo(30), cityId: "hyderabad", trip: "HITEC City to Nampally Station", modes: "Metro", fare: 42 }
  ];
  return p;
}

function startSession(profile, message) {
  state.profile = profile;
  store.set("session", profile.email);
  saveProfile();
  $("#mainNav").hidden = false;
  showScreen("home");
  if (message) { announce(message); }
}

function validEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }

function handleSignin(ev) {
  ev.preventDefault();
  var email = $("#signinEmail").value.trim();
  var pw = $("#signinPassword").value;
  var errors = [];
  if (!validEmail(email)) { errors.push({ id: "signinEmail", msg: "Enter a valid email address, for example name@example.com." }); }
  if (pw.length < 6) { errors.push({ id: "signinPassword", msg: "Enter a demo password of at least 6 characters." }); }
  if (renderErrors($("#signinErrors"), errors, "Fix these before signing in:")) { return; }
  $("#signinPassword").value = "";          // the password is never stored or checked
  var existing = loadProfile(email);
  if (existing) {
    startSession(existing, "Signed in on this device.");
  } else {
    var name = email.split("@")[0];
    startSession(newProfile(name, email, false), "No saved profile found for this email on this device, so a new demo profile was created.");
  }
}

function handleSignup(ev) {
  ev.preventDefault();
  var name = $("#signupName").value.trim();
  var email = $("#signupEmail").value.trim();
  var pw = $("#signupPassword").value;
  var errors = [];
  if (!name) { errors.push({ id: "signupName", msg: "Enter your name." }); }
  if (!validEmail(email)) { errors.push({ id: "signupEmail", msg: "Enter a valid email address, for example name@example.com." }); }
  if (pw.length < 6) { errors.push({ id: "signupPassword", msg: "Enter a demo password of at least 6 characters." }); }
  if (renderErrors($("#signupErrors"), errors, "Fix these before creating your account:")) { return; }
  $("#signupPassword").value = "";
  var existing = loadProfile(email);
  if (existing) {
    existing.name = name;
    startSession(existing, "A demo profile for this email already exists on this device, so you were signed in to it.");
  } else {
    startSession(newProfile(name, email, false), "Demo account created on this device.");
  }
}

function handleDemo() {
  var existing = loadProfile(DEMO_EMAIL);
  startSession(existing || createDemoProfile(), "Signed in with the demo account.");
}

function signOut() {
  store.remove("session");
  state.profile = null;
  state.result = null;
  $("#mainNav").hidden = true;
  showScreen("auth");
  announce("You have signed out.");
}


/* =====================================================================
   6. SCREEN NAVIGATION AND ACCESSIBILITY HELPERS
   ===================================================================== */
var SCREEN_TITLES = {
  auth: "Sign in", home: "Home", plan: "Plan a trip", results: "Your routes", account: "Account"
};
var announceTimer = null;

// Writes to the aria-live region (also shown as a small toast).
function announce(msg) {
  var el = $("#status");
  el.textContent = "";
  window.setTimeout(function () { el.textContent = msg; }, 30);
  window.clearTimeout(announceTimer);
  announceTimer = window.setTimeout(function () { el.textContent = ""; }, 7000);
}

function showScreen(name) {
  if (!state.profile && name !== "auth") { name = "auth"; }
  if (state.profile && name === "auth") { name = "home"; }
  state.screen = name;
  $$(".screen").forEach(function (s) { s.hidden = (s.id !== "screen-" + name); });
  $$(".nav-btn[data-nav]").forEach(function (b) {
    var target = b.dataset.nav;
    var current = (target === name) || (target === "plan" && name === "results");
    if (current) { b.setAttribute("aria-current", "page"); } else { b.removeAttribute("aria-current"); }
  });
  document.title = SCREEN_TITLES[name] + " \u2013 SmartRoute";
  if (name === "home") { renderHome(); }
  if (name === "plan") { initPlanScreen(); }
  if (name === "account") { renderAccount(); }
  window.scrollTo(0, 0);
  var h1 = $("#screen-" + name + " h1");
  if (h1) { h1.focus(); }
}

// Renders an accessible error list. Returns true if there are errors.
function renderErrors(box, errors, heading) {
  $$("[aria-invalid]", box.closest("form") || document).forEach(function (el) { el.removeAttribute("aria-invalid"); });
  if (!errors.length) { box.hidden = true; box.innerHTML = ""; return false; }
  errors.forEach(function (e) {
    var field = document.getElementById(e.id);
    if (field) { field.setAttribute("aria-invalid", "true"); }
  });
  box.innerHTML = "<strong>" + esc(heading || "Please fix the following:") + "</strong><ul>" +
    errors.map(function (e) {
      return '<li><a href="#' + esc(e.id) + '" data-focus="' + esc(e.id) + '">' + esc(e.msg) + "</a></li>";
    }).join("") + "</ul>";
  box.hidden = false;
  box.focus();
  return true;
}


/* =====================================================================
   7. HOME SCREEN
   ===================================================================== */
function greeting() {
  var h = new Date().getHours();
  return h < 12 ? "Good morning" : (h < 17 ? "Good afternoon" : "Good evening");
}

function stopLabel(id) {
  var s = ALL_STOPS[id];
  return s ? s.name + ", " + CITIES[s.cityId].name : "Unknown stop";
}

function renderHome() {
  var p = state.profile;
  if (!p) { return; }
  $("#homeGreeting").textContent = greeting() + ", " + p.name + ". Where to today?";
  var cityOpts = CITY_LIST.map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.name) + "</option>"; }).join("");
  if (!$("#placeCity").options.length) { $("#placeCity").innerHTML = cityOpts; }
  populatePlaceStops();
  renderPlaces();
  renderTrips();
  renderRecents();
  renderPrefsSummary();
}

function populatePlaceStops() {
  var cid = $("#placeCity").value || CITY_LIST[0].id;
  $("#placeStop").innerHTML = CITIES[cid].stopIds.map(function (id) {
    return '<option value="' + esc(id) + '">' + esc(ALL_STOPS[id].name) + "</option>";
  }).join("");
}

function renderPlaces() {
  var list = state.profile.places;
  $("#placesList").innerHTML = list.length ? list.map(function (pl) {
    return '<li class="item"><div class="item-main"><strong>' + esc(pl.label) + '</strong><span class="muted">' + esc(stopLabel(pl.stopId)) + "</span></div>" +
      '<div class="item-actions">' +
      '<button type="button" class="btn btn-secondary btn-small" data-act="place-from" data-id="' + esc(pl.id) + '" aria-label="Use ' + esc(pl.label) + ' as starting point">From</button>' +
      '<button type="button" class="btn btn-secondary btn-small" data-act="place-to" data-id="' + esc(pl.id) + '" aria-label="Use ' + esc(pl.label) + ' as destination">To</button>' +
      '<button type="button" class="btn btn-danger btn-small" data-act="place-remove" data-id="' + esc(pl.id) + '" aria-label="Remove ' + esc(pl.label) + '">Remove</button>' +
      "</div></li>";
  }).join("") : '<li class="empty">No saved places yet. Add one below.</li>';
}

function renderTrips() {
  var list = state.profile.trips;
  $("#tripsList").innerHTML = list.length ? list.map(function (t) {
    var detailId = "trip-detail-" + esc(t.id);
    return '<li class="item"><div class="item-main"><strong>' + esc(t.title) + "</strong>" +
      '<span class="muted">' + esc(CITIES[t.cityId] ? CITIES[t.cityId].name : "") + ", " + esc(fmtMin(t.totalMin)) + ", " + esc(fmtRs(t.groupFare)) + " for " + esc(plural(t.travellers, "traveller")) + "</span></div>" +
      '<div class="item-actions">' +
      '<button type="button" class="btn btn-secondary btn-small" data-act="trip-view" data-id="' + esc(t.id) + '" aria-expanded="false" aria-controls="' + detailId + '">View</button>' +
      '<button type="button" class="btn btn-danger btn-small" data-act="trip-remove" data-id="' + esc(t.id) + '">Remove</button>' +
      "</div>" +
      '<div class="item-detail" id="' + detailId + '" hidden>' +
      '<p><span class="tag tag-est">Estimated</span> <span class="tag tag-sample">Sample data</span></p>' +
      "<p>" + esc(t.routeName) + ": " + esc(fmtMin(t.totalMin)) + ", " + esc(fmtKm(t.walkKm)) + " walking, " + esc(plural(t.transfers, "transfer")) + ".</p>" +
      "<ol>" + t.legs.map(function (l) { return "<li>" + esc(l) + "</li>"; }).join("") + "</ol></div></li>";
  }).join("") : '<li class="empty">No saved trips yet. Plan a trip and choose Save trip.</li>';
}

function renderRecents() {
  var list = state.profile.recents;
  $("#recentsList").innerHTML = list.length ? list.map(function (q, i) {
    return '<li class="item"><div class="item-main"><strong>' + esc(ALL_STOPS[q.fromId] ? ALL_STOPS[q.fromId].name : "?") + " to " + esc(ALL_STOPS[q.toId] ? ALL_STOPS[q.toId].name : "?") + "</strong>" +
      '<span class="muted">' + esc(CITIES[q.cityId].name) + ", " + esc(plural(q.travellers, "traveller")) + ", " + esc(CAT_LABEL[q.priority]) + "</span></div>" +
      '<div class="item-actions"><button type="button" class="btn btn-secondary btn-small" data-act="recent-run" data-index="' + i + '">Search again</button></div></li>';
  }).join("") : '<li class="empty">Your recent searches will appear here.</li>';
}

function renderPrefsSummary() {
  var pr = state.profile.prefs;
  var active = PREF_KEYS.filter(function (k) { return pr[k]; });
  $("#prefsSummary").innerHTML =
    "<p>Default priority: <strong>" + esc(CAT_LABEL[pr.priority] || "Fastest") + "</strong></p>" +
    (active.length
      ? '<ul class="chips">' + active.map(function (k) { return '<li class="chip">' + esc(PREF_LABEL[k]) + "</li>"; }).join("") + "</ul>"
      : '<p class="empty">No extra preferences saved.</p>');
}

function handleAddPlace(ev) {
  ev.preventDefault();
  var label = $("#placeLabel").value.trim();
  var stopId = $("#placeStop").value;
  var errors = [];
  if (!label) { errors.push({ id: "placeLabel", msg: "Give the place a label, for example Home." }); }
  if (!ALL_STOPS[stopId]) { errors.push({ id: "placeStop", msg: "Choose a stop." }); }
  if (state.profile.places.length >= 20) { errors.push({ id: "placeLabel", msg: "You can save up to 20 places. Remove one first." }); }
  if (renderErrors($("#placeErrors"), errors, "Fix this to save the place:")) { return; }
  state.profile.places.push({ id: uid("pl"), label: label, stopId: stopId });
  saveProfile();
  $("#placeLabel").value = "";
  renderPlaces();
  announce("Saved " + label + ".");
}

function handleHomeClick(ev) {
  var btn = ev.target.closest("[data-act]");
  if (!btn) { return; }
  var act = btn.dataset.act, p = state.profile;
  if (act === "place-from" || act === "place-to") {
    var pl = p.places.filter(function (x) { return x.id === btn.dataset.id; })[0];
    if (!pl) { return; }
    showScreen("plan");
    setPlanCity(ALL_STOPS[pl.stopId].cityId, false);
    $(act === "place-from" ? "#fromInput" : "#toInput").value = ALL_STOPS[pl.stopId].name;
    announce(pl.label + " set as " + (act === "place-from" ? "starting point." : "destination."));
  } else if (act === "place-remove") {
    p.places = p.places.filter(function (x) { return x.id !== btn.dataset.id; });
    saveProfile(); renderPlaces(); announce("Place removed.");
  } else if (act === "trip-view") {
    var detail = document.getElementById("trip-detail-" + btn.dataset.id);
    if (detail) {
      var open = detail.hidden;
      detail.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
      btn.textContent = open ? "Hide" : "View";
    }
  } else if (act === "trip-remove") {
    p.trips = p.trips.filter(function (x) { return x.id !== btn.dataset.id; });
    saveProfile(); renderTrips(); announce("Saved trip removed.");
  } else if (act === "recent-run") {
    var q = p.recents[Number(btn.dataset.index)];
    if (q) { runSearch(JSON.parse(JSON.stringify(q)), true); }
  }
}


/* =====================================================================
   8. PLAN SCREEN: form, validation, GPS
   ===================================================================== */
var planReady = false;

function initPlanScreen() {
  if (!planReady) {
    $("#city").innerHTML = CITY_LIST.map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.name) + "</option>"; }).join("");
    updateStopList();
    planReady = true;
  }
}

function updateStopList() {
  var city = CITIES[$("#city").value];
  $("#stopList").innerHTML = city.stopIds.map(function (id) { return '<option value="' + esc(ALL_STOPS[id].name) + '"></option>'; }).join("");
}

// Switch city. Clears From/To only when they don't exist in the new city.
function setPlanCity(cityId, keepInputs) {
  initPlanScreen();
  $("#city").value = cityId;
  updateStopList();
  if (!keepInputs) {
    ["#fromInput", "#toInput"].forEach(function (sel) {
      var r = resolveStop($(sel).value, cityId);
      if (!r || r.otherCity) { $(sel).value = ""; }
    });
  }
}

// Finds a stop by (case-insensitive) name, then by a unique partial match in the selected city.
function resolveStop(text, cityId) {
  var n = String(text || "").trim().toLowerCase();
  if (!n) { return null; }
  var city = CITIES[cityId], i, id;
  for (i = 0; i < city.stopIds.length; i++) {
    if (ALL_STOPS[city.stopIds[i]].name.toLowerCase() === n) { return { stop: ALL_STOPS[city.stopIds[i]] }; }
  }
  var partial = city.stopIds.filter(function (sid) { return ALL_STOPS[sid].name.toLowerCase().indexOf(n) !== -1; });
  if (partial.length === 1) { return { stop: ALL_STOPS[partial[0]] }; }
  for (id in ALL_STOPS) {
    if (Object.prototype.hasOwnProperty.call(ALL_STOPS, id) && ALL_STOPS[id].name.toLowerCase() === n) {
      return { stop: ALL_STOPS[id], otherCity: ALL_STOPS[id].cityId };
    }
  }
  return null;
}

function readPrefsFromForm() {
  var p = {};
  PREF_KEYS.forEach(function (k) { p[k] = $("#pref-" + k).checked; });
  p.priority = ($("input[name='priority']:checked") || { value: "fastest" }).value;
  return p;
}

function applyPrefsToForm(prefs) {
  PREF_KEYS.forEach(function (k) { $("#pref-" + k).checked = !!prefs[k]; });
  var radio = $("input[name='priority'][value='" + (prefs.priority || "fastest") + "']");
  if (radio) { radio.checked = true; }
  if (PREF_KEYS.some(function (k) { return prefs[k]; })) { $("#morePrefs").open = true; }
}

// Child age inputs: one per child, keeping values already typed.
function renderChildAges() {
  var n = parseInt($("#children").value, 10);
  if (!(n > 0)) { n = 0; }
  n = Math.min(n, 9);
  var old = $$("#childAges input").map(function (i) { return i.value; });
  var html = "";
  for (var i = 0; i < n; i++) {
    html += '<div class="field"><label for="child-age-' + i + '">Age of child ' + (i + 1) + '</label>' +
      '<input type="number" id="child-age-' + i + '" min="0" max="17" step="1" inputmode="numeric" value="' + esc(old[i] || "") + '"></div>';
  }
  $("#childAges").innerHTML = html;
  $("#childAgesWrap").hidden = n === 0;
}

// Validate the plan form and return { errors, query }.
function validatePlan() {
  var errors = [];
  var cityId = $("#city").value;
  var fromText = $("#fromInput").value, toText = $("#toInput").value;
  var from = resolveStop(fromText, cityId), to = resolveStop(toText, cityId);

  function stopError(id, label, text, r) {
    if (!text.trim()) { errors.push({ id: id, msg: label + " is required." }); }
    else if (!r) { errors.push({ id: id, msg: label + " \"" + text.trim() + "\" is not a stop in " + CITIES[cityId].name + ". Pick one from the list." }); }
    else if (r.otherCity) { errors.push({ id: id, msg: label + " \"" + r.stop.name + "\" is in " + CITIES[r.otherCity].name + ". Change the city or choose a stop in " + CITIES[cityId].name + "." }); }
  }
  stopError("fromInput", "Starting point", fromText, from);
  stopError("toInput", "Destination", toText, to);
  if (from && to && !from.otherCity && !to.otherCity && from.stop.id === to.stop.id) {
    errors.push({ id: "toInput", msg: "Starting point and destination must be different stops." });
  }

  var whenRaw = $("#when").value, when = "";
  if (whenRaw) {
    if (isNaN(new Date(whenRaw).getTime())) { errors.push({ id: "when", msg: "Enter a valid date and time, or leave it blank." }); }
    else { when = whenRaw; }
  }

  var tRaw = $("#travellers").value.trim(), travellers = Number(tRaw);
  if (!/^\d+$/.test(tRaw) || travellers < 1 || travellers > 10) {
    errors.push({ id: "travellers", msg: "Total travellers must be a whole number from 1 to 10." });
    travellers = NaN;
  }

  var cRaw = $("#children").value.trim(), children = cRaw === "" ? 0 : Number(cRaw), childAges = [];
  if (!/^\d*$/.test(cRaw) || children < 0) {
    errors.push({ id: "children", msg: "Number of children must be a whole number, 0 or more." });
  } else if (!isNaN(travellers) && children > travellers - 1) {
    errors.push({ id: "children", msg: "At least one adult must travel, so children can be at most " + Math.max(0, travellers - 1) + "." });
  } else {
    for (var i = 0; i < children; i++) {
      var a = $("#child-age-" + i), v = a ? a.value.trim() : "";
      if (!/^\d+$/.test(v) || Number(v) > 17) { errors.push({ id: "child-age-" + i, msg: "Enter an age from 0 to 17 for child " + (i + 1) + "." }); }
      else { childAges.push(Number(v)); }
    }
  }

  var bRaw = $("#budget").value.trim(), budget = null;
  if (bRaw !== "") {
    if (!/^\d+$/.test(bRaw) || Number(bRaw) < 1 || Number(bRaw) > 100000) {
      errors.push({ id: "budget", msg: "Budget must be a whole number of rupees between 1 and 100000, or leave it blank." });
    } else { budget = Number(bRaw); }
  }

  var prefs = readPrefsFromForm();
  var priority = prefs.priority;
  delete prefs.priority;

  var query = null;
  if (!errors.length) {
    query = {
      cityId: cityId, fromId: from.stop.id, toId: to.stop.id, when: when,
      travellers: travellers, childAges: childAges, budget: budget, priority: priority, prefs: prefs
    };
  }
  return { errors: errors, query: query };
}

function handlePlanSubmit(ev) {
  ev.preventDefault();
  var res = validatePlan();
  if (renderErrors($("#planErrors"), res.errors, "Please fix the following before searching:")) { return; }
  if ($("#savePrefs").checked) {
    var saved = JSON.parse(JSON.stringify(res.query.prefs));
    saved.priority = res.query.priority;
    state.profile.prefs = saved;
    saveProfile();
  }
  runSearch(res.query, false);
}

// Plan, remember the search, and show the results screen.
function runSearch(query, fromRecent) {
  var result = planRoutes(query);
  if (result.error) {
    showScreen("plan");
    renderErrors($("#planErrors"), [{ id: "fromInput", msg: result.error }], "No routes found:");
    return;
  }
  var key = JSON.stringify([query.cityId, query.fromId, query.toId, query.travellers, query.childAges, query.priority, query.budget, query.prefs]);
  var recents = state.profile.recents.filter(function (q) {
    return JSON.stringify([q.cityId, q.fromId, q.toId, q.travellers, q.childAges, q.priority, q.budget, q.prefs]) !== key;
  });
  recents.unshift(JSON.parse(JSON.stringify(query)));
  state.profile.recents = recents.slice(0, 8);
  saveProfile();

  state.result = result;
  state.mapIndex = 0;
  showScreen("results");
  renderResults();
  if (fromRecent) { announce("Searched again."); }
}

/* ---------- GPS: "Use my location" ---------- */
function gpsMessage(lines) {
  $("#gpsStatus").innerHTML = lines.map(function (l) { return "<p>" + esc(l) + "</p>"; }).join("");
}

function useMyLocation() {
  var btn = $("#btnGps");
  if (!("geolocation" in navigator)) {
    gpsMessage(["This browser can't share your location. Choose the city and starting point yourself."]);
    return;
  }
  state.gpsBusy = true;
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  gpsMessage(["Finding your location\u2026 allow location access if your browser asks."]);

  navigator.geolocation.getCurrentPosition(function (pos) {
    finishGps();
    handlePosition(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
  }, function (err) {
    finishGps();
    var msg = {
      1: "Location permission was denied. Allow it in your browser settings, or choose the city and starting point yourself.",
      2: "Your position isn't available right now. Check that location services are on, or enter the starting point yourself.",
      3: "Finding your location took longer than 10 seconds. Try again, or enter the starting point yourself."
    }[err.code] || "Your location couldn't be read. Enter the starting point yourself.";
    gpsMessage([msg]);
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
}

function finishGps() {
  state.gpsBusy = false;
  $("#btnGps").disabled = false;
  $("#btnGps").removeAttribute("aria-busy");
}

// The coordinates are used only inside this function and are never stored.
function handlePosition(lat, lng, accuracy) {
  var lines = ["Location: " + lat.toFixed(5) + ", " + lng.toFixed(5) + " (accuracy about " + Math.round(accuracy) + " m)."];
  var inIndia = lat >= INDIA_BOX.minLat && lat <= INDIA_BOX.maxLat && lng >= INDIA_BOX.minLng && lng <= INDIA_BOX.maxLng;

  if (!inIndia) {
    lines.push("You appear to be outside India, where SmartRoute has no coverage. Choose the city and starting point yourself.");
    gpsMessage(lines);
    return;
  }

  var nearest = null;
  CITY_LIST.forEach(function (c) {
    var d = haversineKm(lat, lng, c.center[0], c.center[1]);
    if (!nearest || d < nearest.dist) { nearest = { city: c, dist: d }; }
  });

  var stop = null;
  nearest.city.stopIds.forEach(function (id) {
    var s = ALL_STOPS[id], d = haversineKm(lat, lng, s.lat, s.lng);
    if (!stop || d < stop.dist) { stop = { stop: s, dist: d }; }
  });

  setPlanCity(nearest.city.id, true);
  $("#fromInput").value = stop.stop.name;

  if (nearest.dist <= GPS_NEAR_KM) {
    lines.push("You're within " + GPS_NEAR_KM + " km of " + nearest.city.name + " (about " + Math.round(nearest.dist) + " km from the centre). The city is set to " + nearest.city.name + " and the starting point to the nearest stop, " + stop.stop.name + ", about " + round1(stop.dist) + " km away.");
  } else {
    lines.push("You're in India but more than " + GPS_NEAR_KM + " km from any covered city, so your position is simulated at the nearest one, " + nearest.city.name + " (about " + Math.round(nearest.dist) + " km away). The starting point is set to " + stop.stop.name + " as a stand-in.");
  }
  gpsMessage(lines);
  announce("Starting point set to " + stop.stop.name + ".");
}


/* =====================================================================
   9. RESULTS SCREEN
   ===================================================================== */
function legText(leg) {
  var from = ALL_STOPS[leg.stops[0]].name, to = ALL_STOPS[leg.stops[leg.stops.length - 1]].name;
  if (leg.mode === "walk") { return "Walk " + fmtKm(leg.km) + " from " + from + " to " + to + " (" + fmtMin(leg.min) + ")"; }
  return MODE_META[leg.mode].label + " " + leg.lineName + " from " + from + " to " + to + ", " + plural(leg.nStops, "stop") +
    " (" + fmtMin(leg.min) + " ride + " + leg.wait + " min wait)";
}

function cardTitle(card) {
  return card.badges.length ? card.badges.map(function (b) { return CAT_LABEL[b]; }).join(" and ") : "Alternative route";
}

// Plain-language reasons for the ranking. Honest about estimates.
function buildWhy(card, result) {
  var r = card.route, q = result.query, routes = result.routes, parts = [];
  var minFare = Math.min.apply(null, routes.map(function (x) { return x.groupFare; }));
  var minTime = Math.min.apply(null, routes.map(function (x) { return x.totalMin; }));
  var minComfort = Math.min.apply(null, routes.map(function (x) { return x.comfort; }));

  card.badges.forEach(function (b) {
    if (b === "cheapest") {
      parts.push(r.groupFare === minFare
        ? "Lowest group fare of the " + routes.length + " routes compared (" + fmtRs(r.groupFare) + ")."
        : "Best match for cost once your budget and preferences were applied. A lower fare of " + fmtRs(minFare) + " exists but ranked lower.");
    } else if (b === "fastest") {
      parts.push(r.totalMin === minTime
        ? "Shortest total time of the " + routes.length + " routes compared (" + fmtMin(r.totalMin) + ", waits included)."
        : "Best match for speed once your preferences were applied. A " + fmtMin(minTime) + " route exists but ranked lower.");
    } else {
      parts.push((r.comfort === minComfort ? "Lowest comfort score" : "Best comfort match after your preferences") +
        ": " + plural(r.transfers, "transfer") + ", " + fmtKm(r.walkKm) + " walking and " + crowdLabel(r.crowdAvg).toLowerCase() + " crowding.");
    }
  });
  if (!card.badges.length) {
    parts.push("Not the top pick for any priority, but a reasonable alternative: " + fmtMin(r.totalMin) + ", " + fmtRs(r.groupFare) + ", " + plural(r.transfers, "transfer") + ".");
  }
  if (card.badges.indexOf("comfortable") !== -1 && result.ctx.weather.rain) {
    parts.push("Walking counts extra because the sample weather shows rain.");
  }
  if (q.prefs.lessWalking) { parts.push("\"Less walking\" added a penalty for the " + fmtKm(r.walkKm) + " of walking here."); }
  if (q.prefs.fewerTransfers) { parts.push("\"Fewer transfers\" added a penalty for the " + plural(r.transfers, "transfer") + " here."); }
  if (q.prefs.childFriendly) { parts.push("\"Child-friendly\" favoured fewer transfers, shorter walks and lighter crowds."); }
  if (q.prefs.stepFree) { parts.push(r.stepFree ? "Boarding and alighting stations have lifts in the sample data." : "No step-free option exists, so this route uses a station without a lift."); }
  if (q.prefs.lateNight && result.ctx.lateNight) { parts.push("Because it's late at night, long walks were ranked lower. This only changes the order."); }
  if (r.overBudget) { parts.push("This route is over your budget by " + fmtRs(r.groupFare - q.budget) + "."); }
  return parts.join(" ");
}

function routeCardHtml(card, i, result) {
  var r = card.route, q = result.query, ctx = result.ctx;
  var isPriority = card.badges.indexOf(q.priority) !== -1;
  var adults = q.travellers - q.childAges.length;
  var legs = r.legs.map(function (leg) {
    var from = ALL_STOPS[leg.stops[0]].name, to = ALL_STOPS[leg.stops[leg.stops.length - 1]].name;
    var meta = MODE_META[leg.mode];
    var line1 = leg.mode === "walk" ? "Walk " + fmtKm(leg.km) : meta.label + " " + leg.lineName;
    var line2 = leg.mode === "walk"
      ? from + " to " + to + ", about " + fmtMin(leg.min)
      : from + " to " + to + ", " + plural(leg.nStops, "stop") + ", " + fmtMin(leg.min) + " ride + " + leg.wait + " min wait, " + fmtRs(leg.fare) + " per adult";
    return '<li class="leg leg-' + leg.mode + '"><span class="leg-icon" aria-hidden="true">' + meta.icon + '</span>' +
      "<div><strong>" + esc(line1) + '</strong><span class="sub">' + esc(line2) + "</span></div></li>";
  }).join("");

  var stepFreeText = r.stepFree ? "Yes" : "No";
  var stepFreeNote = r.stepFree ? "" : '<p class="hint">No lift at: ' + esc(r.noLiftStops.join(", ")) + " (sample data).</p>";
  var gMapsUrl = googleMapsUrl(r);

  return '<article class="route-card' + (isPriority ? " is-priority" : "") + '" aria-labelledby="route-title-' + i + '">' +
    "<header>" +
      '<h3 id="route-title-' + i + '">' + esc(cardTitle(card)) + "</h3>" +
      (isPriority ? '<span class="tag tag-priority">Your priority</span>' : "") +
      '<span class="tag tag-est">Estimated</span><span class="tag tag-sample">Sample data</span>' +
      (r.overBudget ? '<span class="tag tag-bad">Over budget</span>' : "") +
    "</header>" +
    '<dl class="stats">' +
      '<div class="stat big"><dt>Total time</dt><dd>' + esc(fmtMin(r.totalMin)) + "</dd></div>" +
      '<div class="stat"><dt>Group fare (' + esc(plural(adults, "adult")) + (q.childAges.length ? ", " + esc(plural(q.childAges.length, "child", "children")) : "") + ")</dt><dd>" + esc(fmtRs(r.groupFare)) + "</dd></div>" +
      '<div class="stat"><dt>Average per person</dt><dd>' + esc(fmtRs(r.avgFare)) + "</dd></div>" +
      '<div class="stat"><dt>Walking</dt><dd>' + esc(fmtKm(r.walkKm)) + "</dd></div>" +
      '<div class="stat"><dt>Transfers</dt><dd>' + r.transfers + "</dd></div>" +
      '<div class="stat"><dt>Step-free</dt><dd>' + stepFreeText + "</dd></div>" +
      '<div class="stat"><dt>Crowd level</dt><dd>' + esc(crowdLabel(r.crowdAvg)) + "</dd></div>" +
    "</dl>" +
    stepFreeNote +
    '<ol class="legs" aria-label="Journey legs">' + legs + "</ol>" +
    '<ul class="meta-line"><li class="tag tag-sample">Weather: ' + esc(ctx.weather.cond) + ", " + esc(ctx.weather.tempC) + "\u00B0C</li>" +
    '<li class="tag tag-sample">' + (ctx.peak ? "Peak hours" : "Off-peak hours") + "</li></ul>" +
    '<p class="why"><strong>Why this route</strong>' + esc(buildWhy(card, result)) + "</p>" +
    '<div class="card-actions">' +
      '<button type="button" class="btn btn-primary" data-act="show-map" data-index="' + i + '">Show on map</button>' +
      '<button type="button" class="btn btn-secondary" data-act="save-trip" data-index="' + i + '">Save trip</button>' +
      '<a class="btn btn-secondary" href="' + esc(gMapsUrl) + '" target="_blank" rel="noopener noreferrer">Google Maps</a>' +
    "</div>" +
  "</article>";
}

function renderResults() {
  var res = state.result, q = res.query, city = CITIES[q.cityId];
  var when = res.ctx.when.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
  var adults = q.travellers - q.childAges.length;
  $("#resultsSummary").textContent =
    ALL_STOPS[q.fromId].name + " to " + ALL_STOPS[q.toId].name + " in " + city.name + ". " +
    plural(adults, "adult") + (q.childAges.length ? " and " + plural(q.childAges.length, "child", "children") : "") +
    ", " + (q.when ? "leaving " : "planned for now, ") + when + ". Fares, times, weather and crowd levels are sample or estimated.";

  $("#resultNotices").innerHTML = res.notices.map(function (n) {
    return '<p class="notice notice-' + (n.type === "bad" ? "bad" : (n.type === "warn" ? "warn" : "info")) + '" role="note">' + esc(n.text) + "</p>";
  }).join("");

  $("#routeCards").innerHTML = res.cards.map(function (c, i) { return routeCardHtml(c, i, res); }).join("");
  renderMapSection();
}

function saveTrip(index) {
  var res = state.result, card = res.cards[index], p = state.profile;
  if (!card) { return; }
  var r = card.route, q = res.query;
  var title = ALL_STOPS[q.fromId].name + " to " + ALL_STOPS[q.toId].name;
  var sig = q.cityId + "|" + r.id;
  if (p.trips.some(function (t) { return t.sig === sig; })) { announce("This trip is already saved."); return; }
  p.trips.unshift({
    id: uid("tr"), sig: sig, savedAt: new Date().toISOString(), cityId: q.cityId, title: title,
    routeName: cardTitle(card), totalMin: r.totalMin, groupFare: r.groupFare, travellers: q.travellers,
    walkKm: r.walkKm, transfers: r.transfers, legs: r.legs.map(legText)
  });
  p.trips = p.trips.slice(0, 30);
  var modes = [];
  r.legs.forEach(function (l) { if (modes.indexOf(MODE_META[l.mode].label) === -1) { modes.push(MODE_META[l.mode].label); } });
  p.fares.unshift({ date: new Date().toISOString().slice(0, 10), cityId: q.cityId, trip: title, modes: modes.join(" + "), fare: r.groupFare });
  p.fares = p.fares.slice(0, 40);
  saveProfile();
  announce("Trip saved to your account.");
}

function handleResultsClick(ev) {
  var btn = ev.target.closest("[data-act]");
  if (!btn) { return; }
  var i = Number(btn.dataset.index);
  if (btn.dataset.act === "save-trip") { saveTrip(i); }
  if (btn.dataset.act === "show-map") {
    selectMapTrip(i);
    var title = $("#mapTitle");
    title.setAttribute("tabindex", "-1");
    title.scrollIntoView({ block: "start" });
    title.focus();
  }
}


/* =====================================================================
   10. MAP AND DISTANCE BREAKDOWN
   Distances per mode (walk / bus / metro) for the selected route.
   - Without a key: a simple schematic SVG map.
   - With a Google Maps key: Google Maps with coloured lines per mode, and,
     if the Directions API is enabled, Google's own walking and road distances
     for the walk and bus legs.
   Everything else is an estimate: walking uses the sample walking links,
   bus and metro use straight-line distance between stops plus a road allowance.
   ===================================================================== */
var gmapsPromise = null;
var gmap = null;
var gOverlays = [];
var gDrawToken = 0;

function getMapsKey() { return store.get("mapsKey", "") || DEFAULT_MAPS_KEY; }
function currentRoute() { return state.result ? state.result.cards[state.mapIndex].route : null; }
function setMapStatus(text) { $("#mapStatus").textContent = text || ""; }

function googleMapsUrl(route) {
  var first = ALL_STOPS[route.legs[0].stops[0]];
  var lastLeg = route.legs[route.legs.length - 1];
  var last = ALL_STOPS[lastLeg.stops[lastLeg.stops.length - 1]];
  return "https://www.google.com/maps/dir/?api=1&origin=" + first.lat + "," + first.lng +
    "&destination=" + last.lat + "," + last.lng + "&travelmode=transit";
}

function renderMapSection() {
  var res = state.result;
  $("#mapSection").hidden = false;
  $("#mapTabs").innerHTML = res.cards.map(function (c, i) {
    return '<button type="button" class="map-tab" data-map="' + i + '" aria-pressed="' + (i === state.mapIndex) + '">Trip ' + (i + 1) + ": " + esc(cardTitle(c)) + "</button>";
  }).join("");
  $("#mapsKey").value = getMapsKey();
  selectMapTrip(state.mapIndex);
}

function selectMapTrip(i) {
  state.mapIndex = i;
  $$("#mapTabs .map-tab").forEach(function (b) { b.setAttribute("aria-pressed", String(Number(b.dataset.map) === i)); });
  var route = currentRoute();
  state.mapDist = route.legs.map(function (l) { return { km: l.km, source: "estimate" }; });
  $("#openGoogleMaps").href = googleMapsUrl(route);
  renderDistances(route);
  drawMap(route);
}

// Distance cards: how far on foot, by bus and by metro.
function renderDistances(route) {
  var km = { walk: 0, bus: 0, metro: 0 }, mins = { walk: 0, bus: 0, metro: 0 };
  route.legs.forEach(function (l, i) { km[l.mode] += state.mapDist[i].km; mins[l.mode] += l.min; });
  var total = km.walk + km.bus + km.metro;
  var measured = state.mapDist.filter(function (d) { return d.source === "google"; }).length;

  function box(mode, extra) {
    var m = MODE_META[mode];
    return '<div class="dist-box ' + mode + '"><div class="label"><span aria-hidden="true">' + m.icon + "</span>" + (mode === "walk" ? "On foot" : (mode === "bus" ? "By bus" : "By metro")) + "</div>" +
      '<div class="value">' + esc(fmtKm(km[mode])) + '</div><div class="sub">' + (km[mode] > 0 ? "about " + esc(fmtMin(mins[mode])) + extra : "not used on this trip") + "</div></div>";
  }

  var bits = [];
  if (km.walk > 0) { bits.push("walk " + fmtKm(km.walk)); }
  if (km.bus > 0) { bits.push("ride a bus for " + fmtKm(km.bus)); }
  if (km.metro > 0) { bits.push("take the metro for " + fmtKm(km.metro)); }
  var sentence = "On this trip you " + bits.join(", ").replace(/, ([^,]*)$/, " and $1") + ".";

  function pct(v) { return total ? (v / total * 100).toFixed(1) : 0; }
  $("#distanceSummary").innerHTML =
    '<div class="dist-grid">' + box("walk", " walking") + box("bus", " on board") + box("metro", " on board") + "</div>" +
    '<div class="dist-bar" role="img" aria-label="Share of distance: ' + esc(sentence) + '">' +
      '<span class="walk" style="width:' + pct(km.walk) + '%"></span><span class="bus" style="width:' + pct(km.bus) + '%"></span><span class="metro" style="width:' + pct(km.metro) + '%"></span></div>' +
    '<p class="dist-sentence">' + esc(sentence) + "</p>" +
    '<ul class="legend"><li><span class="swatch" style="border-color:' + MODE_META.walk.color + ';border-top-style:dotted"></span>Walk</li>' +
    '<li><span class="swatch" style="border-color:' + MODE_META.bus.color + '"></span>Bus</li>' +
    '<li><span class="swatch" style="border-color:' + MODE_META.metro.color + ';border-top-style:double;border-top-width:6px"></span>Metro</li></ul>';

  $("#legDistances").innerHTML = route.legs.map(function (l, i) {
    var d = state.mapDist[i];
    return "<li><span aria-hidden=\"true\">" + MODE_META[l.mode].icon + "</span><span>" + esc(legText(l)) + "</span>" +
      '<span class="km">' + esc(fmtKm(d.km)) + (d.source === "google" ? " (Google)" : " (est.)") + "</span></li>";
  }).join("");

  $("#mapNote").textContent = measured
    ? measured + " of " + route.legs.length + " legs measured by Google. The rest are estimates (straight-line distance between stops plus a road allowance, or sample walking links)."
    : "All distances are estimates. Walking uses sample walking links. Bus and metro use straight-line distance between stops plus a road allowance. They are not live and not measured on roads.";
}

function pointOf(id) { return { lat: ALL_STOPS[id].lat, lng: ALL_STOPS[id].lng }; }

function drawMap(route) {
  var key = getMapsKey();
  if (key && !state.mapsFailed) {
    drawGoogleMap(route, key);
  } else {
    drawFallbackMap(route);
    setMapStatus(key ? "Google Maps could not be used, so a simple schematic map is shown." : "Showing a simple schematic map. Add a Google Maps key below to see Google Maps.");
  }
}

/* ---------- Schematic SVG map (no key needed) ---------- */
function svgEl(name, attrs, text) {
  var el = document.createElementNS("http://www.w3.org/2000/svg", name);
  Object.keys(attrs || {}).forEach(function (k) { el.setAttribute(k, attrs[k]); });
  if (text !== undefined) { el.textContent = text; }
  return el;
}

function drawFallbackMap(route) {
  gDrawToken++;                       // cancel any running Google drawing
  $("#gmap").hidden = true;
  var holder = $("#fallbackMap");
  holder.hidden = false;
  holder.innerHTML = "";

  var pts = [];
  route.legs.forEach(function (l) { l.stops.forEach(function (id) { pts.push(ALL_STOPS[id]); }); });
  var minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  pts.forEach(function (s) {
    minLat = Math.min(minLat, s.lat); maxLat = Math.max(maxLat, s.lat);
    minLng = Math.min(minLng, s.lng); maxLng = Math.max(maxLng, s.lng);
  });
  var W = 680, H = 380, padX = 70, padY = 50;
  var kx = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
  var spanX = Math.max((maxLng - minLng) * kx, 0.002), spanY = Math.max(maxLat - minLat, 0.002);
  var scale = Math.min((W - 2 * padX) / spanX, (H - 2 * padY) / spanY);
  var offX = (W - spanX * scale) / 2, offY = (H - spanY * scale) / 2;
  function proj(s) { return { x: offX + (s.lng - minLng) * kx * scale, y: offY + (maxLat - s.lat) * scale }; }

  var first = ALL_STOPS[route.legs[0].stops[0]];
  var lastLeg = route.legs[route.legs.length - 1];
  var last = ALL_STOPS[lastLeg.stops[lastLeg.stops.length - 1]];
  var svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, role: "img",
    "aria-label": "Schematic map of the trip from " + first.name + " to " + last.name + ". Distances are listed below the map." });
  svg.appendChild(svgEl("rect", { x: 0, y: 0, width: W, height: H, fill: "#eaf1fb" }));

  // Lines first, then stops, so stops sit on top.
  route.legs.forEach(function (l) {
    var d = l.stops.map(function (id, i) { var p = proj(ALL_STOPS[id]); return (i ? "L" : "M") + p.x.toFixed(1) + " " + p.y.toFixed(1); }).join(" ");
    var style = { walk: { w: 5, dash: "2 9" }, bus: { w: 6, dash: "" }, metro: { w: 8, dash: "" } }[l.mode];
    var path = svgEl("path", { d: d, fill: "none", stroke: MODE_META[l.mode].color, "stroke-width": style.w, "stroke-linecap": "round", "stroke-linejoin": "round" });
    if (style.dash) { path.setAttribute("stroke-dasharray", style.dash); }
    svg.appendChild(path);
    if (l.mode === "metro") {
      svg.appendChild(svgEl("path", { d: d, fill: "none", stroke: "#ffffff", "stroke-width": 2, "stroke-dasharray": "10 8", opacity: 0.8 }));
    }
  });

  var seen = {}, n = 0;
  route.legs.forEach(function (l) {
    l.stops.forEach(function (id) {
      if (seen[id]) { return; }
      seen[id] = true;
      var s = ALL_STOPS[id], p = proj(s), isEnd = (s === first || s === last);
      svg.appendChild(svgEl("circle", { cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: isEnd ? 9 : 5.5, fill: isEnd ? (s === first ? "#0f172a" : "#1a56db") : "#ffffff", stroke: "#0f172a", "stroke-width": 2 }));
      var label = s.name.length > 24 ? s.name.slice(0, 23) + "\u2026" : s.name;
      var above = (n % 2 === 0);
      var anchor = p.x > W - 140 ? "end" : (p.x < 140 ? "start" : "middle");
      var t = svgEl("text", { x: p.x.toFixed(1), y: (p.y + (above ? -14 : 24)).toFixed(1), "text-anchor": anchor, "font-size": 12.5, "font-weight": 600, fill: "#0f172a", stroke: "#eaf1fb", "stroke-width": 3, "paint-order": "stroke" }, label);
      svg.appendChild(t);
      n++;
    });
  });
  var pa = proj(first), pb = proj(last);
  svg.appendChild(svgEl("text", { x: pa.x.toFixed(1), y: (pa.y + 4).toFixed(1), "text-anchor": "middle", "font-size": 11, "font-weight": 800, fill: "#ffffff" }, "A"));
  svg.appendChild(svgEl("text", { x: pb.x.toFixed(1), y: (pb.y + 4).toFixed(1), "text-anchor": "middle", "font-size": 11, "font-weight": 800, fill: "#ffffff" }, "B"));
  holder.appendChild(svg);
}

/* ---------- Google Maps (needs an API key) ---------- */
function loadGoogleMaps(key) {
  if (window.google && window.google.maps) { return Promise.resolve(); }
  if (gmapsPromise) { return gmapsPromise; }
  gmapsPromise = new Promise(function (resolve, reject) {
    window.__smartRouteMapsReady = function () { resolve(); };
    var s = document.createElement("script");
    s.src = "https://maps.googleapis.com/maps/api/js?key=" + encodeURIComponent(key) + "&callback=__smartRouteMapsReady";
    s.async = true;
    s.onerror = function () { gmapsPromise = null; reject(new Error("load failed")); };
    document.head.appendChild(s);
  });
  return gmapsPromise;
}

// Google calls this global if the key is invalid or restricted.
window.gm_authFailure = function () {
  state.mapsFailed = true;
  setMapStatus("Google rejected the API key. Check that the Maps JavaScript API is enabled and that the key allows this site. A simple schematic map is shown instead.");
  var r = currentRoute();
  if (r) { drawFallbackMap(r); }
};

function clearOverlays() {
  gOverlays.forEach(function (o) { o.setMap(null); });
  gOverlays = [];
}

function polylineStyle(mode) {
  if (mode === "walk") {
    return { strokeOpacity: 0, strokeWeight: 4, icons: [{ icon: { path: "M 0,-1 0,1", strokeOpacity: 1, scale: 3 }, offset: "0", repeat: "12px" }] };
  }
  return { strokeOpacity: 0.95, strokeWeight: mode === "metro" ? 7 : 5 };
}

function addPolyline(mode, path) {
  var style = polylineStyle(mode);
  var opts = { path: path, map: gmap, strokeColor: MODE_META[mode].color, strokeOpacity: style.strokeOpacity, strokeWeight: style.strokeWeight };
  if (style.icons) { style.icons[0].icon.strokeColor = MODE_META[mode].color; opts.icons = style.icons; }
  var line = new google.maps.Polyline(opts);
  gOverlays.push(line);
  return line;
}

function sleep(ms) { return new Promise(function (r) { window.setTimeout(r, ms); }); }

// Ask Google for the road path and distance of one leg. Resolves null if unavailable.
function googleLegRoute(service, leg, travelMode) {
  var ids = leg.stops;
  var waypoints = ids.slice(1, -1).slice(0, 23).map(function (id) { return { location: pointOf(id), stopover: true }; });
  return new Promise(function (resolve) {
    service.route({ origin: pointOf(ids[0]), destination: pointOf(ids[ids.length - 1]), waypoints: waypoints, travelMode: travelMode }, function (result, status) {
      if (status === "OK" && result.routes && result.routes[0]) {
        var rt = result.routes[0];
        var metres = rt.legs.reduce(function (sum, l) { return sum + (l.distance ? l.distance.value : 0); }, 0);
        resolve({ path: rt.overview_path, km: metres / 1000, status: status });
      } else {
        resolve({ path: null, km: null, status: status });
      }
    });
  });
}

function drawGoogleMap(route, key) {
  var token = ++gDrawToken;
  setMapStatus("Loading Google Maps\u2026");
  loadGoogleMaps(key).then(function () {
    if (token !== gDrawToken || state.mapsFailed) { return null; }
    $("#fallbackMap").hidden = true;
    $("#gmap").hidden = false;
    var first = pointOf(route.legs[0].stops[0]);
    if (!gmap) {
      gmap = new google.maps.Map($("#gmap"), { center: first, zoom: 13, mapTypeControl: false, streetViewControl: false });
    }
    clearOverlays();
    var bounds = new google.maps.LatLngBounds();
    var polys = [];

    // 1) Draw straight lines between stops straight away (estimates).
    route.legs.forEach(function (leg, i) {
      var path = leg.stops.map(pointOf);
      path.forEach(function (p) { bounds.extend(p); });
      polys[i] = addPolyline(leg.mode, path);
    });

    // 2) Start and end markers.
    var lastLeg = route.legs[route.legs.length - 1];
    gOverlays.push(new google.maps.Marker({ position: first, map: gmap, label: "A", title: ALL_STOPS[route.legs[0].stops[0]].name }));
    gOverlays.push(new google.maps.Marker({ position: pointOf(lastLeg.stops[lastLeg.stops.length - 1]), map: gmap, label: "B", title: ALL_STOPS[lastLeg.stops[lastLeg.stops.length - 1]].name }));
    gmap.fitBounds(bounds, 48);
    setMapStatus("Google Maps loaded. Checking Google's walking and road distances\u2026");

    // 3) Refine walk and bus legs with the Directions API if it is enabled.
    if (!(google.maps.DirectionsService)) { setMapStatus("Google Maps loaded. Distances are estimates."); return null; }
    var service = new google.maps.DirectionsService();
    var chain = Promise.resolve(), refined = 0, denied = false;
    route.legs.forEach(function (leg, i) {
      if (leg.mode === "metro") { return; }                       // no metro routing from Google here
      chain = chain.then(function () {
        if (token !== gDrawToken || denied) { return null; }
        var mode = leg.mode === "walk" ? google.maps.TravelMode.WALKING : google.maps.TravelMode.DRIVING;   // driving route is a proxy for bus roads
        return googleLegRoute(service, leg, mode).then(function (out) {
          if (token !== gDrawToken) { return null; }
          if (out.path) {
            polys[i].setMap(null);
            gOverlays = gOverlays.filter(function (o) { return o !== polys[i]; });
            polys[i] = addPolyline(leg.mode, out.path);
            out.path.forEach(function (p) { bounds.extend(p); });
            state.mapDist[i] = { km: out.km, source: "google" };
            refined++;
            renderDistances(route);
          } else if (out.status === "REQUEST_DENIED") {
            denied = true;
          }
          return sleep(250);                                      // be gentle with Google's rate limits
        });
      });
    });
    return chain.then(function () {
      if (token !== gDrawToken) { return; }
      gmap.fitBounds(bounds, 48);
      setMapStatus(refined
        ? "Google Maps loaded. Walking and bus distances measured by Google where available."
        : (denied ? "Google Maps loaded. The Directions API isn't enabled for this key, so distances are estimates." : "Google Maps loaded. Distances are estimates."));
    });
  }).catch(function () {
    if (token !== gDrawToken) { return; }
    gmapsPromise = null;
    drawFallbackMap(route);
    setMapStatus("Google Maps couldn't load (check your connection and key). A simple schematic map is shown instead.");
  });
}

function handleMapsKeySubmit(ev) {
  ev.preventDefault();
  var key = $("#mapsKey").value.trim();
  if (!key) { setMapStatus("Paste an API key first, or leave this off to use the schematic map."); return; }
  if (!/^[A-Za-z0-9_\-]{20,80}$/.test(key)) { setMapStatus("That doesn't look like a Google Maps API key. Keys are 30 to 50 letters, numbers, dashes and underscores."); return; }
  var alreadyLoaded = window.google && window.google.maps;
  store.set("mapsKey", key);
  state.mapsFailed = false;
  announce("Google Maps key saved in this browser.");
  if (alreadyLoaded && gmapsPromise === null) {
    setMapStatus("Key saved. Reload the page to apply a different key to the already loaded map.");
  }
  selectMapTrip(state.mapIndex);
}

function handleMapsKeyClear() {
  store.remove("mapsKey");
  $("#mapsKey").value = "";
  state.mapsFailed = false;
  announce("Google Maps key removed.");
  var r = currentRoute();
  if (r) { drawFallbackMap(r); setMapStatus("Key removed. Showing the schematic map. Reload the page to fully unload Google Maps."); }
}


/* =====================================================================
   11. ACCOUNT SCREEN
   ===================================================================== */
function renderAccount() {
  var p = state.profile;
  if (!p) { return; }
  $("#profileList").innerHTML =
    "<dt>Name</dt><dd>" + esc(p.name) + "</dd>" +
    "<dt>Email</dt><dd>" + esc(p.email) + "</dd>" +
    "<dt>Type</dt><dd>" + (p.demo ? "Demo account" : "Local demo profile") + "</dd>" +
    "<dt>Created</dt><dd>" + esc(new Date(p.createdAt).toLocaleDateString("en-IN", { dateStyle: "medium" })) + "</dd>" +
    "<dt>Saved</dt><dd>" + esc(plural(p.places.length, "place") + ", " + plural(p.trips.length, "trip")) + "</dd>";
  $("#fareTable tbody").innerHTML = p.fares.length ? p.fares.map(function (f) {
    return "<tr><td>" + esc(f.date) + "</td><td>" + esc(CITIES[f.cityId] ? CITIES[f.cityId].name : "") + "</td><td>" + esc(f.trip) +
      "</td><td>" + esc(f.modes) + '</td><td class="num">' + esc(fmtRs(f.fare)) + "</td></tr>";
  }).join("") : '<tr><td colspan="5" class="empty">No fare history yet.</td></tr>';
}

function deleteDemoData() {
  if (!window.confirm("Delete all demo data for this profile from this browser and sign out? This can't be undone.")) { return; }
  store.remove(profileKey(state.profile.email));
  store.remove("session");
  state.profile = null;
  state.result = null;
  $("#mainNav").hidden = true;
  showScreen("auth");
  announce("Your demo data was deleted from this browser.");
}


/* =====================================================================
   12. EVENT WIRING AND START-UP
   ===================================================================== */
function setAuthTab(which) {
  var signin = which === "signin";
  $("#tab-signin").setAttribute("aria-selected", String(signin));
  $("#tab-signup").setAttribute("aria-selected", String(!signin));
  $("#tab-signin").tabIndex = signin ? 0 : -1;
  $("#tab-signup").tabIndex = signin ? -1 : 0;
  $("#panel-signin").hidden = !signin;
  $("#panel-signup").hidden = signin;
}

function init() {
  // Navigation
  $$(".nav-btn[data-nav]").forEach(function (b) { b.addEventListener("click", function () { showScreen(b.dataset.nav); }); });
  $("#btnSignOut").addEventListener("click", signOut);
  $("#brandLink").addEventListener("click", function (e) { e.preventDefault(); showScreen(state.profile ? "home" : "auth"); });

  // Error links jump to the field
  document.addEventListener("click", function (e) {
    var a = e.target.closest("a[data-focus]");
    if (!a) { return; }
    e.preventDefault();
    var el = document.getElementById(a.dataset.focus);
    if (el) { el.focus(); }
  });
  document.addEventListener("input", function (e) { if (e.target.removeAttribute) { e.target.removeAttribute("aria-invalid"); } });

  // Auth
  $("#tab-signin").addEventListener("click", function () { setAuthTab("signin"); });
  $("#tab-signup").addEventListener("click", function () { setAuthTab("signup"); });
  $(".tabs").addEventListener("keydown", function (e) {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].indexOf(e.key) === -1) { return; }
    e.preventDefault();
    var next = (e.key === "ArrowLeft" || e.key === "Home") ? "signin" : "signup";
    setAuthTab(next);
    $("#tab-" + next).focus();
  });
  $("#formSignin").addEventListener("submit", handleSignin);
  $("#formSignup").addEventListener("submit", handleSignup);
  $("#btnDemo").addEventListener("click", handleDemo);

  // Home
  $("#btnPlanFromHome").addEventListener("click", function () { showScreen("plan"); });
  $("#placeCity").addEventListener("change", populatePlaceStops);
  $("#formPlace").addEventListener("submit", handleAddPlace);
  $("#screen-home").addEventListener("click", handleHomeClick);
  $("#btnEditPrefs").addEventListener("click", function () {
    showScreen("plan");
    applyPrefsToForm(state.profile.prefs);
    $("#morePrefs").open = true;
  });

  // Plan
  $("#city").addEventListener("change", function () { setPlanCity($("#city").value, false); });
  $("#children").addEventListener("input", renderChildAges);
  $("#btnGps").addEventListener("click", useMyLocation);
  $("#btnUsePrefs").addEventListener("click", function () {
    applyPrefsToForm(state.profile.prefs);
    announce("Your saved preferences were applied.");
  });
  $("#formPlan").addEventListener("submit", handlePlanSubmit);

  // Results and map
  $("#btnBackToPlan").addEventListener("click", function () { showScreen("plan"); });
  $("#routeCards").addEventListener("click", handleResultsClick);
  $("#mapTabs").addEventListener("click", function (e) {
    var b = e.target.closest("[data-map]");
    if (b) { selectMapTrip(Number(b.dataset.map)); }
  });
  $("#formMapsKey").addEventListener("submit", handleMapsKeySubmit);
  $("#btnClearMapsKey").addEventListener("click", handleMapsKeyClear);

  // Account
  $("#btnDeleteData").addEventListener("click", deleteDemoData);

  // Restore an earlier session on this device
  var email = store.get("session", null);
  var profile = email ? loadProfile(email) : null;
  if (profile) {
    state.profile = profile;
    $("#mainNav").hidden = false;
    showScreen("home");
  } else {
    showScreen("auth");
  }
}

document.addEventListener("DOMContentLoaded", init);