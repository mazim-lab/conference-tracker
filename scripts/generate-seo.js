#!/usr/bin/env node
/*
 * generate-seo.js — zero-dependency generator for SEO assets.
 *
 * Reads conferences.json and produces, for crawlability/indexing:
 *   - c/<slug>.html   one lightweight, fully-static page per conference
 *                     (real HTML content + schema.org Event JSON-LD)
 *   - sitemap.xml     homepage + every conference page
 *   - robots.txt      points crawlers at the sitemap
 *
 * No npm install required — safe to run inside the daily GitHub Action.
 * Run locally with: npm run seo   (or: node scripts/generate-seo.js)
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SITE = "https://www.faeconf.com";
const OUT_DIR = path.join(ROOT, "c");

const DISC = { fin: "Finance", acct: "Accounting", econ: "Economics" };
const TIER = { "1": "Tier 1 (top)", "2": "Tier 2", "3": "Tier 3" };

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function slugify(name, id) {
  const base = String(name || "conference").toLowerCase()
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70)
    .replace(/-+$/g, "");
  return (base || "conference") + "-" + id;
}

function yearOf(c) {
  const s = c.startDate || c.deadline || "";
  const m = /^(\d{4})/.exec(s);
  return m ? m[1] : "";
}

function discList(c) {
  return (c.disc || []).map((d) => DISC[d]).filter(Boolean);
}

function isTBD(dl) {
  return !dl || dl === "TBD" || dl.toLowerCase() === "tbd";
}

function pageHtml(c, slug) {
  const year = yearOf(c);
  const title = `${c.name}${year ? " (" + year + ")" : ""} — Deadline, Dates & Location`;
  const discs = discList(c);
  const discStr = discs.join(", ") || "Finance / Accounting / Economics";
  const tierStr = c.tier && TIER[c.tier] ? TIER[c.tier] : "Unranked";
  const dlStr = isTBD(c.deadline) ? "To be announced" : c.deadline;
  const loc = c.location || "TBD";
  const link = c.url || c.ssrnLink || SITE;
  const desc = `${c.name} takes place ${c.dates || "on " + (c.startDate || "TBD")}` +
    `${loc && loc !== "TBD" ? " in " + loc : ""}. ` +
    `Submission deadline: ${dlStr}. Field: ${discStr}.`;
  const canonical = `${SITE}/c/${slug}.html`;

  // schema.org Event structured data
  const jsonld = {
    "@context": "https://schema.org",
    "@type": "Event",
    name: c.name,
    description: desc,
    url: canonical,
    eventAttendanceMode: loc === "Virtual"
      ? "https://schema.org/OnlineEventAttendanceMode"
      : "https://schema.org/OfflineEventAttendanceMode",
    eventStatus: "https://schema.org/EventScheduled",
    about: discStr,
  };
  if (c.startDate) jsonld.startDate = c.startDate;
  if (loc && loc !== "TBD") {
    jsonld.location = loc === "Virtual"
      ? { "@type": "VirtualLocation", url: link }
      : { "@type": "Place", name: loc, address: c.country || loc };
  }

  const row = (label, val) =>
    `<div class="row"><dt>${esc(label)}</dt><dd>${val}</dd></div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(title)} | faeconf</title>
<meta name="description" content="${esc(desc)}" />
<link rel="canonical" href="${esc(canonical)}" />
<meta property="og:type" content="article" />
<meta property="og:title" content="${esc(c.name)}" />
<meta property="og:description" content="${esc(desc)}" />
<meta property="og:url" content="${esc(canonical)}" />
<meta property="og:site_name" content="faeconf" />
<meta name="twitter:card" content="summary" />
<meta name="theme-color" content="#0d1015" />
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@500;600&family=Newsreader:opsz,wght@6..72,400;6..72,600;6..72,700&display=swap" rel="stylesheet" />
<script type="application/ld+json">${JSON.stringify(jsonld)}</script>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#faf8f2;color:#3a3631;font-family:'Newsreader',Georgia,serif;line-height:1.6;-webkit-font-smoothing:antialiased}
  .wrap{max-width:680px;margin:0 auto;padding:48px 22px 64px}
  a{color:#4338ca}
  .crumb{font-family:'JetBrains Mono',monospace;font-size:12px;color:#8a8378;margin-bottom:28px;text-decoration:none;display:inline-block}
  h1{font-size:30px;font-weight:700;letter-spacing:-0.02em;color:#1c1a17;line-height:1.2}
  .meta{font-family:'JetBrains Mono',monospace;font-size:12px;color:#8a8378;margin:10px 0 28px}
  dl{border-top:1px solid rgba(0,0,0,0.1)}
  .row{display:flex;gap:16px;padding:13px 2px;border-bottom:1px solid rgba(0,0,0,0.08)}
  dt{flex:0 0 130px;font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#8a8378;padding-top:2px}
  dd{flex:1;font-size:16px;color:#2a2722}
  .cta{display:inline-block;margin-top:30px;margin-right:10px;padding:11px 18px;border-radius:8px;background:#4338ca;color:#fff;text-decoration:none;font-size:15px}
  .cta.alt{background:transparent;color:#4338ca;border:1px solid rgba(67,56,202,0.4)}
  footer{margin-top:46px;padding-top:18px;border-top:1px solid rgba(0,0,0,0.08);font-size:13px;color:#8a8378}
</style>
</head>
<body>
  <div class="wrap">
    <a class="crumb" href="/">&larr; faeconf · Academic Conference Tracker</a>
    <h1>${esc(c.name)}</h1>
    <div class="meta">${esc(discStr)}${c.dates ? " · " + esc(c.dates) : ""}${loc && loc !== "TBD" ? " · " + esc(loc) : ""}</div>
    <dl>
      ${row("Dates", esc(c.dates || c.startDate || "TBD"))}
      ${row("Location", esc(loc))}
      ${c.country ? row("Country", esc(c.country)) : ""}
      ${row("Submission deadline", esc(dlStr))}
      ${row("Field", esc(discStr))}
      ${row("Ranking", esc(tierStr))}
    </dl>
    <a class="cta" href="${esc(link)}" target="_blank" rel="noopener noreferrer">${c.url ? "Conference website" : "SSRN announcement"} &rarr;</a>
    <a class="cta alt" href="/">Browse all conferences</a>
    <footer>
      Listed on <a href="/">faeconf</a>, a free tracker of ${esc(discStr)} conferences with deadlines and travel cost estimates.
      Data sourced from SSRN networks (FEN/ARN/ERN); always verify details on the official conference website.
    </footer>
  </div>
</body>
</html>
`;
}

function main() {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, "conferences.json"), "utf8"));
  const today = new Date().toISOString().split("T")[0];

  // de-dupe slugs (id makes them unique already) and only pages with a name
  const pages = data.filter((c) => c && c.name && (c.startDate || c.deadline));

  // clean & recreate output dir so removed conferences don't leave stale pages
  if (fs.existsSync(OUT_DIR)) {
    for (const f of fs.readdirSync(OUT_DIR)) {
      if (f.endsWith(".html")) fs.unlinkSync(path.join(OUT_DIR, f));
    }
  } else {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }

  const urls = [`${SITE}/`, `${SITE}/conferences.html`];
  const hubItems = [];
  for (const c of pages) {
    const slug = slugify(c.name, c.id);
    fs.writeFileSync(path.join(OUT_DIR, slug + ".html"), pageHtml(c, slug));
    urls.push(`${SITE}/c/${slug}.html`);
    hubItems.push({ c, slug });
  }

  // conferences.html — a no-JS index that links to every page (crawl hub + fallback)
  hubItems.sort((a, b) => (a.c.startDate || "9999").localeCompare(b.c.startDate || "9999"));
  const hubRows = hubItems.map(({ c, slug }) =>
    `<li><a href="/c/${esc(slug)}.html">${esc(c.name)}</a>` +
    `<span>${esc([discList(c).join("/"), c.dates || c.startDate, c.location].filter(Boolean).join(" · "))}</span></li>`
  ).join("\n");
  const hub = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>All Finance, Accounting & Economics Conferences (${pages.length}) | faeconf</title>
<meta name="description" content="A complete A–Z index of ${pages.length} finance, accounting, and economics conferences with deadlines, dates, and locations." />
<link rel="canonical" href="${SITE}/conferences.html" />
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@500;600&family=Newsreader:opsz,wght@6..72,400;6..72,600;6..72,700&display=swap" rel="stylesheet" />
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#faf8f2;color:#3a3631;font-family:'Newsreader',Georgia,serif;line-height:1.5;-webkit-font-smoothing:antialiased}
  .wrap{max-width:760px;margin:0 auto;padding:48px 22px 64px}
  a{color:#4338ca;text-decoration:none}
  .crumb{font-family:'JetBrains Mono',monospace;font-size:12px;color:#8a8378;margin-bottom:24px;display:inline-block}
  h1{font-size:28px;font-weight:700;letter-spacing:-0.02em;color:#1c1a17}
  p.sub{color:#8a8378;margin:8px 0 28px;font-size:15px}
  ul{list-style:none}
  li{padding:11px 2px;border-bottom:1px solid rgba(0,0,0,0.07);display:flex;flex-direction:column;gap:2px}
  li a{font-size:16px}
  li span{font-family:'JetBrains Mono',monospace;font-size:11px;color:#8a8378}
</style>
</head>
<body>
  <div class="wrap">
    <a class="crumb" href="/">&larr; faeconf · Academic Conference Tracker</a>
    <h1>All Conferences</h1>
    <p class="sub">${pages.length} finance, accounting &amp; economics conferences. Use the <a href="/">interactive tracker</a> to filter by field, region, ranking, and deadline.</p>
    <ul>
${hubRows}
    </ul>
  </div>
</body>
</html>
`;
  fs.writeFileSync(path.join(ROOT, "conferences.html"), hub);

  // sitemap.xml
  const sitemap =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((u) =>
      `  <url><loc>${esc(u)}</loc><lastmod>${today}</lastmod>` +
      `<changefreq>${u.endsWith("/") ? "daily" : "weekly"}</changefreq>` +
      `<priority>${u.endsWith("/") ? "1.0" : "0.6"}</priority></url>`
    ).join("\n") +
    `\n</urlset>\n`;
  fs.writeFileSync(path.join(ROOT, "sitemap.xml"), sitemap);

  // robots.txt
  fs.writeFileSync(path.join(ROOT, "robots.txt"),
    `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);

  console.log(`Generated ${pages.length} conference pages + sitemap.xml + robots.txt`);
}

main();
