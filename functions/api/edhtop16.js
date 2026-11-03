// Cloudflare Pages Function — PhyrexianMTG data gateway (v6)
// File path in the repo: functions/api/edhtop16.js  →  https://<site>/api/edhtop16
//
// Why v6: since 2026-10-19 edhtop16.com/api/graphql only runs the persisted queries its own site
// sends — {"variables": …, "extensions": {"pastoria-id": "<id>"}} — and refuses query text with
// {"errors": ["Only persisted queries are allowed in production. …"]}. None of its persisted
// queries return a deck's cards. So the app now works in two steps:
//   1. edhtop16 (its own entries query) → the qualifying entries: event, TID, standing, size, date
//   2. TopDeck.gg official API v2 → each event's standings with full decklists
//      (free key from https://topdeck.gg/developers, stored as the Pages secret TOPDECK_API_KEY)
//
// Routes
//   POST {op: "entries"|"entries_more", variables: {…}}  → edhtop16 persisted query (JSON passthrough,
//                                                          errors normalised to {message})
//   GET  ?topdeck=<TID>                                  → TopDeck /v2/tournaments/<TID>/standings
//                                                          (key added here, never sent to the browser)
//   GET  ?diag=1                                         → health report to paste back when debugging
//                                                          (add &discover=1 to force an id re-read)

const EDH_API = "https://edhtop16.com/api/graphql";
const EDH_SITE = "https://edhtop16.com";
const TD_API = "https://topdeck.gg/api/v2";
const UA = "PhyrexianMetaAggregator/6 (+https://phyrexian-meta-aggregator.pages.dev)";
const MAX_JS = 30;                    // most script files read when re-discovering query ids
const DISCOVERY_COOLDOWN = 5 * 60e3;  // per isolate
const IDS_CACHE_PATH = "/__phyrexian_cache/edhtop16-ids-v1";

// Relay operation → persisted id (md5 of the query text). Verified live 2026-10-19. An id only
// changes when edhtop16 edits that query; when it does, the site answers HTTP 400 "Unable to find
// persisted query" and this function re-reads the ids from edhtop16's JavaScript.
const OPS = {
  entries:      { name: "entries_CommanderEntriesQuery", id: "124b6abe467f15a68b2a706f3e192fd5", suffix: "CommanderEntriesQuery" },
  entries_more: { name: "CommanderEntriesListQuery",     id: "bd28e8f9faddc1eaf4590246bf2c7a25", suffix: "CommanderEntriesListQuery" },
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

let liveIds = null;        // {opName: id} found by discovery (module scope = per isolate)
let lastDiscovery = 0;
let origin = "https://phyrexian-meta-aggregator.pages.dev";  // replaced by the request's own origin

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json", ...extra } });

const errMsg = e => typeof e === "string" ? e : (e && (e.message || e.error)) || JSON.stringify(e);
const normErrors = errs => (Array.isArray(errs) ? errs : [errs]).filter(Boolean).map(e => ({ message: errMsg(e) }));

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(request.url);
  origin = url.origin;
  try {
    if (request.method === "GET") {
      if (url.searchParams.has("topdeck")) return await topdeck(url.searchParams.get("topdeck"), env, context, url);
      if (url.searchParams.has("diag")) return await diag(env, context, url);
      return json({ error: "Use POST {op, variables}, GET ?topdeck=<TID>, or GET ?diag=1" }, 400);
    }
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    let body;
    try { body = await request.json(); } catch { return json({ errors: [{ message: "Request body was not JSON" }] }, 400); }
    if (body && typeof body.query === "string" && !body.op) {
      return json({ errors: [{ message: "This page is out of date: edhtop16 stopped accepting query text on 2026-10-19. Reload the page (the v6 app uses edhtop16's own queries plus TopDeck decklists)." }] });
    }
    if (!body || !OPS[body.op]) return json({ errors: [{ message: `Unknown op "${body && body.op}"` }] }, 400);
    return await edhtop16(body.op, body.variables || {}, context);
  } catch (e) {
    return json({ errors: [{ message: `Gateway error: ${e && e.message || e}` }] }, 502);
  }
}

// ---------------------------------------------------------------- edhtop16 (persisted queries)

async function postPersisted(id, variables) {
  const res = await fetch(EDH_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "User-Agent": UA },
    body: JSON.stringify({ variables, extensions: { "pastoria-id": id } }),
  });
  return { status: res.status, text: await res.text() };
}

function idFor(opKey, ids) {
  const op = OPS[opKey];
  if (!ids) return null;
  if (ids[op.name]) return ids[op.name];
  const near = Object.keys(ids).filter(n => n.endsWith(op.suffix));
  return near.length ? ids[near[0]] : null;
}

