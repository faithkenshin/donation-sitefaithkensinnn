// Donation backend: Node 18+  |  npm i express
// Run:  PAYSTACK_SECRET=sk_test_xxx SITE_URL=http://localhost:3000 node server.js
// Paystack handles NGN cards, transfers and USSD. To use Stripe instead, swap the two
// fetch calls for stripe.checkout.sessions.create() and stripe.webhooks.constructEvent().
const express = require("express");
const crypto = require("crypto");
const path = require("path");

const { PAYSTACK_SECRET, SITE_URL = "http://localhost:3000", PORT = 3000 } = process.env;
if (!PAYSTACK_SECRET) { console.error("Set PAYSTACK_SECRET"); process.exit(1); }

const app = express();
const CAUSES = new Set(["food", "school", "water", "health"]);
const donations = new Map(); // replace with a real database (Postgres, MongoDB, etc.)

// Webhook needs the RAW body for signature verification, so register it before express.json().
app.post("/api/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const sig = crypto.createHmac("sha512", PAYSTACK_SECRET).update(req.body).digest("hex");
  const given = Buffer.from(req.get("x-paystack-signature") || "", "utf8");
  const want = Buffer.from(sig, "utf8");
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return res.sendStatus(401);

  const event = JSON.parse(req.body);
  if (event.event === "charge.success") {
    const d = event.data;
    const rec = donations.get(d.reference);
    // Trust the verified webhook, not the browser: confirm the amount matches what we created.
    if (rec && d.amount === rec.amountKobo && d.currency === "NGN") {
      rec.status = "paid";
      // TODO: send receipt email, update campaign totals, add to donor wall (unless rec.anonymous).
      console.log("Paid:", d.reference, rec.cause, rec.amountKobo / 100);
    }
  }
  res.sendStatus(200); // always acknowledge quickly
});

app.use(express.json({ limit: "10kb" }));
app.use(express.static(__dirname)); // serves index.html

// Basic in-memory rate limit: 10 requests per minute per IP. Use a proper limiter in production.
const hits = new Map();
const limit = (req, res, next) => {
  const k = req.ip, now = Date.now(), arr = (hits.get(k) || []).filter(t => now - t < 60000);
  if (arr.length >= 10) return res.status(429).json({ error: "Too many requests" });
  arr.push(now); hits.set(k, arr); next();
};

app.post("/api/donate", limit, async (req, res) => {
  const { name, email, amountNGN, cause, monthly, anonymous } = req.body || {};
  // Validate everything server-side. Never trust the browser.
  if (typeof name !== "string" || name.trim().length < 2 || name.length > 100) return res.status(400).json({ error: "Invalid name" });
  if (typeof email !== "string" || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: "Invalid email" });
  if (!Number.isFinite(amountNGN) || amountNGN < 500 || amountNGN > 50_000_000) return res.status(400).json({ error: "Invalid amount" });
  if (!CAUSES.has(cause)) return res.status(400).json({ error: "Invalid cause" });

  const reference = "HT_" + crypto.randomBytes(10).toString("hex");
  const amountKobo = Math.round(amountNGN) * 100;
  try {
    const r = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        email, amount: amountKobo, currency: "NGN", reference,
        callback_url: `${SITE_URL}/?thanks=${reference}`,
        metadata: { name: name.trim(), cause, anonymous: !!anonymous, monthly: !!monthly },
        // Monthly giving: create a Plan in your Paystack dashboard and add  plan: "PLN_xxx"  here.
      }),
    });
    const j = await r.json();
    if (!j.status) throw new Error(j.message);
    donations.set(reference, { name, email, cause, amountKobo, anonymous: !!anonymous, status: "pending" });
    res.json({ url: j.data.authorization_url });
  } catch (e) {
    console.error("Initialize failed:", e.message);
    res.status(502).json({ error: "Payment provider unavailable" });
  }
});

app.listen(PORT, () => console.log(`Running on ${SITE_URL}`));
