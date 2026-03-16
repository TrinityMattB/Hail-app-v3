const crypto = require("crypto");

function sign(value, secret) {
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}

function parseCookies(cookieHeader = "") {
  return Object.fromEntries(
    String(cookieHeader)
      .split(";")
      .map((v) => v.trim())
      .filter(Boolean)
      .map((part) => {
        const idx = part.indexOf("=");
        return [part.slice(0, idx), part.slice(idx + 1)];
      })
  );
}

function verifyToken(token, secret) {
  if (!token) return false;

  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const parts = decoded.split(":");
    if (parts.length !== 3) return false;

    const [username, ts, sig] = parts;
    if (!username || !ts || !sig) return false;

    const payload = `${username}:${ts}`;
    const expected = sign(payload, secret);

    if (sig !== expected) return false;

    const ageMs = Date.now() - Number(ts);
    const maxAgeMs = 1000 * 60 * 60 * 24 * 14; // 14 days
    if (Number.isNaN(ageMs) || ageMs > maxAgeMs) return false;

    return true;
  } catch {
    return false;
  }
}

async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const sessionSecret = process.env.APP_SESSION_SECRET;

  if (!apiKey) {
    res.status(500).json({ error: { message: "Missing ANTHROPIC_API_KEY." } });
    return;
  }

  if (!sessionSecret) {
    res.status(500).json({ error: { message: "Missing APP_SESSION_SECRET." } });
    return;
  }

  const cookies = parseCookies(req.headers.cookie || "");
  const token = cookies.hail_auth;

  if (!verifyToken(token, sessionSecret)) {
    res.status(401).json({ error: { message: "Unauthorized." } });
    return;
  }

  try {
    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body;

    if (!body || typeof body !== "object") {
      res.status(400).json({ error: { message: "Invalid request body." } });
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 240000); // 4 minutes

    let upstream;
    try {
      upstream = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    const text = await upstream.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      console.error("Anthropic returned non-JSON:", text.slice(0, 500));
      res.status(502).json({
        error: {
          message: `Anthropic API returned unexpected response: ${text.slice(0, 200)}`,
        },
      });
      return;
    }

    res.status(upstream.status).json(data);
  } catch (err) {
    const message =
      err?.name === "AbortError"
        ? "Anthropic request timed out before completion."
        : err?.message || "Anthropic proxy failed.";

    console.error("api/anthropic.js error:", err);

    res.status(500).json({
      error: { message },
    });
  }
}

module.exports = handler;
module.exports.config = {
  maxDuration: 300,
};
