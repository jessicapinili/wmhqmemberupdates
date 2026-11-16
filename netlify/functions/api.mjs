// WMHQ Member Updates API
// Env vars (set in Netlify > Site configuration > Environment variables):
//   ADMIN_EMAIL     your admin login email
//   ADMIN_PASSWORD  your admin password (never stored in the page)
//   SESSION_SECRET  any long random text
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

const SESSION_DAYS = 7;
const sign = (v) => crypto.createHmac("sha256", process.env.SESSION_SECRET || "").update(v).digest("hex");
const makeToken = () => { const exp = Date.now() + SESSION_DAYS * 864e5; const p = `admin.${exp}`; return `${p}.${sign(p)}`; };
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function isAdmin(req) {
  const m = (req.headers.get("cookie") || "").match(/wmhq_admin=([^;]+)/);
  if (!m) return false;
  const [who, exp, sig] = decodeURIComponent(m[1]).split(".");
  if (who !== "admin" || !exp || !sig || Date.now() > +exp) return false;
  return safeEq(sig, sign(`${who}.${exp}`));
}
const cookie = (v, maxAge) => `wmhq_admin=${encodeURIComponent(v)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const clean = (s, n) => String(s || "").slice(0, n);

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/(\.netlify\/functions\/api|api)/, "") || "/";
  const store = getStore("wmhq-updates");
  const method = req.method;

  // ---------- auth ----------
  if (path === "/login" && method === "POST") {
    const { email, password } = await req.json().catch(() => ({}));
    const okEmail = safeEq(String(email || "").trim().toLowerCase(), String(process.env.ADMIN_EMAIL || "").trim().toLowerCase());
    const okPass = safeEq(String(password || ""), String(process.env.ADMIN_PASSWORD || ""));
    if (!process.env.ADMIN_PASSWORD || !process.env.SESSION_SECRET || !okEmail || !okPass) {
      await new Promise((r) => setTimeout(r, 600));
      return json({ error: "That email or password is not right." }, 401);
    }
    return json({ ok: true }, 200, { "set-cookie": cookie(makeToken(), SESSION_DAYS * 86400) });
  }
  if (path === "/logout" && method === "POST") return json({ ok: true }, 200, { "set-cookie": cookie("", 0) });
  if (path === "/me") return json({ admin: isAdmin(req) });

  // ---------- public: posts ----------
  if (path === "/posts" && method === "GET") {
    const posts = (await store.get("posts", { type: "json" })) || [];
    return json(posts, 200, { "cache-control": "no-store" });
  }

  // everything below is admin only
  if (!isAdmin(req)) return json({ error: "Please log in." }, 401);

  // ---------- members ----------
  if (path === "/members") {
    const data = (await store.get("members", { type: "json" })) || { emails: [], updated: null };
    if (method === "GET") return json(data);
    const body = await req.json().catch(() => ({}));
    let emails = new Set(data.emails);
    if (method === "POST") {
      const found = (String(body.text || "").match(EMAIL_RE) || []).map((e) => e.toLowerCase());
      if (body.replace) emails = new Set();
      found.forEach((e) => emails.add(e));
      const out = { emails: [...emails].sort(), updated: new Date().toISOString() };
      await store.setJSON("members", out);
      return json({ ...out, added: found.length });
    }
    if (method === "DELETE") {
      emails.delete(String(body.email || "").toLowerCase());
      const out = { emails: [...emails].sort(), updated: new Date().toISOString() };
      await store.setJSON("members", out);
      return json(out);
    }
  }

  // ---------- posts (admin) ----------
  if (path === "/posts") {
    let posts = (await store.get("posts", { type: "json" })) || [];
    const body = await req.json().catch(() => ({}));
    if (method === "POST") {
      const post = {
        id: crypto.randomUUID(),
        date: clean(body.date, 10) || new Date().toISOString().slice(0, 10),
        type: ["reminder", "training", "live", "resource", "update"].includes(body.type) ? body.type : "update",
        title: clean(body.title, 200),
        body: clean(body.body, 8000),
        image: /^https:\/\//.test(body.image || "") ? clean(body.image, 1000) : "",
        button: body.buttonText && /^https:\/\//.test(body.buttonUrl || "") ? { text: clean(body.buttonText, 60), url: clean(body.buttonUrl, 1000) } : null,
        pinned: !!body.pinned,
      };
      if (!post.title) return json({ error: "Add a title." }, 400);
      if (post.pinned) posts = posts.map((p) => ({ ...p, pinned: false }));
      posts.unshift(post);
      await store.setJSON("posts", posts);
      return json(post);
    }
    if (method === "DELETE") {
      posts = posts.filter((p) => p.id !== body.id);
      await store.setJSON("posts", posts);
      return json({ ok: true });
    }
  }
  return json({ error: "Not found" }, 404);
};
