const crypto = require("crypto");

function safeEqual(a = "", b = "") {
  const aBuf = Buffer.from(String(a));
  const bBuf = Buffer.from(String(b));
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function sign(value, secret) {
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}

function createToken(username, secret) {
  const ts = Date.now().toString();
  const payload = `${username}:${ts}`;
  const sig = sign(payload, secret);
  return Buffer.from(`${payload}:${sig}`).toString("base64url");
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ success: false, error: "Method not allowed" });
    return;
  }

  const APP_USERNAME = process.env.APP_USERNAME;
  const APP_PASSWORD = process.env.APP_PASSWORD;
  const APP_SESSION_SECRET = process.env.APP_SESSION_SECRET;

  if (!APP_USERNAME || !APP_PASSWORD || !APP_SESSION_SECRET) {
    res.status(500).json({
      success: false,
      error: "Missing auth environment variables.",
    });
    return;
  }

  try {
    const { username, password } = req.body || {};

    if (!safeEqual(username, APP_USERNAME) || !safeEqual(password, APP_PASSWORD)) {
      res.status(401).json({ success: false, error: "Invalid credentials." });
      return;
    }

    const token = createToken(username, APP_SESSION_SECRET);
    const isProd = process.env.NODE_ENV === "production";

    res.setHeader(
      "Set-Cookie",
      `hail_auth=${token}; Path=/; HttpOnly; ${isProd ? "Secure;" : ""} SameSite=Lax; Max-Age=${60 * 60 * 24 * 14}`
    );

    res.status(200).json({ success: true });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message || "Login failed.",
    });
  }
};
