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
  if (!id) return res.json({ authenticated: false });

  const valid = await redis.get(`session:${id}`);
  res.json({ authenticated: Boolean(valid) });
}
