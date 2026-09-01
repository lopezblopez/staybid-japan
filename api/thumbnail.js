// Vercel Serverless Function — resolves a photo for a listing's website.
//
// Reads the listing's site server-side and finds the image the site itself
// advertises (Open Graph / Twitter card / apple-touch-icon), then redirects
// the browser to it. Falling back to the site's favicon means a listing with
// a valid site practically always gets something to show.
//
// It redirects rather than streaming the bytes back on purpose: serverless
// functions here are killed at 10s, and fetching the page *and* piping a
// multi-megabyte image through the function was overrunning that budget. One
// short fetch stays well inside it, and the browser then loads the image
// straight from the site's own server.
const dns = require("dns");
const net = require("net");
const http = require("http");
const https = require("https");

const PAGE_TIMEOUT_MS = 4000;
const MAX_HTML_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;

// This endpoint fetches URLs supplied by users, so it must never be usable to
// reach the platform's internal network (SSRF). Every address the request
// actually connects to is checked against the private/link-local/loopback
// ranges before the connection is made.
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] >= 224) return true;
    return false;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateIp(v6.slice(7));
  if (v6 === "::1" || v6 === "::") return true;
  if (v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80")) return true;
  return false;
}

// Passed as the `lookup` option to http(s).request below, so this is the
// SAME resolution Node then connects the socket to — not a separate check
// followed by a second, independent lookup. That distinction matters: a
// malicious DNS server can answer a first query with a public IP and a
// follow-up query (e.g. after a short TTL) with an internal one ("DNS
// rebinding"), which would silently defeat a check-then-fetch pattern. Here
// there is only ever one lookup per connection, so there's nothing to rebind.
function safeLookup(hostname, options, callback) {
  // Node's http/https client can ask for every address at once (all: true)
  // to race IPv4/IPv6 connections ("Happy Eyeballs"). We only ever need one
  // address to fetch a page, so requesting a single one keeps the
  // validation simple and gives it nothing extra to check.
  const opts = typeof options === "object" && options ? { ...options, all: false } : {};
  dns.lookup(hostname, opts, (err, address, family) => {
    if (err) return callback(err);
    if (isPrivateIp(address)) {
      return callback(new Error(`refusing to connect to private address ${address}`));
    }
    callback(null, address, family);
  });
}

function requestOnce(url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };

    let mod, urlObj;
    try {
      urlObj = new URL(url);
      mod = urlObj.protocol === "https:" ? https : http;
    } catch (e) {
      return reject(new Error("invalid URL"));
    }

    const req = mod.request(urlObj, {
      method: "GET",
      lookup: safeLookup,
      timeout: PAGE_TIMEOUT_MS,
      headers: {
        // Some sites serve a stripped page (or refuse outright) to clients
        // that don't look like a browser.
        "User-Agent": "Mozilla/5.0 (compatible; StaybidBot/1.0; +https://staybid-japan.vercel.app)",
        "Accept": "text/html,application/xhtml+xml"
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return done(resolve, { redirectTo: res.headers.location });
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return done(reject, new Error(`site responded ${res.statusCode}`));
      }
      const chunks = [];
      let total = 0;
      res.on("data", (chunk) => {
        total += chunk.length;
        if (total > MAX_HTML_BYTES) {
          req.destroy();
          return done(reject, new Error("response too large"));
        }
        chunks.push(chunk);
      });
      res.on("end", () => done(resolve, { html: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", (e) => done(reject, e));
    });

    req.on("timeout", () => req.destroy(new Error("request timed out")));
    req.on("error", (e) => done(reject, e));
    req.end();
  });
}

async function fetchPage(startUrl) {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const result = await requestOnce(current);
    if (result.redirectTo) {
      const next = new URL(result.redirectTo, current);
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        throw new Error("redirect to a non-http(s) target");
      }
      current = next.href;
      continue;
    }
    return { html: result.html, finalUrl: current };
  }
  throw new Error("too many redirects");
}

// Pulls the first matching image URL out of the page's markup. Deliberately
// regex-based rather than a full HTML parse: we only need a handful of
// well-known <meta>/<link> tags from the head.
function extractImageUrl(html, baseUrl) {
  const head = html.slice(0, 200000);
  const patterns = [
    /<meta[^>]+property=["']og:image(?::secure_url|:url)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url|:url)?["']/i,
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']/i,
    /<link[^>]+rel=["'][^"']*apple-touch-icon[^"']*["'][^>]+href=["']([^"']+)["']/i,
    /<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*apple-touch-icon[^"']*["']/i,
    /<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]+href=["']([^"']+)["']/i
  ];
  for (const re of patterns) {
    const m = head.match(re);
    if (m && m[1]) {
      try {
        const abs = new URL(m[1].trim().replace(/&amp;/g, "&"), baseUrl);
        if (abs.protocol === "http:" || abs.protocol === "https:") return abs.href;
      } catch (e) { /* malformed candidate, try the next pattern */ }
    }
  }
  return "";
}

module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  let site;
  try {
    const raw = (req.query && req.query.url) || "";
    site = new URL(Array.isArray(raw) ? raw[0] : raw);
    if (site.protocol !== "http:" && site.protocol !== "https:") throw new Error("bad protocol");
  } catch (e) {
    return res.status(400).json({ error: "A valid http(s) url parameter is required" });
  }

  let imageUrl = "";
  let reason = "";
  try {
    const page = await fetchPage(site.href);
    // Resolve against the final URL, so relative paths still work when the
    // site redirected us (e.g. example.com -> www.example.com/es/).
    imageUrl = extractImageUrl(page.html, page.finalUrl);
    if (!imageUrl) reason = "no og:image/icon tag found";
  } catch (e) {
    reason = e.message;
    console.error("Could not read page for", site.hostname, "-", e.message);
  }

  // Favicon fallback, for sites whose markup we couldn't read or that declare
  // no image at all. This resolver is reliable and returns a generic icon
  // rather than an error even for unknown domains.
  if (!imageUrl) {
    imageUrl = `https://www.google.com/s2/favicons?sz=128&domain=${encodeURIComponent(site.hostname)}`;
  }

  // Surfaced for debugging why a given listing shows a fallback icon.
  if (reason) res.setHeader("X-Thumbnail-Fallback", reason.slice(0, 120));
  // A listing's photo rarely changes; caching keeps repeat visitors from
  // re-triggering an upstream fetch on every page load.
  res.setHeader("Cache-Control", "public, s-maxage=86400, max-age=3600, stale-while-revalidate=604800");
  res.setHeader("Location", imageUrl);
  return res.status(302).end();
};
