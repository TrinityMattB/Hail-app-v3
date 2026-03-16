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
  if (req.method !== "GET") return res.status(405).end();

  const id = getSessionId(req);
  if (!id) return res.status(401).json({ error: "Unauthorized" });

  const valid = await redis.get(`session:${id}`);
  if (!valid) return res.status(401).json({ error: "Unauthorized" });

  const { lat, lon, date } = req.query;
  const apiKey = process.env.VISUAL_CROSSING_KEY;

  if (!apiKey) return res.status(500).json({ error: "VISUAL_CROSSING_KEY not configured." });
  if (!lat || !lon || !date) return res.status(400).json({ error: "lat, lon, and date are required." });

  try {
    const url = `https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/${lat},${lon}/${date}?unitGroup=us&include=hours,days,stations&key=${apiKey}&contentType=json`;

    const response = await fetch(url);
    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: `Visual Crossing error: ${text.slice(0, 200)}` });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message || "Weather station request failed." });
  }
}
