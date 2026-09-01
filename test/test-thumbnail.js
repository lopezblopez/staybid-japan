const handler = require("../api/thumbnail.js");
const dns = require("dns");

function fakeRes() {
  const headers = {};
  return {
    statusCode: null, headers, body: null,
    setHeader(k, v) { headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    end() { return this; }
  };
}

async function run(label, url) {
  const res = fakeRes();
  const started = Date.now();
  await handler({ method: "GET", query: { url } }, res);
  console.log(`${label}\n  url=${url}\n  -> status=${res.statusCode} (${Date.now() - started}ms)\n  Location: ${res.headers.Location || "-"}\n  Fallback-reason: ${res.headers["X-Thumbnail-Fallback"] || "(none)"}\n`);
}

(async () => {
  await run("1) Sitio real (og:image real esperado)", "https://pypi.org/");
  await run("2) IP interna directa (debe caer al favicon, nunca conectar)", "http://127.0.0.1:9999/secret");
  await run("3) localhost por nombre", "http://localhost/");
  await run("4) Metadatos de nube (AWS/GCP)", "http://169.254.169.254/latest/meta-data/");

  console.log("5) Ataque DNS rebinding: un dominio que resuelve a 127.0.0.1 directamente");
  // Simula el caso más simple de rebinding: el propio primer lookup YA es
  // privado. La variante "responde distinto la segunda vez" no se puede
  // simular sin un servidor DNS de verdad, pero como ahora solo hay UNA
  // resolución (safeLookup), no existe "segunda vez" que pueda desviarse:
  // demostramos que esa única resolución se aplica también en la conexión.
  const dns_lookup_orig = dns.lookup;
  let lookupCalls = 0;
  dns.lookup = (hostname, options, callback) => {
    lookupCalls++;
    // Fuerza la resolución a una IP privada, simulando un atacante.
    if (typeof options === "function") { callback = options; options = {}; }
    callback(null, "127.0.0.1", 4);
  };
  await run("   (dominio controlado por el atacante -> 127.0.0.1)", "http://attacker-controlled.example/");
  console.log(`   dns.lookup fue llamado ${lookupCalls} vez(es) para esta petición (1 = sin ventana para rebinding)`);
  dns.lookup = dns_lookup_orig;
})();
