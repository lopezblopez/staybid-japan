// Vercel Serverless Function — returns the current paid ranking from the DB.
// Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
const { createClient } = require("@supabase/supabase-js");

module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data, error } = await supabase
      .from("listings")
      .select("name, place, slug, total_paid_jpy, image_url, website_url")
      .order("total_paid_jpy", { ascending: false });
    if (error) throw error;

    const listings = (data || []).map((x) => ({
      name: x.name,
      place: x.place || "",
      slug: x.slug,
      paid: Number(x.total_paid_jpy),
      imageUrl: x.image_url || "",
      websiteUrl: x.website_url || ""
    }));

    res.setHeader("Cache-Control", "s-maxage=5, stale-while-revalidate=30");
    return res.status(200).json({ listings });
  } catch (e) {
    console.error("Could not load rankings:", e);
    return res.status(500).json({ error: "Could not load rankings" });
  }
};
