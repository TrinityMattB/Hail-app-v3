module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ success: false, error: "Method not allowed" });
    return;
  }

  const isProd = process.env.NODE_ENV === "production";

  res.setHeader(
    "Set-Cookie",
    `hail_auth=; Path=/; HttpOnly; ${isProd ? "Secure;" : ""} SameSite=Lax; Max-Age=0`
  );

  res.status(200).json({ success: true });
};
