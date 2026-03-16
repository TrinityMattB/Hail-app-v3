import { Redis } from "https://esm.sh/@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function getSessionId(req) {
  const raw = req.headers["cookie"] || "";
  const match = raw.match(/session=([a-f0-9]{64})/);
  return match ? match[1] : null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const id = getSessionId(req);
  if (!id) return res.status(401).json({ error: "Unauthorized" });

  const valid = await redis.get(`session:${id}`);
  if (!valid) return res.status(401).json({ error: "Unauthorized" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured." });

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05",
      },
      body: JSON.stringify(req.body),
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message || "Anthropic request failed." });
  }
}
