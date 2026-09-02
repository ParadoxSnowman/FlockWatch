import { cp, mkdir, rm } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const dist = new URL("../dist/", import.meta.url);

await rm(dist, { recursive: true, force: true });
await mkdir(new URL("../dist/data/", import.meta.url), { recursive: true });
for (const file of ["index.html", "styles.css", "app.js"]) {
  await cp(new URL(`../${file}`, import.meta.url), new URL(`../dist/${file}`, import.meta.url));
}
for (const file of ["agencies.json", "evidence.json", "live.json", "outlets.json", "records.json", "status.json", "timeline.json"]) {
  await cp(new URL(`../data/${file}`, import.meta.url), new URL(`../dist/data/${file}`, import.meta.url));
}
