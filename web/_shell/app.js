// Minimal vanilla-JS browser for the bird hierarchy.
// One global `tree` object (loaded from tree.json), hash-based routing.

const $view = document.getElementById("view");
const $crumbs = document.getElementById("crumbs");

let tree = null;
let ROOT_ID = "aves"; // resolved from tree.json on init
// Chunk cache: chunkId → Map<speciesId, heavyData>. Each chunk is fetched
// once on first species-page visit and kept in memory.
const chunkCache = new Map();
const chunkInflight = new Map();

async function loadChunk(chunkId) {
  if (!chunkId) return null;
  if (chunkCache.has(chunkId)) return chunkCache.get(chunkId);
  if (chunkInflight.has(chunkId)) return chunkInflight.get(chunkId);
  const promise = (async () => {
    const res = await fetch(`chunks/${chunkId}.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status} loading chunk ${chunkId}`);
    const data = await res.json();
    chunkCache.set(chunkId, data);
    return data;
  })();
  chunkInflight.set(chunkId, promise);
  try { return await promise; }
  finally { chunkInflight.delete(chunkId); }
}

// Merge skeleton species node with heavy data from its chunk.
async function fullSpecies(id) {
  const light = tree.nodes[id];
  if (!light || light.type !== "species") return light;
  const chunk = await loadChunk(light.chunkId);
  return { ...light, ...(chunk?.[id] || {}) };
}

const RANK_LABEL = {
  root: "Class",
  order: "Order",
  family: "Family",
  genus: "Genus",
  species: "Species",
};

// Commons FilePath URLs auto-resize when you append ?width=NNN. We always go
// through HTTPS even when the source URL is http://.
function thumbUrl(url, width) {
  if (!url) return null;
  // Commons FilePath URLs accept ?width=N for server-side resizing. iNat URLs
  // already specify a size in the path (medium/large/original) so the query
  // string is ignored harmlessly.
  return url.replace(/^http:\/\//, "https://") + `?width=${width}`;
}

// IUCN Red List categories, in the official order from most to least at-risk.
// Each row has the two-letter code, full label, and the standard description
// used as a hover tooltip on the scale.
const IUCN_LADDER = [
  { code: "EX", key: "ex", label: "Extinct",                desc: "No known living individuals.",
    href: "https://en.wikipedia.org/wiki/Extinct_in_the_wild" },
  { code: "EW", key: "ew", label: "Extinct in the Wild",    desc: "Known only to survive in cultivation, in captivity, or as a naturalized population well outside the previous range.",
    href: "https://en.wikipedia.org/wiki/Extinct_in_the_wild" },
  { code: "CR", key: "cr", label: "Critically Endangered",  desc: "Faces an extremely high risk of extinction in the wild.",
    href: "https://en.wikipedia.org/wiki/Critically_endangered" },
  { code: "EN", key: "en", label: "Endangered",             desc: "Faces a very high risk of extinction in the wild.",
    href: "https://en.wikipedia.org/wiki/Endangered_species" },
  { code: "VU", key: "vu", label: "Vulnerable",             desc: "Faces a high risk of extinction in the wild.",
    href: "https://en.wikipedia.org/wiki/Vulnerable_species" },
  { code: "NT", key: "nt", label: "Near Threatened",        desc: "Close to qualifying for, or likely to qualify for, a threatened category in the near future.",
    href: "https://en.wikipedia.org/wiki/Near-threatened_species" },
  { code: "LC", key: "lc", label: "Least Concern",          desc: "Lowest risk; widespread and abundant taxa are included in this category.",
    href: "https://en.wikipedia.org/wiki/Least-concern_species" },
];
const IUCN_AUX = {
  dd: { code: "DD", label: "Data Deficient", desc: "Inadequate information to make an assessment of risk of extinction.",
    href: "https://en.wikipedia.org/wiki/Data_deficient" },
  ne: { code: "NE", label: "Not Evaluated",  desc: "Has not yet been evaluated against the criteria.",
    href: "https://en.wikipedia.org/wiki/IUCN_Red_List" },
};

function normalizeIucn(status) {
  if (!status) return null;
  const s = String(status).toLowerCase();
  const map = [
    [/^lc\b|least concern/, "lc"],
    [/^nt\b|near.?threatened/, "nt"],
    [/^vu\b|vulnerable/, "vu"],
    [/^cr\b|critically endangered/, "cr"],
    [/^en\b|endangered/, "en"],
    [/^ew\b|extinct in the wild/, "ew"],
    [/^ex\b|extinct/, "ex"],
    [/^dd\b|data deficient/, "dd"],
    [/^ne\b|not evaluated/, "ne"],
  ];
  return map.find(([re]) => re.test(s))?.[1] || null;
}

function renderIucn(status, scientificName) {
  const key = normalizeIucn(status);
  if (!key) return "";
  const current = IUCN_LADDER.find((s) => s.key === key);
  const aux = IUCN_AUX[key];
  // Wikipedia-style citation line. [1] links to IUCN's species search so the
  // reader can land on the authoritative page for this taxon.
  const iucnSearch = `https://www.iucnredlist.org/search?query=${encodeURIComponent(scientificName || "")}`;
  const versionLink = `<a href="https://en.wikipedia.org/wiki/IUCN_Red_List#Categories_and_criteria" target="_blank" rel="noopener">IUCN 3.1</a>`;
  const refLink = `<sup><a class="iucn-ref" href="${iucnSearch}" target="_blank" rel="noopener" title="Look up on the IUCN Red List">[1]</a></sup>`;
  // For DD / NE: small standalone pill, not the ladder (those are off-scale).
  if (aux) {
    return `<div class="iucn-block">
      <a class="iucn-aux iucn-${key}" href="${aux.href}" target="_blank" rel="noopener" title="${aux.desc}">${aux.label}</a>
      <span class="iucn-current-label">(${versionLink})${refLink}</span>
    </div>`;
  }
  if (!current) return "";
  // Official IUCN groupings span specific cell counts. We use flex-grow values
  // matching the cell counts so the bracket labels above align perfectly with
  // the ladder underneath.
  const BRACKETS = [
    { label: "Extinct",     span: 2, title: "EX + EW: gone from the wild, or entirely",
      href: "https://en.wikipedia.org/wiki/Extinction" },
    { label: "Threatened",  span: 3, title: "CR + EN + VU: facing extinction risk",
      href: "https://en.wikipedia.org/wiki/Threatened_species" },
    { label: "Lower risk",  span: 2, title: "NT + LC: not currently threatened",
      href: "https://en.wikipedia.org/wiki/Lower_Risk_conservation_status" },
  ];
  const brackets = BRACKETS.map((b) =>
    `<a class="iucn-bracket" style="flex:${b.span}" href="${b.href}" target="_blank" rel="noopener" title="${b.title}">${b.label}</a>`,
  ).join("");
  const steps = IUCN_LADDER.map((s) => {
    const isCurrent = s.key === key;
    return `<a class="iucn-step iucn-${s.key}${isCurrent ? " current" : ""}" href="${s.href}" target="_blank" rel="noopener" title="${s.label} — ${s.desc}">${s.code}</a>`;
  }).join("");
  return `
    <div class="iucn-block" title="IUCN Red List Conservation Status">
      <div class="iucn-brackets">${brackets}</div>
      <div class="iucn-ladder">${steps}</div>
      <div class="iucn-current-label">
        <a href="${current.href}" target="_blank" rel="noopener">${current.label}</a>
        (${versionLink})${refLink}
      </div>
    </div>
  `;
}

// ISO 639-1 → display name. Only the languages we actually fetched, in a
// hand-ordered list so the most-spoken come first.
const LANG_NAMES = {
  es: "Español", fr: "Français", de: "Deutsch", ja: "日本語", zh: "中文",
  pt: "Português", it: "Italiano", ru: "Русский", nl: "Nederlands", pl: "Polski",
  ko: "한국어", ar: "العربية", hi: "हिन्दी", sv: "Svenska", no: "Norsk",
  da: "Dansk", fi: "Suomi", tr: "Türkçe", vi: "Tiếng Việt", id: "Bahasa Indonesia",
  ms: "Bahasa Melayu", th: "ไทย", he: "עברית", el: "Ελληνικά", hu: "Magyar",
  cs: "Čeština", ro: "Română", uk: "Українська", hr: "Hrvatski",
};

function renderAltNames(altNames) {
  if (!altNames) return "";
  // Render as a 2-column grid for compactness. Lang labels in muted color,
  // names in normal color.
  const rows = Object.entries(altNames)
    .sort((a, b) => {
      const ai = Object.keys(LANG_NAMES).indexOf(a[0]);
      const bi = Object.keys(LANG_NAMES).indexOf(b[0]);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    })
    .map(([code, name]) =>
      `<div class="altname-row"><span class="altname-lang">${LANG_NAMES[code] || code}</span><span class="altname-name">${name}</span></div>`,
    )
    .join("");
  return `<h2>Names in other languages <span class="altname-count">${Object.keys(altNames).length}</span></h2><div class="altnames">${rows}</div>`;
}

// AVONET legend mappings (integer codes → human labels). Source: AVONET
// metadata sheet. Hardcoded since the scale is small and stable.
const HABITAT_DENSITY = { 1: "Dense (forest interior)", 2: "Semi-open", 3: "Open" };
const MIGRATION = { 1: "Sedentary", 2: "Partial migrant", 3: "Full migrant" };

function fmtMass(g) {
  if (g == null || g === "") return null;
  const n = Number(g);
  if (!isFinite(n)) return null;
  return n >= 1000 ? `${(n / 1000).toFixed(2)} kg` : `${n.toFixed(1)} g`;
}
function fmtMm(mm) {
  if (mm == null || mm === "") return null;
  const n = Number(mm);
  if (!isFinite(n)) return null;
  return n >= 100 ? `${(n / 10).toFixed(1)} cm` : `${n.toFixed(1)} mm`;
}
function fmtArea(km2) {
  if (km2 == null || km2 === "") return null;
  const n = Number(km2);
  if (!isFinite(n)) return null;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} million km²`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)},${String(Math.round(n) % 1000).padStart(3, "0")} km²`;
  return `${n.toFixed(0)} km²`;
}
function fmtLatLng(lat, lng) {
  if (lat == null || lng == null) return null;
  const a = Number(lat), b = Number(lng);
  if (!isFinite(a) || !isFinite(b)) return null;
  const ns = a >= 0 ? "N" : "S";
  const ew = b >= 0 ? "E" : "W";
  return `${Math.abs(a).toFixed(2)}°${ns}, ${Math.abs(b).toFixed(2)}°${ew}`;
}