async function edhtop16(opKey, variables, context) {
  const op = OPS[opKey];
  let ids = liveIds || await readCachedIds();
  let id = idFor(opKey, ids) || op.id;
  let r = await postPersisted(id, variables);
  let rediscovered = false;
  if (r.status === 400 && /persisted query/i.test(r.text)) {
    const found = await discoverIds(variables.commander, context);
    const fresh = idFor(opKey, found);
    if (fresh && fresh !== id) {
      id = fresh; rediscovered = true;
      r = await postPersisted(id, variables);
    }
    if (r.status === 400 && /persisted query/i.test(r.text)) {
      return json({ errors: [{ message: `edhtop16 changed its ${op.name} query and the new id couldn't be read from its site. Open /api/edhtop16?diag=1&discover=1 and send me the output.` }], upstreamStatus: 400 });
    }
  }
  let data;
  try { data = JSON.parse(r.text); }
  catch { return json({ errors: [{ message: `edhtop16 HTTP ${r.status} (not JSON): ${r.text.slice(0, 200)}` }], upstreamStatus: r.status }); }
  if (data && data.errors) data.errors = normErrors(data.errors);
  if (data && typeof data === "object") data.gateway = { op: op.name, id, rediscovered, upstreamStatus: r.status };
  return json(data);
}

