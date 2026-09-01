// Tests api/create-checkout.js against the requests a browser would never
// send — the ones someone poking at the API directly would.
process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
process.env.PUBLIC_BASE_URL = "https://staybid-japan.vercel.app";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "dummy";

let db, stripeCalls;

const supabasePath = require.resolve("@supabase/supabase-js");
require.cache[supabasePath] = {
  id: supabasePath, filename: supabasePath, loaded: true,
  exports: {
    createClient: () => ({
      from() {
        const q = {
          select: () => q,
          eq: () => q,
          maybeSingle: async () => ({ data: db.existing, error: null }),
          upsert: async (row) => { db.upserts.push(row); return { error: null }; }
        };
        return q;
      }
    })
  }
};

const stripePath = require.resolve("stripe");
require.cache[stripePath] = {
  id: stripePath, filename: stripePath, loaded: true,
  exports: function StripeStub() {
    return {
      checkout: { sessions: { create: async (opts) => {
        stripeCalls.push(opts);
        return { id: "cs_test_stub", url: "https://checkout.stripe.com/stub" };
      } } }
    };
  }
};

const handler = require("../api/create-checkout.js");

function makeRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.body = o; return res; };
  return res;
}
async function post(body, existing = null) {
  db = { existing, upserts: [] };
  stripeCalls = [];
  const res = makeRes();
  await handler({ method: "POST", body, headers: { host: "staybid-japan.vercel.app" } }, res);
  return res;
}

let pass = 0, fail = 0;
const check = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`   ✅ ${label}`); }
  else { fail++; console.log(`   ❌ ${label} ${detail}`); }
};

(async () => {
  console.log("\n1) Pago normal para un alojamiento nuevo (¥100)");
  let r = await post({ slug: "nuevo", amount: 100, name: "Nuevo", place: "長野",
                       websiteUrl: "https://example.com" });
  check("responde 200 con URL de Stripe", r.statusCode === 200 && !!r.body.url);
  check("cobra exactamente ¥100", stripeCalls[0].line_items[0].price_data.unit_amount === 100);
  check("moneda JPY", stripeCalls[0].line_items[0].price_data.currency === "jpy");
  check("Managed Payments desactivado", stripeCalls[0].managed_payments.enabled === false);
  check("registra el pago como pending",
        db.upserts[0] && db.upserts[0].status === "pending");

  console.log("\n2) Intento de saltarse el mínimo (listado en ¥5.000, pagando ¥100)");
  r = await post({ slug: "ruta77", amount: 100, name: "Ruta77",
                   websiteUrl: "https://example.com" }, { total_paid_jpy: 5000 });
  check("rechazado con 400", r.statusCode === 400, `(fue ${r.statusCode})`);
  check("no se creó ninguna sesión de pago", stripeCalls.length === 0);
  check("el mensaje indica el mínimo real (¥5100)",
        /5100/.test(r.body.error || ""), r.body.error);

  console.log("\n3) Importe exactamente en el mínimo (¥5.100)");
  r = await post({ slug: "ruta77", amount: 5100, name: "Ruta77",
                   websiteUrl: "https://example.com" }, { total_paid_jpy: 5000 });
  check("aceptado", r.statusCode === 200);

  console.log("\n4) Importes inválidos");
  for (const [label, amount] of [["negativo", -500], ["cero", 0],
                                 ["decimal", 100.5], ["texto", "1000abc"],
                                 ["por debajo del mínimo global", 99]]) {
    r = await post({ slug: "x", amount, websiteUrl: "https://example.com" });
    check(`rechaza ${label}`, r.statusCode === 400, `(fue ${r.statusCode})`);
  }

  console.log("\n5) URLs peligrosas se descartan, no se guardan");
  r = await post({ slug: "x", amount: 100, name: "X",
                   websiteUrl: "javascript:alert(document.cookie)",
                   imageUrl: "data:text/html;base64,PHNjcmlwdD4=" });
  check("la sesión se crea igualmente", r.statusCode === 200);
  check("website_url queda vacío", stripeCalls[0].metadata.website_url === "",
        stripeCalls[0].metadata.website_url);
  check("image_url queda vacío", stripeCalls[0].metadata.image_url === "",
        stripeCalls[0].metadata.image_url);

  console.log("\n6) Nombres muy largos se recortan (límite de metadata de Stripe)");
  r = await post({ slug: "x", amount: 100, name: "あ".repeat(400),
                   place: "い".repeat(400), websiteUrl: "https://example.com" });
  check("name recortado a 120", stripeCalls[0].metadata.name.length === 120);
  check("place recortado a 120", stripeCalls[0].metadata.place.length === 120);

  console.log("\n7) Falta el slug");
  r = await post({ amount: 100, websiteUrl: "https://example.com" });
  check("rechazado con 400", r.statusCode === 400);

  console.log("\n8) URLs de retorno correctas");
  process.env.PUBLIC_BASE_URL = "https://staybid-japan.vercel.app";
  r = await post({ slug: "x", amount: 100, name: "X", websiteUrl: "https://example.com" });
  check("success_url apunta al sitio",
        stripeCalls[0].success_url === "https://staybid-japan.vercel.app/?payment=success",
        stripeCalls[0].success_url);
  check("cancel_url apunta al sitio",
        stripeCalls[0].cancel_url === "https://staybid-japan.vercel.app/?payment=cancelled");

  console.log("\n9) PUBLIC_BASE_URL ausente o con errata → usa el host de la petición");
  for (const [label, val] of [["ausente", undefined], ["vacío", ""],
                              ["sin esquema", "staybid-japan.vercel.app"],
                              ["con barra final", "https://staybid-japan.vercel.app/"]]) {
    if (val === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = val;
    r = await post({ slug: "x", amount: 100, name: "X", websiteUrl: "https://example.com" });
    check(`${label}: el pago sigue funcionando`,
          r.statusCode === 200 && stripeCalls[0].success_url === "https://staybid-japan.vercel.app/?payment=success",
          stripeCalls[0] && stripeCalls[0].success_url);
  }
  process.env.PUBLIC_BASE_URL = "https://staybid-japan.vercel.app";

  console.log("\n10) Falta una variable de entorno obligatoria");
  const savedKey = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  r = await post({ slug: "x", amount: 100, name: "X", websiteUrl: "https://example.com" });
  check("responde 500 sin intentar cobrar", r.statusCode === 500 && stripeCalls.length === 0);
  process.env.STRIPE_SECRET_KEY = savedKey;

  console.log("\n11) Método incorrecto (GET)");
  const res = makeRes();
  await handler({ method: "GET" }, res);
  check("responde 405", res.statusCode === 405);

  console.log(`\n──────────────\n${pass} pasaron, ${fail} fallaron`);
  process.exit(fail ? 1 : 0);
})();
