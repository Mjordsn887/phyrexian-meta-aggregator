// Cloudflare Pages Function — edhtop16 GraphQL proxy
// File path in your repo: functions/api/edhtop16.js
// After deploy, your proxy URL is: https://YOUR-SITE.pages.dev/api/edhtop16

const UPSTREAM = "https://edhtop16.com/api/graphql";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function onRequest({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), {
      status: 405,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  const body = await request.text();
  const upstream = await fetch(UPSTREAM, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
