// WMHQ Member Updates API
// Env vars (set in Netlify > Site configuration > Environment variables):
//   ADMIN_EMAIL     your admin login email
//   ADMIN_PASSWORD  your admin password (never stored in the page)
//   SESSION_SECRET  any long random text
//   RESEND_API_KEY  your Resend API key (for announcement emails)
//   FROM_EMAIL      e.g. Woman Mastery HQ <updates@womanmasteryhqportal.com>
//   SITE_URL        e.g. https://wmhqmemberupdates.womanmasteryhqportal.com
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


// ---------- email ----------
const escH = (t) => String(t || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const unsubToken = (email) => sign("unsub:" + email.toLowerCase()).slice(0, 32);
const siteUrl = () => (process.env.SITE_URL || "").replace(/\/$/, "");
function emailHtml(post, email) {
  const paras = escH(post.body).split(/\n\s*\n/).filter(Boolean).map((p) => `<p style="margin:0 0 14px 0;font-size:15px;line-height:1.6;color:#4a1a22;">${p.replace(/\n/g, "<br>")}</p>`).join("");
  const bUrl = post.button ? escH(post.button.url) : siteUrl(), bText = post.button ? escH(post.button.text) : "See all announcements";
  const btn = `<a href="${bUrl}" target="_blank" style="display:inline-block;background:#660810;color:#ffffff;font-weight:700;font-size:14px;text-decoration:none;padding:14px 28px;border-radius:100px;margin-top:6px;">${bText}</a>`;
  const unsub = `${siteUrl()}/api/unsubscribe?e=${encodeURIComponent(email)}&t=${unsubToken(email)}`;
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f0f0f0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f0f0f0;"><tr><td align="center" style="padding:36px 12px;">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="width:100%;max-width:480px;background:#ffffff;border-radius:18px;overflow:hidden;font-family:Helvetica,Arial,sans-serif;">
<tr><td style="background:#3B0E11;padding:26px 32px;">
<div style="font-size:18px;font-weight:700;color:#ffffff;">Woman Mastery HQ Membership</div>
<div style="font-size:10px;font-weight:700;letter-spacing:3px;color:#EBC7D0;text-transform:uppercase;margin-top:8px;">WMHQ Member Announcements &amp; Updates</div></td></tr>
<tr><td style="padding:30px 32px 32px 32px;">
<h1 style="margin:0 0 14px 0;font-size:22px;line-height:1.25;color:#1a0a0a;">${escH(post.title)}</h1>
${paras}${btn}
</td></tr></table>
<p style="font-family:Helvetica,Arial,sans-serif;font-size:11px;color:#7a5a5a;margin:18px 0 0 0;">You’re getting this because you’re a WMHQ member. <a href="${unsub}" style="color:#7a5a5a;">Unsubscribe from updates</a></p>
</td></tr></table></body></html>`;
}
async function sendEmails(post, recipients) {
  const key = process.env.RESEND_API_KEY, from = process.env.FROM_EMAIL;
  if (!key || !from || !siteUrl()) throw new Error("Email is not set up yet. Add RESEND_API_KEY, FROM_EMAIL and SITE_URL in Netlify, then redeploy.");
  let sent = 0, failed = 0;
  for (let i = 0; i < recipients.length; i += 100) {
    const chunk = recipients.slice(i, i + 100).map((to) => ({
      from, to: [to], subject: post.title, html: emailHtml(post, to),
      headers: { "List-Unsubscribe": `<${siteUrl()}/api/unsubscribe?e=${encodeURIComponent(to)}&t=${unsubToken(to)}>` },
    }));
    const r = await fetch("https://api.resend.com/emails/batch", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(chunk) });
    if (r.ok) sent += chunk.length; else { failed += chunk.length; console.log("Resend error", r.status, await r.text()); }
  }
  return { sent, failed };
}
const buildPost = (body) => ({
  id: crypto.randomUUID(),
  date: clean(body.date, 10) || new Date().toISOString().slice(0, 10),
  type: ["reminder", "training", "live", "resource", "update"].includes(body.type) ? body.type : "update",
  title: clean(body.title, 200),
  body: clean(body.body, 8000),
  image: /^https:\/\//.test(body.image || "") ? clean(body.image, 1000) : "",
  button: body.buttonText && /^https:\/\//.test(body.buttonUrl || "") ? { text: clean(body.buttonText, 60), url: clean(body.buttonUrl, 1000) } : null,
  pinned: !!body.pinned,
});

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/(\.netlify\/functions\/api|api)/, "") || "/";
  const store = getStore("wmhq-updates");
  const method = req.method;

  // ---------- auth ----------
  if (path === "/login" && method === "POST") {
    const { email, password } = await req.json().catch(() => ({}));
    const missing = ["ADMIN_EMAIL", "ADMIN_PASSWORD", "SESSION_SECRET"].filter((k) => !String(process.env[k] || "").trim());
    if (missing.length) return json({ error: `Admin login is not set up yet. Missing in Netlify: ${missing.join(", ")}. Add them, then redeploy.` }, 500);
    const okEmail = safeEq(String(email || "").trim().toLowerCase(), String(process.env.ADMIN_EMAIL).trim().toLowerCase());
    const okPass = safeEq(String(password || "").trim(), String(process.env.ADMIN_PASSWORD).trim());
    if (!okEmail || !okPass) {
      await new Promise((r) => setTimeout(r, 600));
      return json({ error: !okEmail ? "That email is not the admin email." : "That password is not right." }, 401);
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

  // ---------- public: unsubscribe ----------
  if (path === "/unsubscribe") {
    const e = String(url.searchParams.get("e") || "").toLowerCase(), t = url.searchParams.get("t") || "";
    const page = (msg) => new Response(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:Helvetica,Arial,sans-serif;background:#f0f0f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0"><div style="background:#fff;border-radius:18px;padding:32px;max-width:420px;text-align:center"><h1 style="font-size:20px;color:#3B0E11">${msg}</h1><p style="color:#7a5a5a;font-size:14px">WMHQ Member Updates</p></div></body>`, { headers: { "content-type": "text/html" } });
    if (!e || !safeEq(t, unsubToken(e))) return page("That link isn’t valid.");
    const u = (await store.get("unsubscribed", { type: "json" })) || [];
    if (!u.includes(e)) { u.push(e); await store.setJSON("unsubscribed", u); }
    return page("You’re unsubscribed from WMHQ update emails.");
  }

  // everything below is admin only
  if (!isAdmin(req)) return json({ error: "Please log in." }, 401);

  // ---------- members ----------
  if (path === "/members") {
    const data = (await store.get("members", { type: "json" })) || { emails: [], updated: null };
    if (method === "GET") { const u = (await store.get("unsubscribed", { type: "json" })) || []; return json({ ...data, unsubscribed: u.length }); }
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
      const post = buildPost(body);
      if (!post.title) return json({ error: "Add a title." }, 400);
      if ((body.buttonText && !post.button) || (body.buttonUrl && !body.buttonText)) return json({ error: "For a button, add both the button text and a full link starting with https://" }, 400);
      if (body.testOnly) {
        const r = await sendEmails(post, [String(process.env.ADMIN_EMAIL).trim()]).catch((e) => ({ error: e.message }));
        return r.error ? json({ error: r.error }, 400) : json({ test: true, ...r });
      }
      if (post.pinned) posts = posts.map((p) => ({ ...p, pinned: false }));
      posts.unshift(post);
      await store.setJSON("posts", posts);
      let email = null;
      if (body.sendEmail) {
        const members = ((await store.get("members", { type: "json" })) || { emails: [] }).emails;
        const unsub = new Set((await store.get("unsubscribed", { type: "json" })) || []);
        const to = members.filter((m) => !unsub.has(m));
        email = await sendEmails(post, to).catch((e) => ({ error: e.message }));
      }
      return json({ ...post, email });
    }
    if (method === "DELETE") {
      posts = posts.filter((p) => p.id !== body.id);
      await store.setJSON("posts", posts);
      return json({ ok: true });
    }
  }
  return json({ error: "Not found" }, 404);
};