// Renders the AVONET traits as labeled rows under semantic group headings.
// Returns "" if no traits — so the calling code doesn't need to branch.
function renderTraits(t, extras) {
  // Wingspan from Wikidata is the only "extra" right now — render the
  // section even when AVONET traits are missing, so a species with only
  // wingspan still gets a Morphology entry.
  if (!t && !extras?.wingspan) return "";
  t = t || {};
  const row = (label, value) =>
    value == null || value === "" || value === "NA"
      ? ""
      : `<div class="trait-row"><span class="trait-label">${label}</span><span class="trait-value">${value}</span></div>`;

  const morph = [
    row("Mass", fmtMass(t.Mass)),
    row("Wing length", fmtMm(t["Wing.Length"])),
    row("Tail length", fmtMm(t["Tail.Length"])),
    row("Tarsus length", fmtMm(t["Tarsus.Length"])),
    row("Beak length (culmen)", fmtMm(t["Beak.Length_Culmen"])),
    row("Beak length (nares)", fmtMm(t["Beak.Length_Nares"])),
    row("Beak width", fmtMm(t["Beak.Width"])),
    row("Beak depth", fmtMm(t["Beak.Depth"])),
    row("Kipps distance", fmtMm(t["Kipps.Distance"])),
    row("Secondary length", fmtMm(t.Secondary1)),
    row("Hand-wing index", t["Hand-Wing.Index"] != null && t["Hand-Wing.Index"] !== "" ? Number(t["Hand-Wing.Index"]).toFixed(1) : null),
    // Wingspan is on the species node, not in traits — passed via `extras`.
    row("Wingspan", extras?.wingspan ? fmtMm(extras.wingspan * 1000) : null),
  ].filter(Boolean).join("");

  const eco = [
    row("Habitat", t.Habitat),
    row("Habitat density", HABITAT_DENSITY[t["Habitat.Density"]] || null),
    row("Migration", MIGRATION[t.Migration] || null),
    row("Trophic level", t["Trophic.Level"]),
    row("Trophic niche", t["Trophic.Niche"]),
    row("Primary lifestyle", t["Primary.Lifestyle"]),
  ].filter(Boolean).join("");

  const latRange =
    t["Min.Latitude"] != null && t["Max.Latitude"] != null
      ? `${Number(t["Min.Latitude"]).toFixed(1)}° to ${Number(t["Max.Latitude"]).toFixed(1)}°`
      : null;
  const geo = [
    row("Range centroid", fmtLatLng(t["Centroid.Latitude"], t["Centroid.Longitude"])),
    row("Latitude band", latRange),
    row("Range size", fmtArea(t["Range.Size"])),
  ].filter(Boolean).join("");

  const section = (title, content) =>
    content ? `<h2>${title}</h2><div class="traits">${content}</div>` : "";

  return section("Morphology", morph) + section("Ecology", eco) + section("Range", geo);
}

// Lookup a species node by its IOC scientific name (used to link sister species
// back into the in-app browse). Could be sped up with a map; 11k nodes is fine
// for the call frequency we'll see (max once per species-page visit).
function speciesByScientificName(name) {
  for (const n of Object.values(tree.nodes)) {
    if (n.type === "species" && n.name === name) return n;
  }
  return null;
}

function renderAudio(a) {
  if (!a || !a.file) return "";
  const meta = [
    a.type,
    a.quality ? `quality ${a.quality}` : null,
    a.length,
    a.country,
  ].filter(Boolean).join(" · ");
  const recordist = a.recordist ? `Recorded by ${a.recordist}` : "Recordist unknown";
  const pageLink = a.pageUrl
    ? `<a href="${a.pageUrl}" target="_blank" rel="noopener">XC${a.id}</a>`
    : `XC${a.id}`;
  const moreText = a.totalRecordings > 1
    ? `${a.totalRecordings} recordings available on xeno-canto`
    : "";
  // Sonogram is a tiny greyscale spectrogram image from xeno-canto — gives a
  // visual fingerprint of the call shape (pitch over time).
  const sono = a.sonogram
    ? `<img class="audio-sono" src="${a.sonogram.replace(/^http:\/\//, "https://")}" alt="Sonogram" loading="lazy" />`
    : "";
  return `
    <div class="audio">
      <audio controls preload="none" src="${a.file}"></audio>
      ${sono}
      <div class="audio-meta">${meta || "&nbsp;"}</div>
      <div class="audio-credit">${recordist} · ${pageLink} · xeno-canto${moreText ? ` · ${moreText}` : ""}</div>
    </div>
  `;
}

