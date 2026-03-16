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
    const maxAgeMs = 1000 * 60 * 60 * 24 * 14;
    if (Number.isNaN(ageMs) || ageMs > maxAgeMs) return false;

    return true;
  } catch {
    return false;
  }
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const secret = process.env.APP_SESSION_SECRET;

  if (!secret) {
    res.status(500).json({ authenticated: false });
    return;
  }

  const cookies = parseCookies(req.headers.cookie || "");
  const token = cookies.hail_auth;

  res.status(200).json({
    authenticated: verifyToken(token, secret),
  });
};
