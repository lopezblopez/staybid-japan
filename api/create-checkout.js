// Vercel Serverless Function
// Required env vars: STRIPE_SECRET_KEY, PUBLIC_BASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

// Only accept well-formed http(s) URLs; anything else (javascript:, data:,
// malformed input) is dropped rather than stored, since these values end up
// as an <img src> / <a href> on the public ranking page.
function sanitizeUrl(u) {
  if (!u) return "";
  try {
    const parsed = new URL(u.toString().trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.href.slice(0, 300);
  } catch (e) {
    return "";
  }
}

// Where Stripe sends the customer back to. PUBLIC_BASE_URL is the intended
// source, but a missing or mistyped value would otherwise produce
// "undefined/?payment=success" and make Stripe reject the whole session — so
// the request's own host is used as a fallback rather than failing checkout
// over a configuration typo.
function baseUrl(req) {
  const configured = (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  if (/^https?:\/\/.+/i.test(configured)) return configured;
  const headers = req.headers || {};
  const host = headers["x-forwarded-host"] || headers.host;
  if (host) {
    const proto = headers["x-forwarded-proto"] || "https";
    console.warn("PUBLIC_BASE_URL is not set to a valid URL; falling back to", `${proto}://${host}`);
    return `${proto}://${host}`;
  }
  return "";
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({error:"Method not allowed"});
  try {
    // Name the missing piece in the logs; every one of these is a Vercel
    // environment variable, and a blank one otherwise surfaces as a generic 500.
    const missing = ["STRIPE_SECRET_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]
      .filter((k) => !process.env[k]);
    if (missing.length) {
      console.error("Missing required environment variable(s):", missing.join(", "));
      return res.status(500).json({ error: "Payment is not configured yet" });
    }
    const { slug, amount, name, place, imageUrl, websiteUrl } = req.body || {};
    const yen = Number(amount);
    if (!slug || !Number.isInteger(yen) || yen < 100) {
      return res.status(400).json({error:"Invalid payment amount"});
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // Enforce the core rule server-side: a listing that already exists can
    // only be paid for with at least +100 over its current total. The
    // browser suggests this amount, but the client can't be trusted with it.
    const { data: existing, error: fetchError } = await supabase
      .from("listings")
      .select("total_paid_jpy")
      .eq("slug", slug)
      .maybeSingle();
    if (fetchError) throw fetchError;

    const minRequired = existing ? Number(existing.total_paid_jpy) + 100 : 100;
    if (yen < minRequired) {
      return res.status(400).json({ error: `Minimum payment for this listing is now ¥${minRequired}` });
    }

    const base = baseUrl(req);
    if (!base) {
      console.error("Cannot determine the site's base URL: set PUBLIC_BASE_URL");
      return res.status(500).json({ error: "Payment is not configured yet" });
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const listingName = (name || slug).toString().slice(0, 120);
    const listingPlace = (place || "").toString().slice(0, 120);
    const listingImage = sanitizeUrl(imageUrl);
    const listingWebsite = sanitizeUrl(websiteUrl);
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      // The Stripe account has Managed Payments on by default, which requires
      // a tax code per product. This is a simple listing fee, not a taxable
      // product catalog, so Managed Payments is opted out for this session.
      managed_payments: { enabled: false },
      line_items: [{
        price_data: {
          currency: "jpy",
          product_data: { name: `STAYBID JAPAN — ${listingName}` },
          unit_amount: yen
        },
        quantity: 1
      }],
      success_url: `${base}/?payment=success`,
      cancel_url: `${base}/?payment=cancelled`,
      metadata: {
        slug, amount: String(yen), name: listingName, place: listingPlace,
        image_url: listingImage, website_url: listingWebsite
      }
    });

    // Record the pending payment up front for auditability; the webhook is
    // still the only thing that ever marks it completed and updates the total.
    await supabase.from("payments").upsert(
      { stripe_session_id: session.id, amount_jpy: yen, status: "pending" },
      { onConflict: "stripe_session_id" }
    );

    return res.status(200).json({url:session.url});
  } catch (e) {
    console.error(e);
    return res.status(500).json({error:"Stripe checkout could not be created"});
  }
};