function renderSubspecies(list) {
  if (!list?.length) return "";
  // Each row: trinomial + (rare cases) authority + range hints. Range strings
  // can be long — truncate with title attr for hover-to-read.
  const items = list
    .map((s) => {
      const trinomial = s.name;
      const epithet = trinomial.split(" ").slice(2).join(" ");
      const range = s.breedingRange
        ? (s.breedingSubregions ? `${s.breedingRange}: ${s.breedingSubregions}` : s.breedingRange)
        : null;
      return `
        <li>
          <span class="ssp-epithet">${epithet}</span>
          ${s.authority ? `<span class="ssp-authority">${s.authority}</span>` : ""}
          ${range ? `<div class="ssp-range" title="${range.replace(/"/g, "&quot;")}">${range}</div>` : ""}
        </li>`;
    })
    .join("");
  const head = `<h2>Subspecies <span class="ssp-count">${list.length}</span></h2>`;
  return `${head}<ul class="ssp-list">${items}</ul>`;
}

function renderSisters(sisters) {
  if (!sisters || sisters.length === 0) return "";
  const source = sisters[0].source || "birdtree";
  const items = sisters
    .map((s) => {
      const n = speciesByScientificName(s.name);
      if (!n) return null;
      const distance = s.mya != null ? `${s.mya} Mya` : (s.edges != null ? `${s.edges} edges` : "");
      return `<li><a href="#/${n.id}"><em>${n.name}</em>${n.commonName ? ` — ${n.commonName}` : ""}</a>${distance ? ` <span style="color:var(--muted)">(${distance})</span>` : ""}</li>`;
    })
    .filter(Boolean)
    .join("");
  if (!items) return "";
  const note = source === "otol"
    ? "Distance to most-recent common ancestor in tree edges (no branch lengths in Open Tree of Life synthesis)."
    : "Time to most-recent common ancestor in millions of years, from the Jetz et al. global bird phylogeny.";
  return `
    <h2>Closest relatives</h2>
    <p class="sisters-note">${note}</p>
    <ul class="sisters">${items}</ul>
  `;
}

function renderWiki(w) {
  if (!w || !w.extract) return "";
  // Wikipedia content is CC-BY-SA — attribute clearly and link to source.
  return `
    <div class="wiki">
      <p class="wiki-extract">${w.extract}</p>
      <p class="wiki-more">
        <a href="${w.page}" target="_blank" rel="noopener">Read full article on Wikipedia →</a>
      </p>
      <p class="wiki-credit">Text from Wikipedia, CC BY-SA</p>
    </div>
  `;
}

// GBIF "Where & When" section: countries with proportion bars, state hotspots,
// monthly distribution, native/introduced status. Returns "" if no GBIF data
// is available for this species (matched=false or fetcher hasn't run yet).
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const BASIS_LABELS = {
  HUMAN_OBSERVATION: "Human observation",
  OBSERVATION: "Observation",
  PRESERVED_SPECIMEN: "Museum specimen",
  MATERIAL_SAMPLE: "Material sample",
  MACHINE_OBSERVATION: "Sensor / camera trap",
  LIVING_SPECIMEN: "Living specimen",
  FOSSIL_SPECIMEN: "Fossil",
  OCCURRENCE: "Other occurrence",
  LITERATURE: "Literature record",
};

function fmtCount(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}
function countryName(iso) {
  return (countryByIso && countryByIso.get(iso)) || iso;
}

function renderBars(items, total, opts = {}) {
  const { topN = 10, labelFor = (x) => x } = opts;
  const top = items.slice(0, topN);
  return top
    .map((it) => {
      const pct = total > 0 ? (it.count / total) * 100 : 0;
      return `
        <div class="bar-row">
          <span class="bar-label">${labelFor(it.name)}</span>
          <span class="bar-track"><span class="bar-fill" style="width:${pct.toFixed(2)}%"></span></span>
          <span class="bar-count">${fmtCount(it.count)}</span>
        </div>`;
    })
    .join("");
}

function renderMonths(months, total) {
  // Months come back as strings "1".."12". Build a fixed 12-bar chart so we
  // see the year shape even when some months have zero observations.
  const byMonth = Object.fromEntries((months || []).map((m) => [Number(m.name), m.count]));
  const max = Math.max(1, ...Object.values(byMonth));
  return `
    <div class="month-chart">
      ${MONTH_LABELS.map((label, i) => {
        const m = i + 1;
        const count = byMonth[m] || 0;
        const h = (count / max) * 100;
        const pct = total > 0 ? (count / total) * 100 : 0;
        return `
          <div class="month-col" title="${label}: ${count.toLocaleString()} observations (${pct.toFixed(1)}%)">
            <div class="month-bar-track">
              <div class="month-bar-fill" style="height:${h.toFixed(1)}%"></div>
            </div>
            <div class="month-label">${label[0]}</div>
          </div>`;
      }).join("")}
    </div>
  `;
}

// Convert a GeoJSON polygon (an array of linear rings) into an SVG path
// string using the given projector function. Used by renderRangeMap to draw
// each country shape.
function ringToPath(rings, project) {
  return rings
    .map((ring) => {
      const pts = ring.map(([lng, lat]) => {
        const [x, y] = project(lng, lat);
        return `${x.toFixed(1)} ${y.toFixed(1)}`;
      });
      return "M" + pts.join("L") + "Z";
    })
    .join(" ");
}

// Sequential color scale: pale yellow for low counts → deep red-brown for
// high counts. Log-scaled because country observation counts span 6+ orders
// of magnitude (1 vagrant → 27M for Cardinal in the US).
function rangeColor(count, max) {
  if (!count) return "#efe9da";
  const t = Math.log(count + 1) / Math.log(max + 1);
  const hue = 38 - 18 * t;     // 38 (warm yellow) → 20 (deeper orange)
  const sat = 70 + 20 * t;     // 70% → 90%
  const light = 82 - 50 * t;   // 82% → 32%
  return `hsl(${hue} ${sat}% ${light}%)`;
}

function geomToPath(geom, project) {
  if (geom.type === "Polygon") return ringToPath(geom.coordinates, project);
  if (geom.type === "MultiPolygon") return geom.coordinates.map((p) => ringToPath(p, project)).join(" ");
  return "";
}

function renderRangeMap(obs) {
  if (!countriesGeo || !obs?.country?.length) return "";
  const countryCounts = new Map(obs.country.map((c) => [c.name, c.count]));
  // Shared color scale based on country max — states tend to be smaller and
  // sit at lighter shades, which accurately reflects that any single state's
  // observations are a subset of its country's.
  const max = Math.max(...obs.country.map((c) => c.count));

  const W = 720, H = 360;
  const project = (lng, lat) => [((lng + 180) / 360) * W, ((90 - lat) / 180) * H];

  const countryPaths = countriesGeo.features
    .map((f) => {
      const count = countryCounts.get(f.properties.iso) || 0;
      const fill = rangeColor(count, max);
      const d = geomToPath(f.geometry, project);
      const titleAttr = count
        ? `<title>${f.properties.name}: ${count.toLocaleString()} observations</title>`
        : `<title>${f.properties.name}</title>`;
      return `<path d="${d}" fill="${fill}" stroke="#fff" stroke-width="0.4">${titleAttr}</path>`;
    })
    .join("");

  // State/province overlay: GBIF gives us free-text state names; we match by
  // normalized form against Natural Earth's Admin 1. Only states with non-zero
  // counts are drawn — countries with no Admin 1 data (the 165-ish non-federal
  // ones) just show their country fill.
  let statePaths = "";
  if (statesGeo && obs.stateProvince?.length) {
    const stateCounts = new Map();
    for (const s of obs.stateProvince) stateCounts.set(normName(s.name), s.count);
    statePaths = statesGeo.features
      .map((f) => {
        const count = stateCounts.get(normName(f.properties.name));
        if (!count) return null;
        const fill = rangeColor(count, max);
        const d = geomToPath(f.geometry, project);
        return `<path d="${d}" fill="${fill}" stroke="#fff" stroke-width="0.3"><title>${f.properties.name}: ${count.toLocaleString()} observations</title></path>`;
      })
      .filter(Boolean)
      .join("");
  }

  // Legend stops at log-spaced fractions.
  const stops = [0.001, 0.1, 0.5, 1].map((t) => Math.round(Math.pow(max + 1, t) - 1));
  const legendCells = stops
    .map((c) => `<span class="rm-leg-cell" style="background:${rangeColor(c, max)}">${c >= 1000 ? (c / 1000).toFixed(0) + "K" : c}</span>`)
    .join("");

  return `
    <div class="range-map-wrap">
      <svg class="range-map" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
        <g class="rm-countries">${countryPaths}</g>
        <g class="rm-states">${statePaths}</g>
      </svg>
      <div class="range-map-legend">
        <span class="rm-leg-label">observations</span>${legendCells}
      </div>
    </div>
  `;
}

function renderObservations(obs) {
  if (!obs || !obs.total) return "";
  const sections = [];

  sections.push(
    `<div class="obs-total">${obs.total.toLocaleString()} observations recorded</div>`,
  );

  if (obs.country?.length) {
    sections.push(renderRangeMap(obs));
  }

  if (obs.country?.length) {
    sections.push(
      `<h3>Countries</h3><div class="bars">${renderBars(obs.country, obs.total, { topN: 8, labelFor: countryName })}</div>`,
    );
  }
  if (obs.stateProvince?.length) {
    sections.push(
      `<h3>State / province hotspots</h3><div class="bars">${renderBars(obs.stateProvince, obs.total, { topN: 8 })}</div>`,
    );
  }
  if (obs.month?.length) {
    sections.push(`<h3>When observed</h3>${renderMonths(obs.month, obs.total)}`);
  }
  if (obs.establishmentMeans?.length) {
    const total = obs.establishmentMeans.reduce((s, e) => s + e.count, 0);
    sections.push(
      `<h3>Origin status</h3><div class="bars">${renderBars(obs.establishmentMeans, total, { topN: 5 })}</div>`,
    );
  }
  if (obs.basisOfRecord?.length) {
    const total = obs.basisOfRecord.reduce((s, e) => s + e.count, 0);
    sections.push(
      `<h3>How recorded</h3><div class="bars">${renderBars(obs.basisOfRecord, total, { topN: 5, labelFor: (n) => BASIS_LABELS[n] || n })}</div>`,
    );
  }

  return `<h2>Where & when</h2><div class="observations">${sections.join("")}</div>`;
}

function creditFor(n) {
  if (n.imageSource === "inat") {
    return `Photo: ${n.imageAttribution || "iNaturalist"} · via <a href="https://www.inaturalist.org" target="_blank" rel="noopener">iNaturalist</a>`;
  }
  if (n.imageSource === "commons") {
    const artist = n.imageAttribution || "anonymous";
    const lic = n.imageLicense ? ` · ${n.imageLicense}` : "";
    const page = n.imageFilePage || n.image;
    return `Photo: ${artist} · via <a href="${page}" target="_blank" rel="noopener">Wikimedia Commons</a>${lic}`;
  }
  return "";
}

function node(id) {
  return tree.nodes[id];
}

function path(id) {
  const chain = [];
  let cur = node(id);
  while (cur) {
    chain.unshift(cur);
    cur = cur.parent ? node(cur.parent) : null;
  }
  return chain;
}

// Ancestry above the sub-app root so breadcrumbs link back through the
// kingdom/group hierarchy on the landing page (uses landing's hash routes).
const ROOT_ANCESTRY = {
  aves:         [["Living things", "/"], ["Animalia", "/#/animalia"]],
  pinopsida:    [["Living things", "/"], ["Plantae", "/#/plantae"], ["Gymnosperms", "/#/plantae/gymnosperms"]],
  cycadopsida:  [["Living things", "/"], ["Plantae", "/#/plantae"], ["Gymnosperms", "/#/plantae/gymnosperms"]],
  ginkgoopsida: [["Living things", "/"], ["Plantae", "/#/plantae"], ["Gymnosperms", "/#/plantae/gymnosperms"]],
  gnetopsida:   [["Living things", "/"], ["Plantae", "/#/plantae"], ["Gymnosperms", "/#/plantae/gymnosperms"]],
  magnoliaceae: [["Living things", "/"], ["Plantae", "/#/plantae"], ["Angiosperms", "/#/plantae/angiosperms"]],
  lauraceae:    [["Living things", "/"], ["Plantae", "/#/plantae"], ["Angiosperms", "/#/plantae/angiosperms"]],
  arecaceae:    [["Living things", "/"], ["Plantae", "/#/plantae"], ["Angiosperms", "/#/plantae/angiosperms"]],
  quercus:      [["Living things", "/"], ["Plantae", "/#/plantae"], ["Angiosperms", "/#/plantae/angiosperms"]],
  betulaceae:   [["Living things", "/"], ["Plantae", "/#/plantae"], ["Angiosperms", "/#/plantae/angiosperms"]],
  acer:         [["Living things", "/"], ["Plantae", "/#/plantae"], ["Angiosperms", "/#/plantae/angiosperms"]],
  salicaceae:   [["Living things", "/"], ["Plantae", "/#/plantae"], ["Angiosperms", "/#/plantae/angiosperms"]],
  ficus:        [["Living things", "/"], ["Plantae", "/#/plantae"], ["Angiosperms", "/#/plantae/angiosperms"]],
  acacia:       [["Living things", "/"], ["Plantae", "/#/plantae"], ["Angiosperms", "/#/plantae/angiosperms"]],
  rosaceae:     [["Living things", "/"], ["Plantae", "/#/plantae"], ["Angiosperms", "/#/plantae/angiosperms"]],
  myrtaceae:    [["Living things", "/"], ["Plantae", "/#/plantae"], ["Angiosperms", "/#/plantae/angiosperms"]],
  eucalyptus:   [["Living things", "/"], ["Plantae", "/#/plantae"], ["Angiosperms", "/#/plantae/angiosperms"]],
};

function renderCrumbs(id) {
  const chain = path(id);
  const ancestry = ROOT_ANCESTRY[ROOT_ID] || [];
  const ancestryHtml = ancestry.map(([label, href]) => `<a href="${href}">${label}</a>`).join('<span class="sep">›</span>');
  const parts = chain.map((n, i) => {
    const isLast = i === chain.length - 1;
    const label = n.commonName || n.name;
    if (isLast) return `<span class="here">${label}</span>`;
    return `<a href="#/${n.id}">${label}</a>`;
  });
  const ownHtml = parts.join('<span class="sep">›</span>');
  $crumbs.innerHTML = ancestry.length
    ? `${ancestryHtml}<span class="sep">›</span>${ownHtml}`
    : ownHtml;
}

function cardFor(child) {
  // Species nodes have their own image; clade nodes have a precomputed reprImg.
  const img = child.image || child.reprImg || null;
  const isSp = child.type === "species";
  const displayName = child.commonName || child.name;
  const sub = isSp
    ? `<div class="sub italic">${child.name}</div>`
    : `<div class="sub">${child.speciesCount} species</div>`;
  const thumb = img
    ? `<div class="thumb" style="background-image:url('${thumbUrl(img, 320)}')"></div>`
    : `<div class="thumb placeholder">no photo</div>`;
  return `
    <a class="card" href="#/${child.id}">
      ${thumb}
      <div class="info">
        <div class="name">${displayName}</div>
        ${sub}
      </div>
    </a>
  `;
}

function renderClade(n) {
  const rank = RANK_LABEL[n.type];
  const title = n.commonName || n.name;
  const sub = n.commonName && n.commonName !== n.name
    ? `<div class="scientific">${n.name}</div>`
    : "";
  const cards = n.children.map((cid) => cardFor(node(cid))).join("");
  const wikiLink = n.wikiUrl
    ? `<p class="clade-wiki"><a href="${n.wikiUrl}" target="_blank" rel="noopener">See Wikipedia article →</a></p>`
    : "";

  $view.innerHTML = `
    <div class="title-block">
      <div class="rank">${rank}</div>
      <h1>${title}</h1>
      ${sub}
      <div class="meta">${n.children.length} ${n.children[0] ? RANK_LABEL[node(n.children[0]).type].toLowerCase() : ""}${n.children.length === 1 ? "" : "s"} · ${n.speciesCount} species total</div>
      ${wikiLink}
    </div>
    <div class="grid">${cards}</div>
  `;
}

function renderSpecies(n) {
  const parent = node(n.parent);
  const grand = parent && parent.parent ? node(parent.parent) : null;
  const siblings = parent
    ? parent.children.filter((id) => id !== n.id).map((id) => node(id))
    : [];

  // Build a unified photo list. Always include the curated main photo first
  // (so users can return to it after clicking a labeled variant), then any
  // labeled photos we have (Male / Female / Juvenile / Adult), falling back
  // to the older extraPhotos if no labels exist for this species yet.
  const LABEL_TEXT = {
    "adult-male": "Male",
    "adult-female": "Female",
    juvenile: "Juvenile",
    adult: "Adult",
  };
  const LABEL_ORDER = ["adult-male", "adult-female", "juvenile", "adult"];
  const photos = [];
  if (n.image) {
    photos.push({
      url: thumbUrl(n.image, 1024),
      thumbUrl: thumbUrl(n.image, 320),
      credit: creditFor(n),
      label: "Main",
    });
  }
  // iNat attribution strings often already embed the license like
  // "(c) maya5s, some rights reserved (CC BY-NC)" — but not always. Append
  // the license code explicitly so users always see it.
  function iNatCredit(p) {
    const base = p.attribution || "iNaturalist contributor";
    const hasLicenseInAttr = p.attribution && /\(cc[\s-]/i.test(p.attribution);
    const licTail = p.license && !hasLicenseInAttr ? ` · ${p.license.toUpperCase().replace(/-/g, " ")}` : "";
    return `Photo: ${base} · via <a href="https://www.inaturalist.org" target="_blank" rel="noopener">iNaturalist</a>${licTail}`;
  }
  if (n.labeledPhotos) {
    for (const key of LABEL_ORDER) {
      const p = n.labeledPhotos[key];
      if (!p) continue;
      const url = (p.url || "").replace(/^http:\/\//, "https://");
      photos.push({
        url,
        thumbUrl: url,
        credit: iNatCredit(p),
        license: p.license || null,
        label: LABEL_TEXT[key],
      });
    }
  } else if (n.extraPhotos?.length) {
    for (const p of n.extraPhotos) {
      const url = (p.url || "").replace(/^http:\/\//, "https://");
      photos.push({
        url,
        thumbUrl: url,
        credit: iNatCredit(p),
        license: p.license || null,
        label: "",
      });
    }
  }

  let photoBlock;
  if (photos.length === 0) {
    photoBlock = `<div class="photo placeholder">no photo available</div>`;
  } else {
    const main = photos[0];
    const strip = photos.length > 1
      ? `<div class="thumb-strip">${photos
          .map((p, i) => {
            // Tooltip title needs plain text (no HTML) so we can't reuse the
            // rich credit string; build a tidy version here.
            const titleText = (() => {
              if (i === 0 && n.imageSource === "commons") {
                const a = n.imageAttribution || "anonymous";
                return `${a}${n.imageLicense ? " · " + n.imageLicense : ""} · Wikimedia Commons`;
              }
              const a = (p.label ? p.label + " — " : "") + (p.attribution || "iNaturalist contributor");
              return `${a}${p.license ? " · " + p.license.toUpperCase().replace(/-/g, " ") : ""}`;
            })();
            return `<button class="thumb-btn ${p.label ? "labeled" : ""}${i === 0 ? " active" : ""}" data-url="${p.url}" data-credit="${p.credit.replace(/"/g, "&quot;")}" title="${titleText.replace(/"/g, "&quot;")}" aria-label="${p.label || `Photo ${i + 1}`}">
              <img src="${p.thumbUrl}" alt="" loading="lazy" />
              ${p.label ? `<span class="thumb-label">${p.label}</span>` : ""}
            </button>`;
          })
          .join("")}</div>`
      : "";
    photoBlock = `
      <div class="photo"><img id="main-photo" src="${main.url}" alt="${n.commonName || n.name}" loading="lazy" /></div>
      <div class="photo-credit" id="main-credit">${main.credit}</div>
      ${strip}
    `;
  }

  const sibList = siblings.length
    ? siblings
        .map(
          (s) =>
            `<li><a href="#/${s.id}"><em>${s.name}</em>${s.commonName ? " — " + s.commonName : ""}</a></li>`,
        )
        .join("")
    : "<li><em>(only species in genus)</em></li>";

  $view.innerHTML = `
    <div class="title-block">
      <div class="rank">Species</div>
      <h1>${n.commonName || n.name}</h1>
      ${n.commonName ? `<div class="scientific">${n.name}</div>` : ""}
      ${n.synonyms ? `<div class="syn-list">
        ${n.synonyms.ebird ? `<span class="syn-row"><span class="syn-tag">eBird</span><em>${n.synonyms.ebird}</em></span>` : ""}
        ${n.synonyms.birdtree ? `<span class="syn-row"><span class="syn-tag">BirdTree</span><em>${n.synonyms.birdtree}</em></span>` : ""}
      </div>` : ""}
      <div class="external-links">
        ${n.ebird ? `<a href="https://ebird.org/species/${n.ebird}" target="_blank" rel="noopener" title="View on eBird">eBird: <code>${n.ebird}</code> ↗</a>` : ""}
        ${n.inatId
          ? `<a href="https://www.inaturalist.org/taxa/${n.inatId}" target="_blank" rel="noopener" title="View on iNaturalist">iNaturalist ↗</a>`
          : `<a href="https://www.inaturalist.org/search?source%5B%5D=taxa&amp;q=${encodeURIComponent(n.name)}" target="_blank" rel="noopener" title="Search iNaturalist">iNaturalist ↗</a>`}
      </div>
      ${renderIucn(n.iucn, n.name)}
    </div>
    <div class="species-page">
      <div>
        ${photoBlock}
        ${renderAudio(n.audio)}
      </div>
      <div class="details">
        ${renderWiki(n.wiki)}
        ${renderTraits(n.traits, { wingspan: n.wingspan })}
        ${renderObservations(n.observations)}
        ${renderAltNames(n.altNames)}
        ${renderSubspecies(n.subspecies)}
        ${renderSisters(n.sisters)}
        <h2>Taxonomy</h2>
        <ul>
          ${path(n.id)
            .slice(0, -1)
            .map((a) => `<li><a href="#/${a.id}">${a.commonName || a.name}</a> <span style="color:var(--muted)">(${RANK_LABEL[a.type]})</span></li>`)
            .join("")}
        </ul>
        <h2>Other species in <em>${parent.name}</em></h2>
        <ul>${sibList}</ul>
      </div>
    </div>
  `;
}

// --- Nearby (offline geolocation → country → species filter) ----------------
let countriesGeo = null;       // cached GeoJSON
let countryByIso = null;        // iso → display name lookup
let statesGeo = null;           // Admin 1 (states / provinces) for 9 federal countries
let cachedIso = null;           // session cache of resolved country
let cachedState = null;         // session cache of resolved state name
let cachedSource = null;        // "geo" | "manual"

async function loadCountries() {
  if (countriesGeo) return countriesGeo;
  // Absolute path so all sub-apps (/birds/, /trees/) share the one copy at
  // /countries.geojson instead of duplicating per sub-app.
  const res = await fetch("/countries.geojson");
  countriesGeo = await res.json();
  countryByIso = new Map(countriesGeo.features.map((f) => [f.properties.iso, f.properties.name]));
  return countriesGeo;
}

async function loadStates() {
  if (statesGeo) return statesGeo;
  try {
    const res = await fetch("/states.geojson");
    if (!res.ok) return null;
    statesGeo = await res.json();
  } catch { statesGeo = null; }
  return statesGeo;
}

// Lowercase + diacritic-stripped name matching: GBIF returns "São Paulo" or
// "California"; Natural Earth uses similar forms but case/diacritics may
// differ. This normalization covers the common cases.
function normName(s) {
  return String(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

// Ray-casting point-in-polygon. `ring` is an array of [lng, lat] pairs.
function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}
function pointInPolygon(lng, lat, polygon) {
  if (!pointInRing(lng, lat, polygon[0])) return false;
  for (let i = 1; i < polygon.length; i++) if (pointInRing(lng, lat, polygon[i])) return false;
  return true;
}
function countryAt(lng, lat) {
  for (const f of countriesGeo.features) {
    const g = f.geometry;
    if (g.type === "Polygon" && pointInPolygon(lng, lat, g.coordinates)) return f.properties;
    if (g.type === "MultiPolygon") {
      for (const poly of g.coordinates) {
        if (pointInPolygon(lng, lat, poly)) return f.properties;
      }
    }
  }
  return null;
}

// Sub-national resolution. statesGeo only covers 9 federal countries (US, CA,
// BR, RU, IN, CN, ID, AU, ZA); returns null elsewhere. State names are messy
// free-text (e.g., "British Columbia") — we use them directly as keys against
// the species' stateProvince annotations.
function stateAt(lng, lat) {
  if (!statesGeo) return null;
  for (const f of statesGeo.features) {
    const g = f.geometry;
    if (g.type === "Polygon" && pointInPolygon(lng, lat, g.coordinates)) return f.properties;
    if (g.type === "MultiPolygon") {
      for (const poly of g.coordinates) {
        if (pointInPolygon(lng, lat, poly)) return f.properties;
      }
    }
  }
  return null;
}

function geolocate() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Geolocation not available"));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(pos.coords),
      (err) => reject(err),
      { timeout: 10000, maximumAge: 3600_000 },
    );
  });
}

function speciesIn(iso, stateName) {
  // States are pre-extracted into the skeleton as a flat name array so we
  // can filter without loading chunks. Country code disambiguates shared
  // names like "Central" across countries.
  const stateKey = stateName ? normName(stateName) : null;
  const out = [];
  for (const n of Object.values(tree.nodes)) {
    if (n.type !== "species") continue;
    if (!n.countries?.includes(iso)) continue;
    if (stateKey) {
      const states = n.states || [];
      if (!states.some((s) => normName(s) === stateKey)) continue;
    }
    out.push(n);
  }
  out.sort((a, b) => (a.commonName || a.name).localeCompare(b.commonName || b.name));
  return out;
}

function renderNearbyResults(iso, source, stateName) {
  const country = countryByIso.get(iso) || iso;
  const matches = speciesIn(iso, stateName);
  const sourceLabel = source === "geo" ? "your location" : "selected country";
  const cards = matches.map((s) => cardFor(s)).join("");
  const countOptions = [...countryByIso.entries()]
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([code, name]) => `<option value="${code}"${code === iso ? " selected" : ""}>${name}</option>`)
    .join("");

  // When viewing a state, offer a quick toggle back to whole-country results.
  const heading = stateName ? `${stateName}, ${country}` : country;
  const broaden = stateName
    ? ` · <a href="#" id="broaden-btn">Show all of ${country} →</a>`
    : "";

  $view.innerHTML = `
    <div class="title-block">
      <div class="rank">Near you</div>
      <h1>${heading}</h1>
      <div class="meta">${matches.length} species recorded here (from ${sourceLabel})${broaden}</div>
    </div>
    <div class="nearby-controls">
      <button id="geo-btn">Use my location</button>
      <select id="country-picker">${countOptions}</select>
    </div>
    ${matches.length === 0
      ? `<p class="nearby-status">No species in our data have observations recorded in ${heading}.</p>`
      : `<div class="grid">${cards}</div>`}
  `;
  document.getElementById("geo-btn").addEventListener("click", () => doLocate("geo"));
  document.getElementById("country-picker").addEventListener("change", (e) => {
    cachedIso = e.target.value;
    cachedState = null;
    cachedSource = "manual";
    renderNearbyResults(cachedIso, cachedSource, null);
  });
  document.getElementById("broaden-btn")?.addEventListener("click", (e) => {
    e.preventDefault();
    cachedState = null;
    renderNearbyResults(cachedIso, cachedSource, null);
  });
}

function renderNearbyShell(status) {
  const countOptions = countryByIso
    ? [...countryByIso.entries()]
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([code, name]) => `<option value="${code}">${name}</option>`)
        .join("")
    : "";
  $view.innerHTML = `
    <div class="title-block">
      <div class="rank">Near you</div>
      <h1>Birds in your area</h1>
    </div>
    <div class="nearby-controls">
      <button id="geo-btn">Use my location</button>
      ${countryByIso ? `<select id="country-picker"><option value="">…or pick a country</option>${countOptions}</select>` : ""}
    </div>
    <div class="nearby-status">${status}</div>
  `;
  document.getElementById("geo-btn").addEventListener("click", () => doLocate("geo"));
  const picker = document.getElementById("country-picker");
  if (picker) {
    picker.addEventListener("change", (e) => {
      if (e.target.value) {
        cachedIso = e.target.value;
        cachedSource = "manual";
        renderNearbyResults(cachedIso, cachedSource);
      }
    });
  }
}

async function doLocate(_source) {
  renderNearbyShell("Detecting your location…");
  try {
    await loadCountries();
    const coords = await geolocate();
    const country = countryAt(coords.longitude, coords.latitude);
    if (!country) {
      renderNearbyShell("Couldn't determine your country from coordinates (you may be at sea or in a region not covered). Try picking a country manually.");
      return;
    }
    // If we have sub-national data for this country, resolve down to state.
    const state = stateAt(coords.longitude, coords.latitude);
    cachedIso = country.iso;
    cachedState = state?.name || null;
    cachedSource = "geo";
    renderNearbyResults(cachedIso, cachedSource, cachedState);
  } catch (err) {
    renderNearbyShell(`Location lookup failed: ${err.message}. Pick a country manually.`);
  }
}

async function renderNearby() {
  $crumbs.innerHTML = '<span class="here">Near you</span>';
  await loadCountries();
  if (cachedIso) {
    renderNearbyResults(cachedIso, cachedSource, cachedState);
  } else {
    renderNearbyShell("Tap “Use my location” for an offline lookup, or pick a country below.");
  }
  window.scrollTo(0, 0);
}

function wireThumbStrip() {
  // The main photo is always represented by the first .active thumb. Clicking
  // any thumb swaps it in and updates the credit line.
  const strip = document.querySelector(".thumb-strip");
  if (!strip) return;
  const main = document.getElementById("main-photo");
  const credit = document.getElementById("main-credit");
  if (!main) return;
  strip.addEventListener("click", (e) => {
    const btn = e.target.closest(".thumb-btn");
    if (!btn) return;
    main.src = btn.dataset.url;
    if (credit) credit.innerHTML = btn.dataset.credit;
    strip.querySelectorAll(".thumb-btn.active").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
  });
}

// Source descriptions. Each block is a string of HTML; the about page picks
// only the ones relevant to the current taxon. Keeps the page from claiming
// we use AVONET on the conifer app, etc.
const SOURCES = {
  ioc: `<li><strong>IOC World Bird List v15.2</strong> — scientific names, common names, families, orders, subspecies. Licensed <a href="https://creativecommons.org/licenses/by/3.0/" target="_blank" rel="noopener">CC BY 3.0</a>. <a href="https://www.worldbirdnames.org/" target="_blank" rel="noopener">worldbirdnames.org</a></li>`,
  gbifTaxonomy: `<li><strong>GBIF Backbone Taxonomy</strong> — species list, accepted scientific names, family/genus hierarchy. <a href="https://www.gbif.org/dataset/d7dddbf4-2cf0-4f39-9b2a-bb099caae36c" target="_blank" rel="noopener">CC BY 4.0</a>.</li>`,
  wikidata: `<li><strong>Wikidata</strong> — multilingual common names, IUCN status (P141), taxon-image links (P18). CC0. <a href="https://www.wikidata.org/" target="_blank" rel="noopener">wikidata.org</a></li>`,
  ebird: `<li><strong>eBird / Clements Checklist v2025</strong> — eBird species codes (e.g. <code>norcar</code>). Cornell Lab of Ornithology; used per their non-commercial terms. <a href="https://www.birds.cornell.edu/clementschecklist/" target="_blank" rel="noopener">clementschecklist</a></li>`,
  avonet: `<li><strong>AVONET</strong> — morphology (mass, wing length, beak dimensions, etc.), habitat, lifestyle, range size. Tobias, J. A. et al. (2022). <em>Ecology Letters</em> 25(3), 581–597. <a href="https://doi.org/10.1111/ele.13898" target="_blank" rel="noopener">DOI</a>. <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>.</li>`,
  gbifOccurrences: `<li><strong>GBIF</strong> (Global Biodiversity Information Facility) — country / state / month / year / origin observation distributions, elevation. Aggregated facets only. Source datasets vary (mostly CC0 / CC BY). <a href="https://www.gbif.org/" target="_blank" rel="noopener">gbif.org</a></li>`,
  birdtree: `<li><strong>BirdTree.org</strong> (Jetz et al. 2012) — global bird phylogeny for sister-species + divergence times in Mya. Free non-commercial with citation. Jetz, W. et al. (2012). <em>Nature</em>, 491, 444–448. <a href="https://doi.org/10.1038/nature11631" target="_blank" rel="noopener">DOI</a>.</li>`,
  otol: `<li><strong>Open Tree of Life</strong> — synthesis tree for sister-species (fallback or primary). CC0 data. <a href="https://tree.opentreeoflife.org/" target="_blank" rel="noopener">tree.opentreeoflife.org</a></li>`,
  wikipedia: `<li><strong>Wikipedia</strong> — species summaries shown on each detail page. <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener">CC BY-SA 4.0</a>. Each summary links back to the source article.</li>`,
  commons: `<li><strong>Wikimedia Commons</strong> — primary photo for most species, sourced via Wikidata's P18 property. Photos are individually CC-licensed; the per-photo credit links to the source file with full attribution. <a href="https://commons.wikimedia.org/" target="_blank" rel="noopener">commons.wikimedia.org</a></li>`,
  inat: `<li><strong>iNaturalist</strong> — gap-fill photos and (where annotated) labeled photos by sex/life stage. Filtered to CC-licensed only; ARR and ND variants excluded. <a href="https://www.inaturalist.org/" target="_blank" rel="noopener">inaturalist.org</a></li>`,
  xenocanto: `<li><strong>xeno-canto</strong> — bird recordings and spectrograms. Each recording is individually CC-licensed (mostly CC BY-NC). Recordist + license shown in the credit line beneath the player. <a href="https://xeno-canto.org/" target="_blank" rel="noopener">xeno-canto.org</a></li>`,
  naturalEarth: `<li><strong>Natural Earth</strong> — country boundaries and Admin 1 subdivisions used for the heatmap and "Near me" feature. Public domain. <a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener">naturalearthdata.com</a></li>`,
};