// Read the persisted ids out of edhtop16's compiled Relay operations. Each one ends with
//   params:{id:"<md5>",metadata:{},name:"<OperationName>",operationKind:"query",text:null}
// (quotes may be ", ' or `). Scans with indexOf so CPU stays low on the free plan.
function extractOps(js) {
  const out = {};
  let i = 0, prev = -1;
  while ((i = js.indexOf("operationKind", i)) !== -1) {
    // only this operation's own params: from just after the previous operation up to here
    const before = js.slice(Math.max(0, i - 400, prev + 13), i);
    const after = js.slice(i, i + 40);
    prev = i; i += 13;
    if (!/^operationKind["']?\s*:\s*["'`]query["'`]/.test(after)) continue;
    const nm = before.match(/name["']?\s*:\s*(["'`])([A-Za-z0-9_$]+)\1\s*,\s*["']?$/);
    if (!nm) continue;
    const ids = [...before.matchAll(/(?:^|[^A-Za-z0-9_$])["']?id["']?\s*:\s*(["'`])([0-9a-fA-F]{16,64})\1/g)];
    if (ids.length) out[nm[2]] = ids[ids.length - 1][2];
  }
  return out;
}

async function discoverIds(commander, context, force = false) {
  const now = Date.now();
  if (!force && liveIds && now - lastDiscovery < DISCOVERY_COOLDOWN) return liveIds;
  lastDiscovery = now;
  const page = commander ? `${EDH_SITE}/commander/${encodeURIComponent(commander)}` : `${EDH_SITE}/`;
  const html = await (await fetch(page, { headers: { "User-Agent": UA, "Accept": "text/html" } })).text();
  const queue = [], seen = new Set();
  const add = u => {
    let abs; try { abs = new URL(u, page).href; } catch { return; }
    if (!abs.startsWith(EDH_SITE + "/") || seen.has(abs) || seen.size >= MAX_JS) return;
    seen.add(abs); queue.push(abs);
  };
  for (const m of html.matchAll(/(?:src|href)\s*=\s*["']([^"'\s]+?\.m?js)(?:\?[^"']*)?["']/g)) add(m[1]);
  for (const m of html.matchAll(/["'`](\/?assets\/[\w.\-]+\.m?js)["'`]/g)) add("/" + m[1].replace(/^\//, ""));
  // read the likeliest chunks first
  queue.sort((a, b) => score(b) - score(a));
  const found = {};
  const done = () => Object.keys(OPS).every(k => idFor(k, found));
  while (queue.length && !done()) {
    const u = queue.shift();
    let js;
    try { const r = await fetch(u, { headers: { "User-Agent": UA } }); if (!r.ok) continue; js = await r.text(); } catch { continue; }
    Object.assign(found, extractOps(js));
    if (done()) break;
    const before = queue.length;
    for (const m of js.matchAll(/["'`](\.\.?\/[\w.\-\/]+\.m?js)["'`]/g)) { try { add(new URL(m[1], u).href); } catch {} }
    for (const m of js.matchAll(/["'`]\/?(assets\/[\w.\-]+\.m?js)["'`]/g)) add("/" + m[1]);
    if (queue.length !== before) queue.sort((a, b) => score(b) - score(a));
  }
  if (Object.keys(found).length) {
    liveIds = { ...(liveIds || {}), ...found };
    await writeCachedIds(liveIds, context);
  }
  return found;
}
const score = u => (/entries/i.test(u) ? 4 : 0) + (/commander/i.test(u) ? 2 : 0) + (/page|index|main|entry|app/i.test(u) ? 1 : 0);

async function readCachedIds() {
  try {
    const hit = await caches.default.match(new Request(origin + IDS_CACHE_PATH));
    if (hit) { liveIds = await hit.json(); return liveIds; }
  } catch {}
  return null;
}
async function writeCachedIds(ids, context) {
  try {
    const p = caches.default.put(new Request(origin + IDS_CACHE_PATH),
      new Response(JSON.stringify(ids), { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=21600" } }));
    if (context && context.waitUntil) context.waitUntil(p); else await p;
  } catch {}
}

// ---------------------------------------------------------------- TopDeck (official API v2)

async function topdeck(tidRaw, env, context, url) {
  const key = env && env.TOPDECK_API_KEY;
  if (!key) return json({ error: "NO_TOPDECK_KEY", message: "TopDeck API key not set: add the secret TOPDECK_API_KEY in Cloudflare Pages → Settings → Variables and Secrets, then redeploy." }, 503);
  const tid = String(tidRaw || "").trim();
  if (!tid || tid.length > 200 || /[\/?#\s]/.test(tid)) return json({ error: "BAD_TID", message: `Invalid tournament id "${tid}"` }, 400);
  const cacheKey = new Request(`${url.origin}/__phyrexian_cache/topdeck-v1/${encodeURIComponent(tid)}`);
  try { const hit = await caches.default.match(cacheKey); if (hit) return hit; } catch {}
  const up = await fetch(`${TD_API}/tournaments/${encodeURIComponent(tid)}/standings`, {
    headers: { "Authorization": key, "Accept": "application/json", "User-Agent": UA },
  });
  if (up.status === 429) {
    let wait = Number(up.headers.get("Retry-After")) || 0;
    if (!wait) { try { wait = Number((await up.json()).retryAfterSeconds) || 0; } catch {} }
    return json({ error: "RATE_LIMIT", retryAfter: wait || 15, message: "TopDeck rate limit" }, 429);
  }
  if (up.status === 401 || up.status === 403) {
    return json({ error: "BAD_TOPDECK_KEY", message: `TopDeck refused the API key (HTTP ${up.status}). Re-copy it into TOPDECK_API_KEY and redeploy.` }, 502);
  }
  if (up.status === 404) return json({ error: "NOT_FOUND", message: `TopDeck has no event ${tid}` }, 404);
  if (!up.ok) {
    const t = await up.text();
    return json({ error: "TOPDECK_HTTP", message: `TopDeck HTTP ${up.status}: ${t.slice(0, 200)}` }, 502);
  }
  // Stream the body straight through (no JSON.parse here: big events stay inside the free plan's CPU limit).
  const resp = new Response(up.body, {
    status: 200,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "public, max-age=21600" },
  });
  try {
    const p = caches.default.put(cacheKey, resp.clone());
    if (context && context.waitUntil) context.waitUntil(p);
  } catch {}
  return resp;
}

// ---------------------------------------------------------------- diagnostics

async function diag(env, context, url) {
  const out = { version: "v6", time: new Date().toISOString(), ids: {}, edhtop16: {}, topdeck: {} };
  const commander = url.searchParams.get("commander") || "Kinnan, Bonder Prodigy";
  if (url.searchParams.has("discover")) {
    try {
      const found = await discoverIds(commander, context, true);
      out.discovery = { found, entries: idFor("entries", found), entries_more: idFor("entries_more", found) };
    } catch (e) { out.discovery = { error: String(e && e.message || e) }; }
  }
  for (const k of Object.keys(OPS)) out.ids[k] = idFor(k, liveIds) || OPS[k].id;
  let tid = null;
  try {
    const r = await edhtop16("entries", { commander, minEventSize: 0, timePeriod: "THREE_MONTHS", sortBy: "NEW", maxStanding: null }, context);
    const j = await r.json();
    const conn = j && j.data && j.data.commander && j.data.commander.entries;
    const node = conn && conn.edges && conn.edges[0] && conn.edges[0].node;
    tid = node && node.tournament && node.tournament.TID;
    out.edhtop16 = {
      commander, gateway: j && j.gateway, errors: j && j.errors,
      commanderKeys: j && j.data && j.data.commander ? Object.keys(j.data.commander) : null,
      entriesOnPage: conn && conn.edges ? conn.edges.length : null,
      hasNextPage: conn && conn.pageInfo ? conn.pageInfo.hasNextPage : null,
      sampleNode: node || null,
    };
  } catch (e) { out.edhtop16 = { error: String(e && e.message || e) }; }
  out.topdeck.keyConfigured = !!(env && env.TOPDECK_API_KEY);
  if (out.topdeck.keyConfigured && tid) {
    try {
      const r = await fetch(`${TD_API}/tournaments/${encodeURIComponent(tid)}/standings`, {
        headers: { "Authorization": env.TOPDECK_API_KEY, "Accept": "application/json", "User-Agent": UA },
      });
      const t = await r.text();
      out.topdeck.probe = { tid, status: r.status, bytes: t.length, head: t.slice(0, 1800) };
    } catch (e) { out.topdeck.probe = { tid, error: String(e && e.message || e) }; }
  }
  return json(out, 200, { "Cache-Control": "no-store" });
}
