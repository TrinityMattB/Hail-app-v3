import crypto from "crypto";
import { Redis } from "https://esm.sh/@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const { username, password } = req.body || {};
  const validUser = process.env.APP_USERNAME || "trinity";
  const validPass = process.env.APP_PASSWORD || "weather2024";

  if (username === validUser && password === validPass) {
    const id = crypto.randomBytes(32).toString("hex");
    await redis.set(`session:${id}`, "1", { ex: 86400 });
    res.setHeader(
      "Set-Cookie",
      `session=${id}; HttpOnly; Path=/; SameSite=Strict; Max-Age=86400`
    );
    return res.json({ success: true });
  }

  res.status(401).json({ success: false, error: "Invalid credentials." });
}