// Which source ids apply to which taxon root.
const TAXON_SOURCES = {
  aves: {
    "Taxonomy & names":           ["ioc", "wikidata", "ebird"],
    "Morphology, ecology & range":["avonet", "gbifOccurrences"],
    "Phylogeny":                  ["birdtree", "otol"],
    "Text":                       ["wikipedia"],
    "Photos":                     ["commons", "inat"],
    "Audio":                      ["xenocanto"],
    "Maps":                       ["naturalEarth"],
  },
  pinopsida: {
    "Taxonomy & names":           ["gbifTaxonomy", "wikidata"],
    "Range":                      ["gbifOccurrences"],
    "Phylogeny":                  ["otol"],
    "Text":                       ["wikipedia"],
    "Photos":                     ["commons", "inat"],
    "Maps":                       ["naturalEarth"],
  },
  quercus: {
    "Taxonomy & names":           ["gbifTaxonomy", "wikidata"],
    "Range":                      ["gbifOccurrences"],
    "Phylogeny":                  ["otol"],
    "Text":                       ["wikipedia"],
    "Photos":                     ["commons", "inat"],
    "Maps":                       ["naturalEarth"],
  },
  arecaceae: {
    "Taxonomy & names":           ["gbifTaxonomy", "wikidata"],
    "Range":                      ["gbifOccurrences"],
    "Phylogeny":                  ["otol"],
    "Text":                       ["wikipedia"],
    "Photos":                     ["commons", "inat"],
    "Maps":                       ["naturalEarth"],
  },
  acer: {
    "Taxonomy & names":           ["gbifTaxonomy", "wikidata"],
    "Range":                      ["gbifOccurrences"],
    "Phylogeny":                  ["otol"],
    "Text":                       ["wikipedia"],
    "Photos":                     ["commons", "inat"],
    "Maps":                       ["naturalEarth"],
  },
  eucalyptus: {
    "Taxonomy & names":           ["gbifTaxonomy", "wikidata"],
    "Range":                      ["gbifOccurrences"],
    "Phylogeny":                  ["otol"],
    "Text":                       ["wikipedia"],
    "Photos":                     ["commons", "inat"],
    "Maps":                       ["naturalEarth"],
  },
};

