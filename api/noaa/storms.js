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

function buildBbox(lat, lon, radiusMiles) {
  const deg = radiusMiles / 69;
  return `${lon - deg},${lat - deg},${lon + deg},${lat + deg}`;
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).end();

  const id = getSessionId(req);
  if (!id) return res.status(401).json({ error: "Unauthorized" });

  const valid = await redis.get(`session:${id}`);
  if (!valid) return res.status(401).json({ error: "Unauthorized" });

  const { lat, lon, radiusMiles, startDate, endDate } = req.query;

  if (!lat || !lon) return res.status(400).json({ error: "lat and lon are required." });

  try {
    const noaaKey = process.env.NOAA_API_KEY;
    const headers = noaaKey
      ? { token: noaaKey, "Content-Type": "application/json" }
      : { "Content-Type": "application/json" };

    const response = await fetch(
      `https://www.ncdc.noaa.gov/cdo-web/api/v2/data?datasetid=GHCND&datatypeid=HPCP&lat=${lat}&lon=${lon}&radius=${radiusMiles || 50}&startdate=${startDate}&enddate=${endDate}&limit=100`,
      { headers }
    );

    if (!response.ok) {
      return res.json({ results: [], note: "NOAA data unavailable — interpolation only." });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.json({ results: [], note: "NOAA data unavailable — interpolation only." });
  }
}
