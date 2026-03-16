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
  if (id) await redis.del(`session:${id}`);

  res.setHeader("Set-Cookie", "session=; HttpOnly; Path=/; Max-Age=0");
  res.json({ success: true });
}