function renderAbout() {
  $crumbs.innerHTML = '<span class="here">About</span>';
  const root = tree.nodes[ROOT_ID];
  const rootName = root?.commonName || root?.name || "Living things";
  const groups = TAXON_SOURCES[ROOT_ID] || TAXON_SOURCES.aves;
  const sectionHtml = Object.entries(groups)
    .map(([heading, ids]) => {
      const items = ids.map((id) => SOURCES[id]).filter(Boolean).join("");
      if (!items) return "";
      return `<h2>${heading}</h2><ul>${items}</ul>`;
    })
    .join("");

  $view.innerHTML = `
    <div class="title-block">
      <div class="rank">About</div>
      <h1>Data sources &amp; credits</h1>
      <div class="meta">${rootName} — open-source, non-commercial. The app combines data from many contributors, each licensed and credited below.</div>
    </div>
    <section class="about">
      ${sectionHtml}
      <h2>This app</h2>
      <p>Source code under MIT licence. Wikipedia text remains CC BY-SA 4.0; other data follows the licences listed above with attribution preserved on each species page.</p>
      <p>Built for personal, non-commercial use. Data was fetched once at build time and is shipped as static JSON + downloaded media.</p>
    </section>
  `;
  window.scrollTo(0, 0);
}

async function route() {
  const id = (location.hash.replace(/^#\//, "") || ROOT_ID).trim();
  if (id === "about") { renderAbout(); return; }
  if (id === "nearby") { renderNearby(); return; }
  const n = node(id);
  if (!n) {
    const rootName = tree.nodes[ROOT_ID]?.commonName || tree.nodes[ROOT_ID]?.name || "root";
    $view.innerHTML = `<p>Unknown node: <code>${id}</code>. <a href="#/${ROOT_ID}">Back to ${rootName}</a>.</p>`;
    $crumbs.innerHTML = "";
    return;
  }
  renderCrumbs(id);
  if (n.type === "species") {
    $view.innerHTML = `<div class="loading">Loading…</div>`;
    const full = await fullSpecies(id);
    if ((location.hash.replace(/^#\//, "") || ROOT_ID).trim() !== id) return;
    renderSpecies(full);
    wireThumbStrip();
  } else renderClade(n);
  window.scrollTo(0, 0);
}

window.addEventListener("hashchange", route);

// --- Search -------------------------------------------------------------
let searchIndex = null;
const RANK_PLURAL = { root: "", order: "order", family: "family", genus: "genus", species: "" };

function buildSearchIndex() {
  // One entry per node (species + every clade level). Stored lowercased so
  // the per-keystroke search can do plain indexOf without re-lowering.
  const idx = [];
  for (const n of Object.values(tree.nodes)) {
    idx.push({
      id: n.id,
      type: n.type,
      sci: n.name,
      common: n.commonName || "",
      sciLower: n.name.toLowerCase(),
      commonLower: (n.commonName || "").toLowerCase(),
    });
  }
  return idx;
}

function doSearch(q, limit = 12) {
  const ql = q.toLowerCase().trim();
  if (!ql) return [];
  const out = [];
  for (const e of searchIndex) {
    let score = Infinity;
    if (e.commonLower) {
      if (e.commonLower === ql) score = 0;
      else if (e.commonLower.startsWith(ql)) score = 1;
      else { const i = e.commonLower.indexOf(ql); if (i >= 0) score = 10 + i; }
    }
    if (e.sciLower === ql) score = Math.min(score, 0);
    else if (e.sciLower.startsWith(ql)) score = Math.min(score, 2);
    else { const i = e.sciLower.indexOf(ql); if (i >= 0) score = Math.min(score, 20 + i); }
    if (!isFinite(score)) continue;
    out.push({ entry: e, score });
  }
  out.sort((a, b) => a.score - b.score);
  return out.slice(0, limit).map((r) => r.entry);
}

function wireSearch() {
  const $input = document.getElementById("search-input");
  const $list = document.getElementById("search-results");
  if (!$input || !$list) return;

  function render(q) {
    const results = doSearch(q);
    if (results.length === 0) {
      $list.hidden = true;
      $list.innerHTML = "";
      return;
    }
    $list.innerHTML = results
      .map((e) => {
        const rank = RANK_PLURAL[e.type];
        const primary = e.common || e.sci;
        const secondary = e.common
          ? `<span class="search-sci">${e.sci}</span>`
          : "";
        const rankTag = rank ? `<span class="search-rank">${rank}</span>` : "";
        return `<a class="search-item" href="#/${e.id}" data-id="${e.id}">
          <span class="search-name">${primary}</span>${secondary}${rankTag}
        </a>`;
      })
      .join("");
    $list.hidden = false;
  }

  $input.addEventListener("input", (e) => render(e.target.value));
  $input.addEventListener("focus", (e) => { if (e.target.value) render(e.target.value); });
  // Click on a result fires the href navigation naturally; we just clear UI.
  $list.addEventListener("click", (e) => {
    const link = e.target.closest(".search-item");
    if (!link) return;
    $input.value = "";
    $list.hidden = true;
  });
  // Hide after blur, with a delay long enough for an in-progress click on a
  // result to fully fire first.
  $input.addEventListener("blur", () => {
    setTimeout(() => { $list.hidden = true; }, 200);
  });
  $input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { $input.value = ""; $list.hidden = true; $input.blur(); }
  });
}

(async function init() {
  // Load countries + states up-front for the heatmap. countries.geojson is
  // ~250 KB; states.geojson is ~1.5 MB. Both cache on first load and unlock
  // the per-species range map on every detail page.
  const [treeRes] = await Promise.all([fetch("tree.json"), loadCountries(), loadStates()]);
  tree = await treeRes.json();
  // The root is the only node with parent: null. Resolving from data instead
  // of hardcoding lets the same SPA serve birds (aves) and conifers (pinopsida).
  for (const [id, n] of Object.entries(tree.nodes)) {
    if (n.parent == null) { ROOT_ID = id; break; }
  }
  // Top nav "All …" link points to whichever root we found.
  const allLink = document.querySelector('#nav a[href="#/aves"]');
  if (allLink) {
    allLink.setAttribute("href", `#/${ROOT_ID}`);
    const root = tree.nodes[ROOT_ID];
    allLink.textContent = root?.commonName ? `All ${root.commonName.toLowerCase()}` : `All ${root?.name || "taxa"}`;
  }
  searchIndex = buildSearchIndex();
  wireSearch();
  route();
})();
