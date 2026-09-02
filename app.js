const channelNames = { agency: "Agency", news: "News", flock: "Flock-owned", sponsored: "Sponsored", wire: "Press wire" };
const channelColors = { agency: "#69f0b1", news: "#66d8e9", flock: "#b49cff", sponsored: "#ffbf69", wire: "#ff7e73" };
const caseStatusLabels = { unstarted: "Not started", drafted: "Drafted", submitted: "Submitted", responded: "Response received", closed: "Closed" };
const stanceNames = { promotional: "Promotional", mixed: "Mixed", neutral: "Neutral", critical: "Critical" };
const stanceColors = { promotional: "#ffbf69", mixed: "#b49cff", neutral: "#566560", critical: "#66d8e9" };
const watchTerms = ["credits Flock", "within minutes", "success story", "instrumental", "game changer", "real outcomes", "safer community"];
const stateNames = { AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",CT:"Connecticut",DE:"Delaware",FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",NJ:"New Jersey",NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming",DC:"District of Columbia" };

const state = {
  items: [], evidence: [], agencies: [], outlets: [], records: [], status: {}, days: 30, search: "",
  channels: new Set(Object.keys(channelNames)), disclosure: "all", stance: "all", sort: "newest", lane: null,
  agencySearch: "", agencyState: "all", agencyCoverage: "all",
  caseSearch: "", caseStatus: "all", caseRecords: loadCaseRecords(),
  outletSearch: "", outletType: "all", outletOwnership: "all", newsroomGrouping: "outlet",
  recordSearch: "", recordPlatform: "all",
  timeline: null, granularity: "week"
};
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

/* ---------- safety + performance helpers ---------- */

function escapeHTML(value = "") {
  return String(value).replace(/[&<>'"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[c]);
}
const escapeAttribute = escapeHTML;

// Feed data is third-party input. Escaping alone does not stop a
// javascript: or data: URL from becoming a live link, so schemes are checked
// before anything reaches an href.
function safeURL(value = "") {
  try {
    const parsed = new URL(String(value), window.location.href);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : "";
  } catch {
    return "";
  }
}
function linkAttrs(url) {
  const safe = safeURL(url);
  return safe ? `href="${escapeAttribute(safe)}" target="_blank" rel="noreferrer"` : `href="#" aria-disabled="true" class="dead-link"`;
}

function debounce(fn, ms = 140) {
  let handle;
  return (...args) => { clearTimeout(handle); handle = setTimeout(() => fn(...args), ms); };
}

// buildCases and buildOutletProfiles both walk every signal against 375
// agencies. Rebuilding them on each keystroke made typing in the search box
// visibly stutter, so derived views are cached until the dataset changes.
const memo = new Map();
function cached(key, fn) {
  if (!memo.has(key)) memo.set(key, fn());
  return memo.get(key);
}
function invalidate() { memo.clear(); }

/* ---------- load ---------- */

async function load() {
  const [items, evidence, agencies, outlets, records, status] = await Promise.all([
    fetch("./data/live.json").then(r => r.json()),
    fetch("./data/evidence.json").then(r => r.json()),
    fetch("./data/agencies.json").then(r => r.json()),
    fetch("./data/outlets.json").then(r => r.json()),
    fetch("./data/records.json").then(r => r.json()),
    fetch("./data/status.json").then(r => r.json())
  ]);
  state.timeline = await fetch("./data/timeline.json").then(r => r.json()).catch(() => null);
  state.items = items.map(item => ({ ...item, published: new Date(item.published_at) }));
  state.evidence = evidence;
  state.agencies = agencies.sort((a, b) => a.name.localeCompare(b.name));
  state.outlets = outlets.sort((a, b) => a.name.localeCompare(b.name));
  state.records = records.map(record => ({ ...record, published: new Date(record.published_at) })).sort((a, b) => b.published - a.published);
  state.status = status;
  const updated = new Date(status.updated_at);
  const health = status.queries_total ? `${status.queries_ok}/${status.queries_total} SOURCES` : "HOURLY";
  $("#freshness").textContent = `UPDATED ${formatRelative(updated)} · ${health}`;
  $("#watchTerms").innerHTML = watchTerms.map(term => `<span class="term-chip">${escapeHTML(term)}</span>`).join("");
  bind();
  setupAgencyControls();
  setupOutletControls();
  setupRequestBuilder();
  renderEvidence();
  render();
}

function bind() {
  $$(".topnav button").forEach(button => button.addEventListener("click", () => setView(button.dataset.view)));
  $("#searchInput").addEventListener("input", debounce(e => { state.search = e.target.value.trim().toLowerCase(); renderSignals(); }));
  $$("#timeFilters button").forEach(button => button.addEventListener("click", () => {
    $$("#timeFilters button").forEach(b => b.classList.remove("active"));
    button.classList.add("active");
    state.days = Number(button.dataset.days);
    renderSignals();
  }));
  $$('.filters input[type="checkbox"]').forEach(input => input.addEventListener("change", () => {
    input.checked ? state.channels.add(input.value) : state.channels.delete(input.value);
    renderSignals();
  }));
  $$('.filters input[name="disclosure"]').forEach(input => input.addEventListener("change", () => { state.disclosure = input.value; renderSignals(); }));
  $$('.filters input[name="stance"]').forEach(input => input.addEventListener("change", () => { state.stance = input.value; renderSignals(); }));
  $("#sortSelect").addEventListener("change", e => { state.sort = e.target.value; renderSignals(); });
  $("#clearFilters").addEventListener("click", resetFilters);
  $("#aboutButton").addEventListener("click", () => $("#aboutDialog").showModal());
  $("#evidenceButton").addEventListener("click", () => $("#evidenceDialog").showModal());
  $("#agencySearch").addEventListener("input", debounce(e => { state.agencySearch = e.target.value.trim().toLowerCase(); renderAgencies(); }));
  $("#agencyState").addEventListener("change", e => { state.agencyState = e.target.value; renderAgencies(); });
  $("#agencyCoverage").addEventListener("change", e => { state.agencyCoverage = e.target.value; renderAgencies(); });
  $("#caseSearch").addEventListener("input", debounce(e => { state.caseSearch = e.target.value.trim().toLowerCase(); renderCases(); }));
  $("#caseStatusFilter").addEventListener("change", e => { state.caseStatus = e.target.value; renderCases(); });
  $("#exportSignals").addEventListener("click", () => exportSignals(filteredItems()));
  $("#exportAgencies").addEventListener("click", () => exportAgencies(filteredAgencies()));
  $("#exportCases").addEventListener("click", exportCases);
  $("#outletSearch").addEventListener("input", debounce(e => { state.outletSearch = e.target.value.trim().toLowerCase(); renderNewsrooms(); }));
  $("#outletType").addEventListener("change", e => { state.outletType = e.target.value; renderNewsrooms(); });
  $("#outletOwnership").addEventListener("change", e => { state.outletOwnership = e.target.value; renderNewsrooms(); });
  $$("#newsroomGrouping button").forEach(button => button.addEventListener("click", () => {
    state.newsroomGrouping = button.dataset.grouping;
    $$("#newsroomGrouping button").forEach(b => {
      const active = b === button;
      b.classList.toggle("active", active);
      b.setAttribute("aria-selected", String(active));
    });
    renderNewsrooms();
  }));
  $("#exportOutlets").addEventListener("click", exportOutlets);
  $("#recordSearch").addEventListener("input", debounce(e => { state.recordSearch = e.target.value.trim().toLowerCase(); renderPublicRecords(); }));
  $("#recordPlatform").addEventListener("change", e => { state.recordPlatform = e.target.value; renderPublicRecords(); });
  $("#exportRecords").addEventListener("click", exportRecords);
  $("#shareRecordsForm").addEventListener("submit", sharePublicRecord);
  $$("#pressureGranularity button").forEach(button => button.addEventListener("click", () => {
    state.granularity = button.dataset.granularity;
    $$("#pressureGranularity button").forEach(b => {
      const active = b === button;
      b.classList.toggle("active", active);
      b.setAttribute("aria-selected", String(active));
    });
    renderPressure();
  }));
}

function setView(view) {
  $$(".topnav button").forEach(button => {
    const active = button.dataset.view === view;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  $$("main > .view").forEach(node => {
    const active = node.id === `${view}View`;
    node.hidden = !active;
    node.classList.toggle("active", active);
  });
  if (view === "cases") renderCases();
  if (view === "newsrooms") renderNewsrooms();
  if (view === "pressure") renderPressure();
  if (view === "publicRecords") renderPublicRecords();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function resetFilters() {
  state.days = 30; state.search = ""; state.channels = new Set(Object.keys(channelNames));
  state.disclosure = "all"; state.stance = "all"; state.sort = "newest";
  $("#searchInput").value = "";
  $$("#timeFilters button").forEach(b => b.classList.toggle("active", b.dataset.days === "30"));
  $$('.filters input[type="checkbox"]').forEach(i => i.checked = true);
  $('.filters input[name="disclosure"][value="all"]').checked = true;
  $('.filters input[name="stance"][value="all"]').checked = true;
  $("#sortSelect").value = "newest";
  renderSignals();
}

/* ---------- signals ---------- */

function filteredItems() {
  const newest = state.items.length ? Math.max(...state.items.map(item => item.published.getTime())) : Date.now();
  const cutoff = newest - state.days * 86400000;
  const items = state.items.filter(item => {
    const searchable = `${item.title} ${item.summary} ${item.publisher} ${(item.matched_terms || []).join(" ")}`.toLowerCase();
    const disclosureMatch = state.disclosure === "all" || item.disclosure === state.disclosure;
    const stanceMatch = state.stance === "all" || (item.stance || "neutral") === state.stance;
    return item.published.getTime() >= cutoff && state.channels.has(item.channel) && disclosureMatch && stanceMatch
      && (!state.search || searchable.includes(state.search));
  });
  if (state.sort === "score") items.sort((a, b) => b.promotion_score - a.promotion_score || b.published - a.published);
  else if (state.sort === "reuse") items.sort((a, b) => (b.reuse_containment || 0) - (a.reuse_containment || 0) || b.published - a.published);
  else items.sort((a, b) => b.published - a.published);
  return items;
}

function render() {
  renderSignals();
  renderPressure();
  renderAgencies();
  renderCases();
  renderNewsrooms();
  renderPublicRecords();
}

function renderSignals() {
  renderMetrics();
  const items = filteredItems();
  $("#resultCount").textContent = `${items.length} ${items.length === 1 ? "item" : "items"}`;
  $("#emptyState").hidden = items.length > 0;
  $("#signalFeed").innerHTML = items.map(signalCard).join("");
  $$("[data-signal-agency]").forEach(button => button.addEventListener("click", () => openRequest(button.dataset.signalAgency)));
  renderLanes(items);
  renderCounts();
}

function renderMetrics() {
  const newest = state.items.length ? Math.max(...state.items.map(item => item.published.getTime())) : Date.now();
  const thirty = state.items.filter(item => item.published.getTime() >= newest - 30 * 86400000);
  const lanes = new Set(state.items.map(i => i.reuse_group).filter(Boolean));
  const critical = state.items.filter(i => i.stance === "critical").length;
  const promotional = state.items.filter(i => i.stance === "promotional").length;
  $("#metricSignals").textContent = thirty.length;
  $("#metricAgency").textContent = thirty.filter(i => i.channel === "agency").length;
  $("#metricNews").textContent = thirty.filter(i => i.channel === "news").length;
  $("#metricSponsored").textContent = state.items.filter(i => i.channel === "sponsored").length;
  $("#metricLanes").textContent = lanes.size;
  $("#metricBalance").textContent = critical ? `${promotional}:${critical}` : promotional ? `${promotional}:0` : "—";
  const balanceNote = $("#metricBalanceNote");
  if (balanceNote) {
    balanceNote.textContent = critical
      ? "Promotional vs critical"
      : "No critical coverage collected yet";
    balanceNote.classList.toggle("warn", !critical);
  }
}

function renderCounts() {
  for (const channel of Object.keys(channelNames)) {
    const node = $(`#count${channel[0].toUpperCase()}${channel.slice(1)}`);
    if (node) node.textContent = state.items.filter(i => i.channel === channel).length;
  }
}

function signalCard(item) {
  const meter = Array.from({ length: 5 }, (_, i) => `<i class="${i < item.promotion_score ? "on" : ""}"></i>`).join("");
  const terms = (item.matched_terms || []).slice(0, 3).map(term => `<span class="match-chip">${escapeHTML(term)}</span>`).join("");
  const origins = (item.origin_indicators || []).slice(0, 2).map(term => `<span class="origin-chip">${escapeHTML(term)}</span>`).join("");
  const agency = findAgencyForItem(item);
  const outlet = findOutletForPublisher(item.publisher);
  const owner = outlet && ["news", "sponsored", "wire"].includes(item.channel)
    ? `<span class="owner-badge">${escapeHTML(outlet.ultimate_owner || outlet.owner)}</span>` : "";
  const requestAction = agency
    ? `<button class="inline-action" type="button" data-signal-agency="${escapeAttribute(agency.id)}">Request communications</button>` : "";
  const stance = item.stance || "neutral";
  const reuse = item.reuse_group
    ? `<span class="reuse-chip ${item.reuse_kind === "syndication" ? "syndication" : ""}">${item.reuse_kind === "syndication" ? "Syndicated copy" : "Shared passage"} · ${Math.round((item.reuse_containment || 0) * 100)}%</span>` : "";
  const passage = item.shared_passage
    ? `<blockquote class="shared-passage"><span>TEXT SHARED WITH ANOTHER PUBLISHER · ${item.shared_passage_words} WORDS</span>${escapeHTML(item.shared_passage)}</blockquote>` : "";
  return `<article class="signal-card" style="--channel-color:${channelColors[item.channel] || "#82938e"}">
    <div class="signal-meta"><span class="channel-badge">${channelNames[item.channel] || "Signal"}</span><span>·</span><span>${escapeHTML(item.publisher)}</span>${owner}<span>·</span><time datetime="${escapeAttribute(item.published_at)}">${formatDate(item.published)}</time><span class="disclosure-badge ${escapeAttribute(item.disclosure)}">${disclosureLabel(item)}</span><span class="stance-badge ${escapeAttribute(stance)}">${stanceNames[stance]}</span></div>
    <h2><a ${linkAttrs(item.url)}>${escapeHTML(item.title)}</a></h2>
    <p>${escapeHTML(item.summary || "")}</p>
    ${passage}
    <div class="signal-footer">${terms}${origins}${reuse}${requestAction}<span class="promo-meter" title="Promotional framing score">FRAME ${meter}</span></div>
  </article>`;
}

function disclosureLabel(item) {
  if (item.channel === "sponsored") return "PAID / DISCLOSED";
  if (item.channel === "wire") return "PRESS RELEASE";
  if (item.channel === "flock") return "OWNED MEDIA";
  if (item.channel === "agency") return "AGENCY-ORIGINATED";
  if (item.disclosure === "unknown") return "ORIGIN UNCLEAR";
  return "EDITORIAL";
}

function groupBy(items, keyFn) {
  return items.reduce((groups, item) => { const key = keyFn(item); (groups[key] ||= []).push(item); return groups; }, {});
}

/* ---------- reuse lanes ---------- */

function reuseLanes(items) {
  return Object.entries(groupBy(items.filter(i => i.reuse_group), i => i.reuse_group))
    .filter(([, group]) => group.length > 1)
    .map(([id, group]) => ({
      id,
      group: [...group].sort((a, b) => a.published - b.published),
      kind: group[0].reuse_kind || "reuse",
      publishers: new Set(group.map(i => i.publisher)).size
    }))
    .sort((a, b) => b.group.length - a.group.length);
}

function renderLanes(items) {
  const lanes = reuseLanes(items);
  $("#laneList").innerHTML = lanes.length
    ? lanes.map(lane => `<button type="button" class="cluster-row ${state.lane === lane.id ? "active" : ""}" data-lane="${escapeAttribute(lane.id)}"><strong><span>${lane.kind === "syndication" ? "Syndicated copy" : "Shared passages"}</span><b>${lane.group.length}</b></strong><small>${lane.publishers} publisher${lane.publishers === 1 ? "" : "s"} · ${dateSpan(lane.group)}</small></button>`).join("")
    : '<div class="chain-empty">No verbatim reuse detected in this view. Stories that merely share a topic or a common phrase are deliberately not grouped here.</div>';
  $$(".cluster-row").forEach(button => button.addEventListener("click", () => {
    state.lane = button.dataset.lane;
    renderLanes(items);
  }));
  if (lanes.length && !lanes.some(lane => lane.id === state.lane)) state.lane = lanes[0].id;
  renderChain(lanes.find(lane => lane.id === state.lane)?.group || []);
}

function renderChain(group) {
  if (!group.length) {
    $("#chainView").className = "chain-empty";
    $("#chainView").textContent = "Select a reuse lane to see which publishers ran overlapping text and in what order it was captured.";
    $("#chainConfidence").textContent = "NO LANE SELECTED";
    return;
  }
  const passage = group.find(item => item.shared_passage)?.shared_passage;
  $("#chainConfidence").textContent = "CAPTURE ORDER · NOT PROVENANCE";
  $("#chainView").className = "";
  $("#chainView").innerHTML =
    (passage ? `<blockquote class="shared-passage lane-passage"><span>OVERLAPPING TEXT</span>${escapeHTML(passage)}</blockquote>` : "")
    + group.map((item, i) => {
      const outlet = findOutletForPublisher(item.publisher);
      const owner = outlet ? ` · ${outlet.ultimate_owner || outlet.owner}` : "";
      return `<div class="chain-node"><span>${i === 0 ? "Earliest captured" : `+${daysBetween(group[0].published, item.published)} days`} · ${channelNames[item.channel]}${escapeHTML(owner)}</span><a ${linkAttrs(item.url)}>${escapeHTML(item.publisher)} — ${escapeHTML(item.title)}</a></div>`;
    }).join("")
    + `<p class="chain-caveat">Order reflects when each item was captured and the date its feed reported, not proof of who wrote the text first.</p>`;
}

function renderEvidence() {
  $("#evidencePreview").innerHTML = state.evidence.slice(0, 3).map(item => `<div class="evidence-item"><a ${linkAttrs(item.url)}>${escapeHTML(item.title)}</a><small>${escapeHTML(item.strength)} evidence</small></div>`).join("");
  $("#evidenceLedger").innerHTML = state.evidence.map(item => `<article class="ledger-row"><span>${escapeHTML(item.date)}<br>${escapeHTML(item.type)}</span><div><h3><a ${linkAttrs(item.url)}>${escapeHTML(item.title)}</a></h3><p>${escapeHTML(item.finding)}</p></div><span class="strength">${escapeHTML(item.strength)}</span></article>`).join("");
}

/* ---------- newsrooms ---------- */

function normalizePublisher(value = "") {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function outletIndex() {
  return cached("outletIndex", () => {
    const index = new Map();
    for (const outlet of state.outlets) {
      for (const alias of [outlet.name, ...(outlet.aliases || [])]) {
        index.set(normalizePublisher(alias), outlet);
      }
    }
    return index;
  });
}

function findOutletForPublisher(publisher) {
  return outletIndex().get(normalizePublisher(publisher)) || null;
}

function stanceTally(items) {
  const tally = { promotional: 0, mixed: 0, neutral: 0, critical: 0 };
  for (const item of items) tally[item.stance || "neutral"] = (tally[item.stance || "neutral"] || 0) + 1;
  return tally;
}

function balanceBar(tally, total) {
  if (!total) return "";
  const order = ["promotional", "mixed", "neutral", "critical"];
  const segments = order
    .filter(key => tally[key])
    .map(key => `<i style="--w:${(tally[key] / total) * 100}%;--c:${stanceColors[key]}" title="${tally[key]} ${stanceNames[key].toLowerCase()}"></i>`)
    .join("");
  return `<div class="balance-bar" role="img" aria-label="${order.filter(k => tally[k]).map(k => `${tally[k]} ${stanceNames[k].toLowerCase()}`).join(", ")}">${segments}</div>`;
}

function buildOutletProfiles() {
  return cached("outletProfiles", () => {
    const groups = new Map();
    for (const item of state.items.filter(signal => ["news", "sponsored", "wire"].includes(signal.channel))) {
      const verified = findOutletForPublisher(item.publisher);
      const key = verified?.id || `unresolved-${normalizePublisher(item.publisher).replaceAll(" ", "-")}`;
      if (!groups.has(key)) groups.set(key, {
        id: key,
        name: verified?.name || item.publisher,
        outlet_type: verified?.outlet_type || "Ownership unresolved",
        owner: verified?.owner || "Ownership unresolved",
        ultimate_owner: verified?.ultimate_owner || "Ownership unresolved",
        ownership_source: verified?.ownership_source || "",
        notes: verified?.notes || "No verified ownership source has been added yet.",
        verified_at: verified?.verified_at || "",
        items: [],
        primary_publisher: item.publisher
      });
      groups.get(key).items.push(item);
    }
    return [...groups.values()].map(profile => {
      profile.items.sort((a, b) => b.published - a.published);
      profile.tally = stanceTally(profile.items);
      profile.origin_count = profile.items.reduce((total, item) => total + (item.origin_indicators || []).length, 0);
      profile.reuse_count = profile.items.filter(item => item.reuse_group).length;
      profile.syndicated_count = profile.items.filter(item => item.reuse_kind === "syndication").length;
      profile.paid_count = profile.items.filter(item => item.channel === "sponsored").length;
      profile.wire_count = profile.items.filter(item => item.channel === "wire").length;
      profile.bodies = profile.items.filter(item => item.body_text).length;
      return profile;
    }).sort((a, b) => b.items.length - a.items.length || b.items[0].published - a.items[0].published);
  });
}

function buildOwnerRollup(profiles) {
  const groups = new Map();
  for (const profile of profiles) {
    const key = profile.ultimate_owner || "Ownership unresolved";
    if (!groups.has(key)) groups.set(key, { name: key, outlets: [], items: [] });
    groups.get(key).outlets.push(profile);
    groups.get(key).items.push(...profile.items);
  }
  return [...groups.values()].map(owner => {
    owner.tally = stanceTally(owner.items);
    owner.reuse_count = owner.items.filter(item => item.reuse_group).length;
    owner.paid_count = owner.items.filter(item => item.channel === "sponsored").length;
    owner.origin_count = owner.items.reduce((total, item) => total + (item.origin_indicators || []).length, 0);
    // Copy that appears at two or more properties of the same parent is the
    // station-group syndication signature, and it is what makes a single story
    // look like broad independent interest.
    const lanes = groupBy(owner.items.filter(i => i.reuse_group), i => i.reuse_group);
    owner.internal_lanes = Object.values(lanes)
      .filter(group => new Set(group.map(i => i.publisher)).size > 1).length;
    owner.verified = owner.outlets.some(outlet => outlet.ownership_source);
    return owner;
  }).sort((a, b) => b.items.length - a.items.length);
}

function setupOutletControls() {
  const types = [...new Set(state.outlets.map(outlet => outlet.outlet_type).filter(Boolean))].sort();
  $("#outletType").innerHTML += types.map(type => `<option value="${escapeAttribute(type)}">${escapeHTML(type)}</option>`).join("");
}

function filteredOutletProfiles() {
  return buildOutletProfiles().filter(profile => {
    const searchable = `${profile.name} ${profile.owner} ${profile.ultimate_owner} ${profile.outlet_type} ${profile.items.map(item => item.title).join(" ")}`.toLowerCase();
    const typeMatch = state.outletType === "all" || profile.outlet_type === state.outletType;
    const ownerMatch = state.outletOwnership === "all" || (state.outletOwnership === "verified" ? Boolean(profile.ownership_source) : !profile.ownership_source);
    return (!state.outletSearch || searchable.includes(state.outletSearch)) && typeMatch && ownerMatch;
  });
}

function renderNewsrooms() {
  if (!$("#outletList")) return;
  const all = buildOutletProfiles();
  const visible = filteredOutletProfiles();
  const stories = all.flatMap(profile => profile.items);
  const tally = stanceTally(stories);
  const reused = stories.filter(item => item.reuse_group).length;

  $("#outletStoryTotal").textContent = stories.length;
  $("#outletTotal").textContent = all.length;
  $("#ownerVerified").textContent = all.filter(profile => profile.ownership_source).length;
  $("#outletReuseTotal").textContent = reused;
  $("#outletPaidTotal").textContent = stories.filter(item => item.channel === "sponsored").length;
  $("#outletCriticalTotal").textContent = tally.critical;
  const bodies = stories.filter(item => item.body_text).length;
  $("#bodyCoverage").textContent = stories.length
    ? `Full article text captured for ${bodies} of ${stories.length} stories. Reuse detection on the remainder sees only the feed snippet and will understate overlap.`
    : "No newsroom stories collected yet.";

  if (state.newsroomGrouping === "owner") {
    const owners = buildOwnerRollup(visible);
    $("#outletResultCount").textContent = `${owners.length} ${owners.length === 1 ? "owner" : "owners"}`;
    $("#outletList").innerHTML = owners.length ? owners.map(ownerCard).join("") : '<div class="empty-state">No owners match those filters.</div>';
  } else {
    $("#outletResultCount").textContent = `${visible.length} ${visible.length === 1 ? "outlet" : "outlets"}`;
    $("#outletList").innerHTML = visible.length ? visible.map(outletCard).join("") : '<div class="empty-state">No outlets match those filters.</div>';
  }
  renderOutletLineages();
  $$("[data-outlet-query]").forEach(button => button.addEventListener("click", () => reviewOutletStories(button.dataset.outletQuery)));
}

function outletCard(profile) {
  const source = profile.ownership_source
    ? `<a ${linkAttrs(profile.ownership_source)}>Ownership source</a>`
    : '<span class="ownership-unresolved">Ownership unresolved</span>';
  const recent = profile.items.slice(0, 2).map(item => `<a ${linkAttrs(item.url)}><span>${formatDate(item.published)} · ${disclosureLabel(item)}</span>${escapeHTML(item.title)}</a>`).join("");
  const critical = profile.tally.critical;
  return `<article class="outlet-card">
    <div class="outlet-identity"><span>${escapeHTML(profile.outlet_type)}</span><h2>${escapeHTML(profile.name)}</h2><p>${escapeHTML(profile.owner)}${profile.ultimate_owner !== profile.owner ? ` → ${escapeHTML(profile.ultimate_owner)}` : ""}</p>${source}</div>
    <div class="outlet-measure">
      ${balanceBar(profile.tally, profile.items.length)}
      <div class="outlet-stats">
        <div><strong>${profile.items.length}</strong><span>stories</span></div>
        <div><strong class="${critical ? "" : "zero"}">${critical}</strong><span>critical</span></div>
        <div><strong class="${profile.reuse_count ? "flag" : ""}">${profile.reuse_count}</strong><span>reused text</span></div>
        <div><strong>${profile.paid_count}</strong><span>paid</span></div>
      </div>
    </div>
    <div class="outlet-recent">${recent}</div>
    <button class="row-action" type="button" data-outlet-query="${escapeAttribute(profile.primary_publisher)}">Review stories</button>
  </article>`;
}

function ownerCard(owner) {
  const stations = owner.outlets.length;
  const topOutlets = owner.outlets.slice(0, 4).map(o => escapeHTML(o.name)).join(", ");
  return `<article class="outlet-card owner-card">
    <div class="outlet-identity"><span>${stations} ${stations === 1 ? "property" : "properties"} observed</span><h2>${escapeHTML(owner.name)}</h2><p>${topOutlets}${owner.outlets.length > 4 ? ` +${owner.outlets.length - 4} more` : ""}</p>${owner.verified ? '<span class="ownership-verified">Ownership sourced</span>' : '<span class="ownership-unresolved">Ownership unresolved</span>'}</div>
    <div class="outlet-measure">
      ${balanceBar(owner.tally, owner.items.length)}
      <div class="outlet-stats">
        <div><strong>${owner.items.length}</strong><span>stories</span></div>
        <div><strong class="${owner.tally.critical ? "" : "zero"}">${owner.tally.critical}</strong><span>critical</span></div>
        <div><strong class="${owner.internal_lanes ? "flag" : ""}">${owner.internal_lanes}</strong><span>cross-property</span></div>
        <div><strong>${owner.paid_count}</strong><span>paid</span></div>
      </div>
    </div>
    <div class="outlet-recent"><p class="owner-note">${owner.internal_lanes
      ? `${owner.internal_lanes} ${owner.internal_lanes === 1 ? "story appears" : "stories appear"} at more than one property of this parent. Count those as one story, not several.`
      : "No copy observed running across multiple properties of this parent."}</p></div>
    <button class="row-action" type="button" data-outlet-query="${escapeAttribute(owner.outlets[0]?.primary_publisher || owner.name)}">Review stories</button>
  </article>`;
}

function renderOutletLineages() {
  const lanes = reuseLanes(state.items.filter(item => ["news", "sponsored", "wire"].includes(item.channel))).slice(0, 8);
  $("#outletLineages").innerHTML = lanes.length ? lanes.map(lane => {
    const nodes = lane.group.map(item => {
      const outlet = findOutletForPublisher(item.publisher);
      const owner = outlet ? ` · ${outlet.ultimate_owner || outlet.owner}` : "";
      return `<a ${linkAttrs(item.url)}><span>${escapeHTML(channelNames[item.channel] || item.channel)}${escapeHTML(owner)}</span>${escapeHTML(item.publisher)}</a>`;
    }).join("");
    const passage = lane.group.find(item => item.shared_passage)?.shared_passage;
    return `<article class="lineage-lane"><h3>${lane.kind === "syndication" ? "Syndicated copy" : "Shared passages"} <span>${lane.group.length}</span></h3>${passage ? `<blockquote class="shared-passage">${escapeHTML(passage)}</blockquote>` : ""}${nodes}</article>`;
  }).join("") : '<div class="chain-empty">No overlapping text found between newsroom stories. This panel fills only when two publishers run matching word sequences.</div>';
}

function reviewOutletStories(query) {
  state.search = String(query).toLowerCase();
  $("#searchInput").value = query;
  setView("signals");
  renderSignals();
}


/* ---------- pressure & response ---------- */

function renderPressure() {
  if (!$("#pressureChart")) return;
  const data = state.timeline?.[state.granularity === "month" ? "monthly" : "weekly"];
  if (!data) {
    $("#pressureChart").innerHTML = '<div class="chart-empty">No timeline has been generated yet. It is written by the collector, or locally with <code>npm run reanalyze</code>.</div>';
    $("#pressureFindings").innerHTML = "";
    $("#localEventRows").innerHTML = '<tr><td colspan="5" class="table-empty">No timeline available.</td></tr>';
    return;
  }

  const comparable = data.series.filter(bucket => !bucket.backfill);
  $("#pressureStart").textContent = data.monitoring_started
    ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(`${data.monitoring_started}T00:00:00Z`))
    : "Unknown";
  const provenance = $("#pressureProvenance");
  provenance.textContent = data.provenance === "ok" ? "Collection start" : "No provenance — nothing comparable";
  provenance.classList.toggle("warn", data.provenance !== "ok");

  $("#pressureComparable").textContent = data.periods_comparable;
  $("#pressureBackfill").textContent = `${data.periods_backfill} backfill excluded`;
  $("#pressureEvents").textContent = data.series.reduce((total, b) => total + b.opposition_events, 0);
  $("#pressurePlaces").textContent = state.status.jurisdictions_tagged ?? "—";

  const share = data.share_trend;
  $("#pressureTrend").textContent = share.status === "ok" ? share.direction : "—";
  $("#pressureTrendNote").textContent = share.status === "ok"
    ? `${share.buckets} comparable periods`
    : "Not enough comparable periods";
  $("#pressureTrendNote").classList.toggle("warn", share.status !== "ok");

  const response = data.event_response;
  $("#pressureResponse").textContent = response.status === "ok" && response.ratio ? `${response.ratio}×` : "—";
  $("#pressureResponseNote").textContent = response.status === "ok"
    ? `${response.events_usable} events · ${response.events_rose} rose, ${response.events_fell} fell`
    : `Needs ${response.events_needed || 3} local events`;
  $("#pressureResponseNote").classList.toggle("warn", response.status !== "ok");

  $("#chartSubtitle").textContent = `${data.series.length} ${state.granularity === "month" ? "months" : "weeks"} · ${comparable.length} comparable · ${data.baseline_items ?? 0} baseline items`;
  $("#localWindowNote").textContent = `${response.window_days || 30}-DAY WINDOW`;

  $("#pressureChart").innerHTML = pressureChart(data);
  $("#pressureFindings").innerHTML = pressureFindings(data);
  $("#localEventRows").innerHTML = (response.measured || []).length
    ? response.measured.map(row => `<tr>
        <td><strong>${escapeHTML(row.jurisdiction)}</strong></td>
        <td><time>${escapeHTML(row.event_date)}</time></td>
        <td>${row.before}</td>
        <td>${row.after}</td>
        <td class="${row.change > 0 ? "change-up" : row.change < 0 ? "change-down" : ""}">${row.change > 0 ? "+" : ""}${row.change}</td>
      </tr>`).join("")
    : '<tr><td colspan="5" class="table-empty">No local opposition event yet has a full baseline window inside the monitored period.</td></tr>';
}

// Hand-rolled SVG: no chart library, and the shaded backfill region is part of
// the drawing rather than a caption, so the untrustworthy stretch cannot be
// read as data by someone skimming.
function pressureChart(data) {
  const series = data.series;
  if (!series.length) return '<div class="chart-empty">No periods collected yet.</div>';

  const W = 760, H = 260, padL = 44, padR = 44, padT = 16, padB = 34;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxEvents = Math.max(1, ...series.map(b => b.opposition_events));
  const step = plotW / series.length;
  const x = i => padL + i * step + step / 2;
  const yShare = v => padT + plotH - v * plotH;
  const yBar = v => padT + plotH - (v / maxEvents) * plotH;

  const backfillCount = series.filter(b => b.backfill).length;
  const backfillRect = backfillCount
    ? `<rect x="${padL}" y="${padT}" width="${backfillCount * step}" height="${plotH}" fill="url(#hatch)" />
       <text x="${padL + 6}" y="${padT + 14}" class="axis warn-text">backfill — not comparable</text>`
    : "";

  const bars = series.map((b, i) => b.opposition_events
    ? `<rect x="${x(i) - Math.min(14, step * .34)}" y="${yBar(b.opposition_events)}" width="${Math.min(28, step * .68)}" height="${padT + plotH - yBar(b.opposition_events)}" class="bar ${b.backfill ? "muted" : ""}"><title>${b.period}: ${b.opposition_events} opposition events</title></rect>`
    : "").join("");

  // The line breaks wherever a period is too thin to support a rate, rather
  // than interpolating across a gap that was never measured.
  const segments = [];
  let current = [];
  for (const [i, b] of series.entries()) {
    if (b.promotional_share === null || b.backfill) {
      if (current.length > 1) segments.push(current);
      current = [];
    } else {
      current.push(`${x(i)},${yShare(b.promotional_share)}`);
    }
  }
  if (current.length > 1) segments.push(current);
  const line = segments.map(points => `<polyline points="${points.join(" ")}" class="share-line" />`).join("");
  const dots = series.map((b, i) => b.promotional_share !== null && !b.backfill
    ? `<circle cx="${x(i)}" cy="${yShare(b.promotional_share)}" r="3" class="share-dot"><title>${b.period}: ${Math.round(b.promotional_share * 100)}% promotional (${b.promotional} of ${b.promotional + b.critical + b.mixed})</title></circle>`
    : "").join("");

  const ticks = [0, .25, .5, .75, 1].map(v =>
    `<line x1="${padL}" y1="${yShare(v)}" x2="${W - padR}" y2="${yShare(v)}" class="grid" />
     <text x="${padL - 8}" y="${yShare(v) + 4}" class="axis end">${v * 100}%</text>`).join("");
  const eventTicks = [0, maxEvents].map(v =>
    `<text x="${W - padR + 8}" y="${yBar(v) + 4}" class="axis">${v}</text>`).join("");

  const everyN = Math.max(1, Math.ceil(series.length / 8));
  const labels = series.map((b, i) => i % everyN === 0
    ? `<text x="${x(i)}" y="${H - 10}" class="axis mid">${b.period.slice(5)}</text>` : "").join("");

  return `<svg viewBox="0 0 ${W} ${H}" class="pressure-chart" role="img" aria-label="Opposition events and promotional share over time">
    <defs><pattern id="hatch" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
      <rect width="6" height="6" fill="rgba(255,191,105,.05)" /><line x1="0" y1="0" x2="0" y2="6" stroke="rgba(255,191,105,.18)" stroke-width="1.5" />
    </pattern></defs>
    ${ticks}${backfillRect}${bars}${line}${dots}${eventTicks}${labels}
  </svg>`;
}

// Written as sentences a reader can disagree with, including the sentence that
// says there is not yet enough data — which is the correct output today.
function pressureFindings(data) {
  const cards = [];
  const share = data.share_trend;
  const response = data.event_response;

  // The rate is only meaningful over a sample that was not selected on stance.
  // Without baseline items there is no honest denominator, and saying so is
  // more useful than drawing a line through a number the query mix produced.
  if (!data.baseline_items) {
    cards.push(["unsupported", "No stance-neutral sample yet",
      "Promotional share is computed only from baseline_queries, which contain no stance words. Every other query set searches explicitly for promotional or for critical material, so pooling them would measure the query mix rather than what is being published. Until baseline items are collected, no rate is reported."]);
  }

  if (data.provenance !== "ok") {
    cards.push(["unsupported", "No collection provenance",
      "None of the stored items record when the monitor first saw them, so retrospective discovery cannot be told apart from measurement. Every period is treated as backfill until the collector has run and stamped items itself."]);
  } else if (share.status !== "ok") {
    cards.push(["pending", "Not enough comparable periods",
      `${share.buckets} usable ${share.buckets === 1 ? "period" : "periods"} so far. A direction needs at least four, each with enough coverage to support a rate.`]);
  } else if (share.direction === "rising") {
    cards.push(["supported", "Promotional share is rising",
      `Across ${share.buckets} comparable periods the promotional share moved from ${Math.round(share.first * 100)}% to ${Math.round(share.last * 100)}%. Because this is a share rather than a count, growth in overall Flock coverage does not by itself produce it.`]);
  } else if (share.direction === "falling") {
    cards.push(["contradicted", "Promotional share is falling",
      `Across ${share.buckets} comparable periods the share moved from ${Math.round(share.first * 100)}% to ${Math.round(share.last * 100)}%. This cuts against the hypothesis and should be reported as readily as a rise would be.`]);
  } else {
    cards.push(["neutral", "Promotional share is flat",
      `Across ${share.buckets} comparable periods the share has not moved meaningfully. Raw promotional counts may still be climbing; that would reflect more Flock coverage overall, not a shift in how it is framed.`]);
  }

  if (response.status !== "ok") {
    cards.push(["pending", "Local response unmeasured",
      response.note || `Needs ${response.events_needed || 3} local opposition events with a complete baseline window.`]);
  } else if (response.ratio && response.ratio > 1.2) {
    cards.push(["supported", `Promotional output ${response.ratio}× higher after local pressure`,
      `Across ${response.events_usable} events, promotional items in the same jurisdiction rose from ${response.promotional_before} to ${response.promotional_after} in the ${response.window_days} days after. ${response.events_rose} of ${response.events_usable} rose, ${response.events_fell} fell. Each place is its own control, so national deployment growth cannot explain it — but timing is still not causation, and the records are what would show intent.`]);
  } else if (response.ratio && response.ratio < 0.8) {
    cards.push(["contradicted", "Promotional output falls after local pressure",
      `Across ${response.events_usable} events, promotional items fell from ${response.promotional_before} to ${response.promotional_after}. That is the opposite of the expected pattern.`]);
  } else {
    cards.push(["neutral", "No clear local response",
      `Across ${response.events_usable} events, promotional output was ${response.promotional_before} before and ${response.promotional_after} after. ${response.events_rose} rose and ${response.events_fell} fell, which is close to what chance would produce.`]);
  }

  return cards.map(([tone, title, body]) =>
    `<article class="finding ${tone}"><h3>${escapeHTML(title)}</h3><p>${escapeHTML(body)}</p></article>`).join("");
}

/* ---------- agencies ---------- */


function setupAgencyControls() {
  const states = [...new Set(state.agencies.map(a => a.state).filter(Boolean))].sort();
  $("#agencyState").innerHTML += states.map(code => `<option value="${escapeAttribute(code)}">${escapeHTML(code)} · ${escapeHTML(stateNames[code] || code)}</option>`).join("");
}

function filteredAgencies() {
  return state.agencies.filter(agency => {
    const matchesSearch = !state.agencySearch || `${agency.name} ${agency.jurisdiction} ${agency.state}`.toLowerCase().includes(state.agencySearch);
    const matchesState = state.agencyState === "all" || agency.state === state.agencyState;
    const hasSocials = Boolean(agency.socials?.length);
    const matchesCoverage = state.agencyCoverage === "all" || (state.agencyCoverage === "resolved" ? hasSocials : !hasSocials);
    return matchesSearch && matchesState && matchesCoverage;
  });
}

function renderAgencies() {
  const resolved = state.agencies.filter(a => a.socials?.length).length;
  $("#agencyTotal").textContent = state.agencies.length;
  $("#agencySocialCount").textContent = resolved;
  $("#agencyQueueCount").textContent = state.agencies.length - resolved;
  const agencies = filteredAgencies();
  $("#agencyRows").innerHTML = agencies.length ? agencies.map(agencyRow).join("") : '<tr><td colspan="5" class="table-empty">No agencies match those filters.</td></tr>';
  $$("[data-request-agency]").forEach(button => button.addEventListener("click", () => openRequest(button.dataset.requestAgency)));
}

function openRequest(agencyId) {
  $("#requestAgency").value = agencyId;
  updateRequest();
  loadTrackingForm();
  setView("records");
}

function agencyRow(agency) {
  const accounts = agency.socials?.length
    ? agency.socials.map(s => `<a class="social-pill ${s.verified ? "verified" : "candidate"}" ${linkAttrs(s.url)}>${escapeHTML(s.platform)}${s.verified ? " ✓" : " ?"}</a>`).join("")
    : '<span class="pending-pill">Discovery queued</span>';
  const documented = agency.documented_at ? new Date(`${agency.documented_at}T00:00:00Z`) : null;
  const historical = documented && Date.now() - documented.getTime() > 548 * 86400000;
  const sourceFlag = historical ? '<span class="source-flag historical">Historical · recheck use</span>' : '<span class="source-flag current">Recent disclosure</span>';
  return `<tr>
    <td><strong>${escapeHTML(agency.name)}</strong><small>${escapeHTML(agency.jurisdiction || agency.state || "")}</small></td>
    <td><a ${linkAttrs(agency.confirmation_url)}>${escapeHTML(agency.confirmation_type || "Source")}</a><small>${escapeHTML(agency.documented_at || "Date unavailable")}</small>${sourceFlag}</td>
    <td><div class="social-list">${accounts}</div></td>
    <td><time>${escapeHTML(agency.last_checked || "Pending")}</time></td>
    <td><button class="row-action" type="button" data-request-agency="${escapeAttribute(agency.id)}">Request records</button></td>
  </tr>`;
}

function normalizeAgency(value = "") {
  return String(value).toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(police|department|sheriff|office|public|safety|city|town|village|county|the|of)\b/g, " ")
    .replace(/\s+/g, " ").trim();
}

function agencyIndex() {
  return cached("agencyIndex", () => {
    const byId = new Map();
    const byName = new Map();
    const cores = [];
    for (const agency of state.agencies) {
      byId.set(agency.id, agency);
      const core = normalizeAgency(agency.name);
      if (core.length >= 3) byName.set(core, agency);
      if (core.length >= 4) cores.push({ agency, core });
    }
    cores.sort((a, b) => b.core.length - a.core.length);
    return { byId, byName, cores };
  });
}

function findAgencyForItem(item) {
  const index = agencyIndex();
  if (item.agency_id && index.byId.has(item.agency_id)) return index.byId.get(item.agency_id);
  const publisher = normalizeAgency(item.publisher);
  if (index.byName.has(publisher)) return index.byName.get(publisher);
  const searchable = normalizeAgency(`${item.publisher} ${item.title} ${item.summary || ""}`);
  return index.cores.find(candidate => searchable.includes(candidate.core))?.agency || null;
}

/* ---------- caseboard ---------- */

function buildCases() {
  return cached("cases", () => {
    const grouped = new Map();
    for (const item of state.items) {
      const agency = findAgencyForItem(item);
      if (!agency) continue;
      if (!grouped.has(agency.id)) grouped.set(agency.id, { agency, signals: [] });
      grouped.get(agency.id).signals.push(item);
    }
    for (const agencyId of Object.keys(state.caseRecords)) {
      const agency = state.agencies.find(candidate => candidate.id === agencyId);
      if (agency && !grouped.has(agency.id)) grouped.set(agency.id, { agency, signals: [] });
    }
    return [...grouped.values()].map(entry => {
      entry.signals.sort((a, b) => b.published - a.published);
      const channels = new Set(entry.signals.map(signal => signal.channel));
      const maxFrame = Math.max(0, ...entry.signals.map(signal => signal.promotion_score || 0));
      const agencyOrigin = entry.signals.some(signal => signal.channel === "agency");
      // Verbatim reuse now carries the weight that a shared keyword used to.
      // A department whose post text turns up in a newsroom story is a far
      // stronger records-request candidate than one that merely said "minutes".
      const reused = entry.signals.some(signal => signal.reuse_group);
      const contributions = [
        [Math.min(3, maxFrame), "promotional framing"],
        [Math.min(2, Math.max(0, entry.signals.length - 1)), "repeat coverage"],
        [agencyOrigin ? 2 : 0, "agency-originated post"],
        [reused ? 2 : 0, "text reused by another publisher"],
        [channels.size > 1 ? 1 : 0, `${channels.size} channels`]
      ];
      entry.score = Math.min(10, contributions.reduce((total, [points]) => total + points, 0));
      entry.reasons = contributions.filter(([points]) => points > 0).map(([, label]) => label);
      if (!entry.reasons.length) entry.reasons = ["linked signal"];
      entry.record = state.caseRecords[entry.agency.id] || { status: "unstarted", submitted_at: "", reference: "" };
      return entry;
    }).sort((a, b) => b.score - a.score || (b.signals[0]?.published || 0) - (a.signals[0]?.published || 0));
  });
}

function renderCases() {
  if (!$("#caseList")) return;
  const cases = buildCases();
  const active = cases.filter(item => item.signals.length);
  $("#caseTotal").textContent = active.length;
  $("#caseUnstarted").textContent = active.filter(item => item.record.status === "unstarted").length;
  $("#caseSubmitted").textContent = cases.filter(item => item.record.status === "submitted").length;
  $("#caseResponded").textContent = cases.filter(item => item.record.status === "responded").length;
  const visible = cases.filter(item => {
    const searchable = `${item.agency.name} ${item.agency.state} ${item.signals.map(signal => `${signal.title} ${signal.publisher}`).join(" ")}`.toLowerCase();
    return (!state.caseSearch || searchable.includes(state.caseSearch)) && (state.caseStatus === "all" || item.record.status === state.caseStatus);
  });
  $("#caseList").innerHTML = visible.length ? visible.map(caseCard).join("") : '<div class="empty-state">No cases match those filters.</div>';
  $$("[data-case-request]").forEach(button => button.addEventListener("click", () => openRequest(button.dataset.caseRequest)));
  $$("[data-case-review]").forEach(button => button.addEventListener("click", () => reviewAgencySignals(button.dataset.caseReview)));
  $$("[data-case-status]").forEach(select => select.addEventListener("change", () => updateCaseStatus(select.dataset.caseStatus, select.value)));
}

function caseCard(item) {
  const level = item.score >= 8 ? "high" : item.score >= 5 ? "medium" : "low";
  const signals = item.signals.slice(0, 3).map(signal => `<a ${linkAttrs(signal.url)}><span>${escapeHTML(channelNames[signal.channel] || signal.channel)} · ${formatDate(signal.published)}</span>${escapeHTML(signal.title)}</a>`).join("");
  const noSignals = item.signals.length ? "" : '<div class="case-no-signals">Tracked request · no linked signal in the current dataset</div>';
  return `<article class="case-card">
    <div class="case-score ${level}"><span>PRIORITY</span><strong>${item.score}</strong><small>/ 10</small></div>
    <div class="case-main">
      <div class="case-heading"><div><h2>${escapeHTML(item.agency.name)}</h2><p>${escapeHTML(item.agency.jurisdiction || item.agency.state || "")}</p></div><div class="reason-list">${item.reasons.map(reason => `<span>${escapeHTML(reason)}</span>`).join("")}</div></div>
      <div class="case-signals">${signals}${noSignals}</div>
    </div>
    <div class="case-actions">
      <label>REQUEST STATUS<select data-case-status="${escapeAttribute(item.agency.id)}">${caseStatusOptions(item.record.status)}</select></label>
      ${item.record.submitted_at ? `<small>Submitted ${escapeHTML(item.record.submitted_at)}</small>` : ""}
      ${item.record.reference ? `<small>${escapeHTML(item.record.reference)}</small>` : ""}
      <button type="button" data-case-request="${escapeAttribute(item.agency.id)}">Build request</button>
      ${item.signals.length ? `<button class="quiet" type="button" data-case-review="${escapeAttribute(item.agency.id)}">Review signals</button>` : ""}
    </div>
  </article>`;
}

function caseStatusOptions(selected) {
  return Object.entries(caseStatusLabels).map(([value, label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`).join("");
}

function reviewAgencySignals(agencyId) {
  const agency = state.agencies.find(candidate => candidate.id === agencyId);
  if (!agency) return;
  state.search = normalizeAgency(agency.name).split(" ")[0] || agency.name.toLowerCase();
  $("#searchInput").value = state.search;
  setView("signals");
  renderSignals();
}

function updateCaseStatus(agencyId, status) {
  const existing = state.caseRecords[agencyId] || {};
  state.caseRecords[agencyId] = { ...existing, status, updated_at: new Date().toISOString() };
  persistCaseRecords();
  memo.delete("cases");
  renderCases();
}

/* ---------- public records ---------- */

function filteredPublicRecords() {
  return state.records.filter(record => {
    const searchable = `${record.title} ${record.agency} ${record.state} ${record.summary} ${(record.topics || []).join(" ")}`.toLowerCase();
    return (!state.recordSearch || searchable.includes(state.recordSearch)) && (state.recordPlatform === "all" || record.platform === state.recordPlatform);
  });
}

function renderPublicRecords() {
  if (!$("#recordList")) return;
  const records = filteredPublicRecords();
  $("#recordTotal").textContent = state.records.length;
  $("#muckrockTotal").textContent = state.records.filter(record => record.platform === "MuckRock").length;
  $("#documentCloudTotal").textContent = state.records.filter(record => record.platform === "DocumentCloud").length;
  $("#mediaRecordTotal").textContent = state.records.filter(record => /communication|press|media|messaging|social/i.test((record.topics || []).join(" "))).length;
  $("#recordList").innerHTML = records.length ? records.map(publicRecordCard).join("") : '<div class="empty-state">No public records match those filters.</div>';
}

function publicRecordCard(record) {
  const topics = (record.topics || []).map(topic => `<span>${escapeHTML(topic)}</span>`).join("");
  return `<article class="public-record-card">
    <div class="record-platform ${escapeAttribute(String(record.platform).toLowerCase())}">${escapeHTML(record.platform)}</div>
    <div><div class="record-meta">${escapeHTML(record.agency || "Agency not tagged")}${record.state ? ` · ${escapeHTML(record.state)}` : ""} · ${formatDate(record.published)}</div><h2><a ${linkAttrs(record.url)}>${escapeHTML(record.title)}</a></h2><p>${escapeHTML(record.summary || "")}</p><div class="record-topics">${topics}</div></div>
    <span class="record-status">${escapeHTML(record.status)}</span>
  </article>`;
}

async function sharePublicRecord(event) {
  event.preventDefault();
  const agency = $("#shareAgency").value.trim();
  const recordState = $("#shareState").value.trim().toUpperCase();
  const platform = $("#sharePlatform").value;
  const publicUrl = $("#shareUrl").value.trim();
  const summary = $("#shareSummary").value.trim();
  let parsed;
  try { parsed = new URL(publicUrl); } catch { parsed = null; }
  const allowed = platform === "MuckRock" ? ["muckrock.com", "www.muckrock.com"] : ["documentcloud.org", "www.documentcloud.org"];
  if (!parsed || parsed.protocol !== "https:" || !allowed.includes(parsed.hostname.toLowerCase())) {
    $("#submissionStatus").textContent = `Enter a public https ${platform} URL.`;
    return;
  }
  const title = `Records submission: ${agency}`;
  const body = `### Agency\n${agency}\n\n### State\n${recordState || "Not specified"}\n\n### Public MuckRock or DocumentCloud URL\n${publicUrl}\n\n### What the records contain\n${summary}\n\n### Publication check\nReviewed for sensitive personal information before submission.`;
  const repository = githubRepositoryFromPage();
  if (repository) {
    const issue = `https://github.com/${repository}/issues/new?${new URLSearchParams({ title, body, labels: "records-submission" })}`;
    window.open(issue, "_blank", "noopener,noreferrer");
    $("#submissionStatus").textContent = "Opened a public GitHub review issue. Review it before submitting.";
    return;
  }
  try {
    await navigator.clipboard.writeText(`${title}\n\n${body}`);
    $("#submissionStatus").textContent = "Submission copied. On the GitHub Pages deployment this opens a public review issue automatically.";
  } catch {
    $("#submissionStatus").textContent = "Public review opens automatically from the GitHub Pages deployment.";
  }
}

function githubRepositoryFromPage() {
  const host = window.location.hostname.toLowerCase();
  if (!host.endsWith(".github.io")) return "";
  const owner = host.slice(0, -".github.io".length);
  const firstPath = window.location.pathname.split("/").filter(Boolean)[0];
  return firstPath ? `${owner}/${firstPath}` : `${owner}/${owner}.github.io`;
}

/* ---------- records request builder ---------- */

function setupRequestBuilder() {
  $("#requestAgency").innerHTML = state.agencies.map(a => `<option value="${escapeAttribute(a.id)}">${escapeHTML(a.name)} · ${escapeHTML(a.state || "")}</option>`).join("");
  const end = new Date();
  const start = new Date(end); start.setFullYear(end.getFullYear() - 2);
  $("#requestStart").value = toDateInput(start);
  $("#requestEnd").value = toDateInput(end);
  $("#recordsForm").addEventListener("submit", event => { event.preventDefault(); updateRequest(); });
  $$("#recordsForm input, #recordsForm select").forEach(control => control.addEventListener("change", updateRequest));
  $("#requestAgency").addEventListener("change", loadTrackingForm);
  $("#copyRequest").addEventListener("click", copyRequest);
  $("#fileMuckRock").addEventListener("click", fileWithMuckRock);
  $("#saveTracking").addEventListener("click", saveTracking);
  $("#requestStatus").addEventListener("change", event => {
    if (event.target.value === "submitted" && !$("#requestSubmitted").value) $("#requestSubmitted").value = toDateInput(new Date());
  });
  updateRequest();
  loadTrackingForm();
}

function fileWithMuckRock() {
  window.open("https://www.muckrock.com/foi/create/", "_blank", "noopener,noreferrer");
  copyRequest();
}

function updateRequest() {
  const agency = state.agencies.find(a => a.id === $("#requestAgency").value) || state.agencies[0];
  if (!agency) return;
  const start = $("#requestStart").value || "[Start Date]";
  const end = $("#requestEnd").value || "[End Date]";
  const name = $("#requestName").value.trim() || "[Your Name]";
  const selected = new Set($$(".request-options input:checked").map(i => i.value));
  const paragraphs = [];
  if (selected.has("communications")) paragraphs.push("All emails, text messages, chat messages, calendar invitations, attachments, and other communications between agency personnel and Flock Group Inc., Flock Safety, any person using an @flocksafety.com address, or any public-relations or marketing representative acting for Flock, concerning publicity or public communications.");
  if (selected.has("drafts")) paragraphs.push("All drafts, templates, suggested language, talking points, media guidance, presentations, social-media copy, press releases, public statements, quotes, testimonials, case studies, success stories, or ‘solved stories’ concerning Flock products or an incident in which Flock technology was credited.");
  if (selected.has("news")) paragraphs.push("All communications concerning news pitches, reporter outreach, interviews, press conferences, media events, award submissions, customer-advocacy activities, or requests that the agency provide a quote or participate in publicity about a Flock-related ‘win.’");
  if (selected.has("incentives")) paragraphs.push("All records reflecting discounts, credits, free or reduced-cost equipment or service, contract benefits, referral benefits, grants, reimbursements, or any other thing of value offered or provided in connection with publicity, a testimonial, a case study, a media appearance, or a social-media post.");
  if (selected.has("analytics")) paragraphs.push("All records reflecting metrics, dashboards, reports, or summaries provided by Flock to the agency concerning media coverage, press mentions, social-media reach or engagement, public sentiment, or the performance of any publicity campaign, together with any request from Flock that the agency report such information back to the company.");
  if (selected.has("approvals")) paragraphs.push("All records reflecting review, approval, editing, or advance sharing of agency public statements, press releases, or social-media posts with Flock before publication, and any record reflecting Flock review or approval of an agency employee's public remarks, interview, or testimony.");
  const numbered = paragraphs.map((text, index) => `${index + 1}. ${text}`).join("\n\n");
  const subject = `Public records request — Flock Safety publicity communications — ${agency.name}`;
  const request = `To the Records Custodian for ${agency.name}:\n\nPursuant to the applicable ${stateNames[agency.state] || agency.state || "state"} public-records law, I request electronic copies of the following records created, sent, or received from ${start} through ${end}:\n\n${numbered}\n\nPlease search agency-owned email, text-message, collaboration, records-management, public-information, command-staff, and social-media systems. Relevant search terms include: Flock, Flock Safety, flocksafety.com, success story, solved story, win, media, press, reporter, interview, quote, testimonial, case study, social media, Facebook, Instagram, X, LinkedIn, communications, marketing, public relations, PR, advocacy, announcement, and press conference.\n\nPlease include responsive attachments, embedded images, message metadata, and communications on personal devices or accounts if they concern public business and are subject to disclosure under applicable law. Please produce records in their native electronic format when reasonably available, with metadata intact.\n\nThis request does not seek confidential investigative facts, victim or witness identifying information, information about minors, or other material lawfully exempt from disclosure. Please redact only exempt portions and release all reasonably segregable non-exempt material.\n\nIf estimated fees will exceed $25, please provide a written estimate before processing. I request a fee waiver where available because these records concern the relationship between a public agency and a government vendor and are sought to contribute to public understanding, not for a commercial purpose.\n\nIf no responsive records are located, please identify the custodians, systems, date ranges, and search terms used. If any portion is withheld, please identify the legal basis for each withholding and provide any required denial or exemption log.\n\nPlease acknowledge receipt and provide records on a rolling basis as they become available.\n\nThank you,\n${name}`;
  $("#requestSubject").value = subject;
  $("#requestText").value = request;
  const search = `site:.gov "${agency.name}" ("public records request" OR "open records request" OR FOIA)`;
  $("#recordsSearchLink").href = `https://www.google.com/search?q=${encodeURIComponent(search)}`;
}

async function copyRequest() {
  const text = `Subject: ${$("#requestSubject").value}\n\n${$("#requestText").value}`;
  try {
    await navigator.clipboard.writeText(text);
    $("#copyRequest").textContent = "Copied";
    setTimeout(() => $("#copyRequest").textContent = "Copy text", 1600);
  } catch {
    $("#requestText").focus(); $("#requestText").select();
  }
}

function loadTrackingForm() {
  const agencyId = $("#requestAgency").value;
  const record = state.caseRecords[agencyId] || { status: "unstarted", submitted_at: "", reference: "" };
  $("#requestStatus").value = record.status || "unstarted";
  $("#requestSubmitted").value = record.submitted_at || "";
  $("#requestReference").value = record.reference || "";
}

function saveTracking() {
  const agencyId = $("#requestAgency").value;
  if (!agencyId) return;
  state.caseRecords[agencyId] = {
    status: $("#requestStatus").value,
    submitted_at: $("#requestSubmitted").value,
    reference: $("#requestReference").value.trim(),
    updated_at: new Date().toISOString()
  };
  persistCaseRecords();
  memo.delete("cases");
  renderCases();
  $("#saveTracking").textContent = "Saved";
  setTimeout(() => $("#saveTracking").textContent = "Save to caseboard", 1600);
}

function loadCaseRecords() {
  try {
    const stored = JSON.parse(localStorage.getItem("flockwatch-case-records") || "{}");
    return stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  } catch {
    return {};
  }
}

function persistCaseRecords() {
  try { localStorage.setItem("flockwatch-case-records", JSON.stringify(state.caseRecords)); } catch {}
}

/* ---------- exports ---------- */

function exportSignals(items) {
  downloadCSV("flockwatch-signals.csv", [
    ["published_at", "channel", "publisher", "title", "url", "disclosure", "stance", "promotion_score", "matched_terms", "origin_indicators", "reuse_group", "reuse_kind", "reuse_containment", "shared_passage", "body_captured"],
    ...items.map(item => [item.published_at, item.channel, item.publisher, item.title, item.url, item.disclosure, item.stance || "", item.promotion_score, (item.matched_terms || []).join(" | "), (item.origin_indicators || []).join(" | "), item.reuse_group || "", item.reuse_kind || "", item.reuse_containment ?? "", item.shared_passage || "", item.body_text ? "yes" : "no"])
  ]);
}

function exportAgencies(agencies) {
  downloadCSV("flockwatch-agencies.csv", [
    ["agency", "state", "jurisdiction", "flock_evidence", "evidence_type", "documented_at", "social_accounts", "last_checked"],
    ...agencies.map(agency => [agency.name, agency.state, agency.jurisdiction, agency.confirmation_url, agency.confirmation_type, agency.documented_at, (agency.socials || []).map(social => `${social.platform}: ${social.url}${social.verified ? " [verified]" : " [candidate]"}`).join(" | "), agency.last_checked])
  ]);
}

function exportCases() {
  downloadCSV("flockwatch-caseboard.csv", [
    ["agency", "state", "priority_score", "reasons", "signal_count", "request_status", "submitted_at", "reference", "latest_signal", "latest_signal_url"],
    ...buildCases().map(item => [item.agency.name, item.agency.state, item.score, item.reasons.join(" | "), item.signals.length, caseStatusLabels[item.record.status] || item.record.status, item.record.submitted_at || "", item.record.reference || "", item.signals[0]?.title || "", item.signals[0]?.url || ""])
  ]);
}

function exportOutlets() {
  if (state.newsroomGrouping === "owner") {
    return downloadCSV("flockwatch-owners.csv", [
      ["ultimate_owner", "properties_observed", "stories", "promotional", "mixed", "neutral", "critical", "cross_property_lanes", "disclosed_paid", "origin_flags", "ownership_sourced"],
      ...buildOwnerRollup(filteredOutletProfiles()).map(owner => [owner.name, owner.outlets.length, owner.items.length, owner.tally.promotional, owner.tally.mixed, owner.tally.neutral, owner.tally.critical, owner.internal_lanes, owner.paid_count, owner.origin_count, owner.verified ? "yes" : "no"])
    ]);
  }
  downloadCSV("flockwatch-newsrooms.csv", [
    ["outlet", "outlet_type", "owner", "ultimate_owner", "ownership_source", "stories", "promotional", "mixed", "neutral", "critical", "reused_text", "syndicated", "disclosed_paid", "origin_flags", "full_text_captured", "latest_story", "latest_story_url"],
    ...filteredOutletProfiles().map(profile => [profile.name, profile.outlet_type, profile.owner, profile.ultimate_owner, profile.ownership_source, profile.items.length, profile.tally.promotional, profile.tally.mixed, profile.tally.neutral, profile.tally.critical, profile.reuse_count, profile.syndicated_count, profile.paid_count, profile.origin_count, profile.bodies, profile.items[0]?.title || "", profile.items[0]?.url || ""])
  ]);
}

function exportRecords() {
  downloadCSV("flockwatch-public-records.csv", [
    ["published_at", "platform", "agency", "state", "status", "title", "topics", "url", "summary", "source"],
    ...filteredPublicRecords().map(record => [record.published_at, record.platform, record.agency, record.state, record.status, record.title, (record.topics || []).join(" | "), record.url, record.summary, record.source])
  ]);
}

function downloadCSV(filename, rows) {
  // A leading =, +, - or @ makes a spreadsheet treat the cell as a formula.
  // Newsroom headlines regularly start with a dash.
  const guard = value => {
    const text = String(value ?? "");
    return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  };
  const csv = rows.map(row => row.map(value => `"${guard(value).replaceAll('"', '""')}"`).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/* ---------- formatting ---------- */

function dateSpan(group) {
  const dates = group.map(i => i.published).sort((a, b) => a - b);
  return dates[0].getFullYear() === dates.at(-1).getFullYear()
    ? String(dates[0].getFullYear())
    : `${dates[0].getFullYear()}–${dates.at(-1).getFullYear()}`;
}
function formatDate(date) { return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(date); }
function formatRelative(date) { const hours = Math.max(0, Math.round((Date.now() - date) / 3600000)); return hours < 1 ? "JUST NOW" : hours < 24 ? `${hours}H AGO` : `${Math.floor(hours / 24)}D AGO`; }
function daysBetween(a, b) { return Math.round((b - a) / 86400000); }
function toDateInput(date) { return date.toISOString().slice(0, 10); }

load().catch(error => {
  console.error(error);
  $("#freshness").textContent = "MONITOR DATA UNAVAILABLE";
  $("#signalFeed").innerHTML = '<div class="empty-state">The public dataset could not be loaded. Refresh the page or check the repository status.</div>';
});
