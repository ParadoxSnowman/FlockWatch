// Boots index.html + app.js in jsdom against the real data files and walks
// every view, so a broken selector or a bad render fails here instead of on
// GitHub Pages.
import { readFileSync } from "node:fs";
import { JSDOM, VirtualConsole } from "jsdom";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];

const virtualConsole = new VirtualConsole();
virtualConsole.on("jsdomError", e => errors.push(`jsdom: ${e.message}`));
virtualConsole.on("error", (...a) => errors.push(`console.error: ${a.join(" ")}`));

const dom = new JSDOM(readFileSync(join(root, "index.html"), "utf8"), {
  runScripts: "outside-only",
  url: "https://example.github.io/flockwatch/",
  virtualConsole,
});
const { window } = dom;

// Minimal fetch over the local data directory.
window.fetch = async path => {
  const file = join(root, String(path).replace("./", ""));
  const text = readFileSync(file, "utf8");
  return { json: async () => JSON.parse(text), ok: true };
};
window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
window.HTMLDialogElement.prototype.close = function () { this.open = false; };
window.URL.createObjectURL = () => "blob:test";
window.URL.revokeObjectURL = () => {};
window.scrollTo = () => {};
Object.defineProperty(window.navigator, "clipboard", { value: { writeText: async () => {} }, configurable: true });

const code = readFileSync(join(root, "app.js"), "utf8").replace(/^\s*load\(\)\.catch[\s\S]*$/m, "");
window.eval(code);

const $ = s => window.document.querySelector(s);

try {
  await window.eval("load()");
} catch (error) {
  errors.push(`load() threw: ${error.message}\n${error.stack}`);
}

const checks = [];
function check(name, condition, detail = "") {
  checks.push({ name, pass: Boolean(condition), detail });
}

check("signal feed rendered", $("#signalFeed").children.length > 0, `${$("#signalFeed").children.length} cards`);
check("freshness set", !$("#freshness").textContent.includes("UNAVAILABLE"), $("#freshness").textContent);
check("signals metric numeric", /^\d+$/.test($("#metricSignals").textContent), $("#metricSignals").textContent);
check("reuse lane metric numeric", /^\d+$/.test($("#metricLanes").textContent), $("#metricLanes").textContent);
check("balance metric present", $("#metricBalance").textContent.length > 0, $("#metricBalance").textContent);
check("agency rows rendered", $("#agencyRows").children.length > 0, `${$("#agencyRows").children.length} rows`);
check("agency total", $("#agencyTotal").textContent === "375", $("#agencyTotal").textContent);
check("request draft built", $("#requestText").value.includes("Records Custodian"), `${$("#requestText").value.length} chars`);

// Walk every view the way a user would.
for (const view of ["newsrooms", "pressure", "agencies", "cases", "publicRecords", "records", "signals"]) {
  try {
    window.eval(`setView(${JSON.stringify(view)})`);
  } catch (error) {
    errors.push(`setView(${view}) threw: ${error.message}`);
  }
}
check("newsroom outlet list populated", $("#outletList").children.length > 0, `${$("#outletList").children.length}`);
check("body coverage note written", $("#bodyCoverage").textContent.length > 10, $("#bodyCoverage").textContent.slice(0, 60));
check("caseboard populated", $("#caseList").children.length > 0, `${$("#caseList").children.length}`);
check("public records populated", $("#recordList").children.length > 0, `${$("#recordList").children.length}`);

// Pressure view: the chart must draw and the findings must state a position,
// including "not enough data", which is the correct answer today.
window.eval('setView("pressure")');
check("pressure chart drawn", /<svg|chart-empty/.test($("#pressureChart").innerHTML), "");
check("findings rendered", $("#pressureFindings").children.length >= 2, `${$("#pressureFindings").children.length} cards`);
check("monitoring start reported", $("#pressureStart").textContent.length > 0, $("#pressureStart").textContent);
check("backfill counted", /backfill/.test($("#pressureBackfill").textContent), $("#pressureBackfill").textContent);
// With no provenance the tool must refuse, not estimate.
check("refuses without provenance", /Not enough|No collection provenance|unmeasured/.test($("#pressureFindings").textContent), "");
check("local event table has a state", $("#localEventRows").children.length > 0, "");
try {
  window.document.querySelector('#pressureGranularity button[data-granularity="month"]').click();
  check("monthly toggle works", /<svg|chart-empty/.test($("#pressureChart").innerHTML), "");
  window.document.querySelector('#pressureGranularity button[data-granularity="week"]').click();
} catch (error) { errors.push(`granularity toggle threw: ${error.message}`); }

// Owner rollup toggle.
try {
  window.document.querySelector('#newsroomGrouping button[data-grouping="owner"]').click();
  check("owner rollup renders", $("#outletList").children.length > 0, `${$("#outletList").children.length} owners`);
  check("owner card shows parent", $("#outletList").textContent.includes("Gray Media") || $("#outletList").textContent.includes("Scripps"), "");
  window.document.querySelector('#newsroomGrouping button[data-grouping="outlet"]').click();
} catch (error) {
  errors.push(`owner toggle threw: ${error.message}`);
}

// Stance filter must be reachable and must actually filter.
try {
  const before = $("#signalFeed").children.length;
  const radio = window.document.querySelector('.filters input[name="stance"][value="critical"]');
  radio.checked = true;
  radio.dispatchEvent(new window.Event("change", { bubbles: true }));
  const after = $("#signalFeed").children.length;
  check("stance filter narrows results", after <= before, `${before} -> ${after}`);
  const all = window.document.querySelector('.filters input[name="stance"][value="all"]');
  all.checked = true;
  all.dispatchEvent(new window.Event("change", { bubbles: true }));
} catch (error) {
  errors.push(`stance filter threw: ${error.message}`);
}

// Exports must not throw.
for (const id of ["#exportSignals", "#exportAgencies", "#exportCases", "#exportOutlets", "#exportRecords"]) {
  try { $(id).click(); } catch (error) { errors.push(`${id} threw: ${error.message}`); }
}
check("exports ran", true);

// A hostile URL in the dataset must never reach an href.
try {
  const hostile = window.eval('linkAttrs("javascript:alert(1)")');
  check("javascript: URL neutralised", !hostile.includes("javascript:"), hostile);
  const ok = window.eval('linkAttrs("https://example.com/a")');
  check("https URL preserved", ok.includes("https://example.com/a"), "");
} catch (error) {
  errors.push(`linkAttrs threw: ${error.message}`);
}

const failed = checks.filter(c => !c.pass);
for (const c of checks) console.log(`${c.pass ? "  ok  " : " FAIL "} ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
for (const e of errors) console.log(` ERROR ${e}`);

if (failed.length || errors.length) {
  console.log(`\n${failed.length} failed check(s), ${errors.length} error(s)`);
  process.exit(1);
}
console.log(`\nall ${checks.length} checks passed, no runtime errors`);
