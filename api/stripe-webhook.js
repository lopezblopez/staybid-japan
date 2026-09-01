// Vercel Serverless Function — Stripe webhook receiver.
// Required env vars: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Register this endpoint in the Stripe Dashboard (Developers → Webhooks) as:
//   https://<your-domain>/api/stripe-webhook
// subscribed to the "checkout.session.completed" event, then copy the
// "Signing secret" it gives you into STRIPE_WEBHOOK_SECRET.
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  const sig = req.headers["stripe-signature"];
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  let event;
  try {
    const rawBody = await readRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Stripe signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    // Check (but don't yet record) whether this event was already processed.
    // We only mark it seen once handling succeeds below — otherwise a
    // transient failure here would get swallowed as a "duplicate" on
    // Stripe's retry and the payment would never be applied.
    const { data: seen, error: seenError } = await supabase
      .from("webhook_events")
      .select("stripe_event_id")
      .eq("stripe_event_id", event.id)
      .maybeSingle();
    if (seenError) throw seenError;
    if (seen) {
      return res.status(200).json({ received: true, duplicate: true });
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const slug = session.metadata && session.metadata.slug;
      const amount = Number(session.metadata && session.metadata.amount);
      const name = (session.metadata && session.metadata.name) || slug;
      const place = (session.metadata && session.metadata.place) || "";
      const imageUrl = (session.metadata && session.metadata.image_url) || "";
      const websiteUrl = (session.metadata && session.metadata.website_url) || "";

      if (slug && Number.isInteger(amount) && amount >= 100) {
        // This row is what makes applying the payment idempotent —
        // apply_paid_listing marks it with the listing id and refuses to
        // apply the same session twice. If writing it fails we must not go
        // on to apply the payment, or a retry would have nothing to detect
        // and would add the same yen a second time.
        const { error: payError } = await supabase.from("payments").upsert(
          { stripe_session_id: session.id, amount_jpy: amount, status: "completed" },
          { onConflict: "stripe_session_id" }
        );
        if (payError) throw payError;

        const { error: rpcError } = await supabase.rpc("apply_paid_listing", {
          p_slug: slug,
          p_name: name,
          p_place: place,
          p_amount: amount,
          p_stripe_session_id: session.id,
          p_image_url: imageUrl,
          p_website_url: websiteUrl
        });
        if (rpcError) throw rpcError;
      } else {
        console.error("checkout.session.completed with missing/invalid metadata", session.id);
      }
    }

    // Idempotency guard: record the Stripe event id now that processing
    // succeeded. A concurrent duplicate delivery that slips past the check
    // above and races to this insert is still safe: apply_paid_listing and
    // the payments upsert are both keyed on stripe_session_id, so a second
    // run for the same session is a no-op, not a double-count. If another
    // event id somehow beats us to this insert, that's the same race and
    // is likewise harmless — ignore the unique_violation.
    const { error: markError } = await supabase
      .from("webhook_events")
      .insert({ stripe_event_id: event.id });
    if (markError && markError.code !== "23505") throw markError;

    return res.status(200).json({ received: true });
  } catch (e) {
    console.error("Webhook handling failed:", e);
    // A non-2xx response tells Stripe to retry this event later.
    return res.status(500).json({ error: "Webhook handling failed" });
  }
}

// Stripe needs the exact raw request bytes to verify the signature, so the
// automatic JSON body parsing has to be turned off for this function. This
// must be set on the exported handler itself, not before module.exports is
// assigned — otherwise the assignment below overwrites it and Vercel never
// sees it, silently leaving body parsing on and breaking signature checks.
handler.config = { api: { bodyParser: false } };
module.exports = handler;
