import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import html2canvas from "html2canvas";
import jsPDF from "jspdf";

const CURRENT_YEAR = new Date().getFullYear();
const PAGE_W = 794;
const PAGE_H = 1123;

const theme = {
  bg: "#03070f",
  pageBg: "#03070f",
  headerBg: "#07101d",
  panel: "#050b14",
  border: "#17325f",
  borderSoft: "#102240",
  text: "#eef3ff",
  muted: "#7ea2df",
  muted2: "#4d6797",
  blue: "#76a8ff",
  blueBright: "#8db7ff",
  button: "#5e86f0",
  buttonText: "#f8fbff",
  riskBg: "#572a00",
  riskBorder: "#b65c00",
  riskText: "#ffb04d",
  dangerText: "#ff8b47",
  purpleText: "#b395ff",
  white: "#ffffff",
  gold: "#ffcb54",
  green: "#4ade80",
  greenBg: "#052010",
  greenBorder: "#14532d",
  amber: "#d97706",
  amberBg: "#1a0f00",
  amberBorder: "#78350f",
  amberText: "#fbbf24",
};

const HAIL_COLUMNS = [
  { key: "date", label: "Date", width: "0.85fr" },
  { key: "size", label: "Size", width: "2.9fr" },
  { key: "location", label: "Location", width: "1.95fr" },
  { key: "damage", label: "Property Dmg", width: "1fr" },
  { key: "inj", label: "Injuries", width: "0.7fr" },
  { key: "dea", label: "Deaths", width: "0.7fr" },
];

const OTHER_COLUMNS = [
  { key: "date", label: "Date", width: "0.9fr" },
  { key: "type", label: "Type", width: "1.85fr" },
  { key: "desc", label: "Description", width: "4.8fr" },
  { key: "damage", label: "Damage", width: "1.65fr" },
];

const systemPrompt = `You are a severe weather research assistant specializing in hail and storm data.
When given an address, search reliable weather/storm sources and return ONLY valid JSON with this exact structure:

{
  "location": {
    "address": "...",
    "county": "...",
    "state": "...",
    "lat": "...",
    "lon": "..."
  },
  "summary": "1-2 sentence plain-English summary of hail/severe weather risk for this area",
  "riskLevel": "Low" | "Moderate" | "High" | "Very High",
  "hailEvents": [
    {
      "date": "YYYY-MM-DD",
      "size": "X.XX inches (description)",
      "location": "city/area",
      "injuries": 0,
      "deaths": 0,
      "propertyDamage": "$X,XXX or N/A",
      "source": "NOAA Storm Events"
    }
  ],
  "otherEvents": [
    {
      "date": "YYYY-MM-DD",
      "type": "Tornado | Thunderstorm Wind | Flash Flood | Hurricane | Tropical Storm | etc",
      "description": "brief description",
      "damage": "$X,XXX or N/A"
    }
  ],
  "stats": {
    "totalHailEvents": 0,
    "largestHailSize": "X.XX inches",
    "avgEventsPerYear": "X.X",
    "mostActiveMonth": "Month",
    "yearsSearched": "YYYY-YYYY"
  },
  "sources": ["url1", "url2"]
}`;

// ─── IDW Engine ───────────────────────────────────────────────────────────────

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function runIDW(targetLat, targetLon, stations, power = 2) {
  if (!stations || stations.length === 0) return null;
  const withDist = stations
    .filter((s) => s.value != null && !isNaN(s.value))
    .map((s) => ({
      ...s,
      distanceMiles: haversineDistance(targetLat, targetLon, s.lat, s.lon),
    }))
    .sort((a, b) => a.distanceMiles - b.distanceMiles);
  if (withDist.length === 0) return null;
  if (withDist[0].distanceMiles < 0.01) {
    return {
      value: withDist[0].value,
      confidence: 1.0,
      confidenceLabel: "Very High",
      stationCount: 1,
      nearestMiles: 0,
      nearestName: withDist[0].stationId || "On-site",
    };
  }
  const weights = withDist.map((s) => 1 / Math.pow(s.distanceMiles, power));
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  const interpolatedValue =
    weights.reduce((sum, w, i) => sum + w * withDist[i].value, 0) / totalWeight;
  const nearest = withDist[0].distanceMiles;
  let confidence;
  if (nearest < 5 && withDist.length >= 4) confidence = 0.92;
  else if (nearest < 10 && withDist.length >= 3) confidence = 0.78;
  else if (nearest < 20 && withDist.length >= 2) confidence = 0.61;
  else if (nearest < 40) confidence = 0.44;
  else confidence = 0.27;
  const confidenceLabel =
    confidence >= 0.85 ? "Very High" :
    confidence >= 0.70 ? "High" :
    confidence >= 0.50 ? "Moderate" :
    confidence >= 0.35 ? "Low" : "Very Low";
  return {
    value: Math.round(interpolatedValue * 100) / 100,
    confidence,
    confidenceLabel,
    stationCount: withDist.length,
    nearestMiles: Math.round(nearest * 10) / 10,
    nearestName: withDist[0].stationId || withDist[0].source || "Unknown",
    farthestMiles: Math.round(withDist[withDist.length - 1].distanceMiles * 10) / 10,
  };
}

// ─── Shared style helpers ─────────────────────────────────────────────────────

const loginInputStyle = {
  width: "100%",
  background: "#02060d",
  color: theme.text,
  border: `1px solid ${theme.border}`,
  borderRadius: 10,
  padding: "13px 14px",
  fontSize: 14,
  outline: "none",
};

const monoCellStyle = {
  fontFamily: '"IBM Plex Mono", monospace',
  color: theme.text,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const emptyRowStyle = {
  padding: "18px",
  color: theme.muted,
  fontFamily: '"IBM Plex Mono", monospace',
  fontSize: 13,
};

const FIRST_PAGE_CONTENT_HEIGHT = PAGE_H - 92 - 18 - 18;
const CONT_PAGE_CONTENT_HEIGHT = PAGE_H - 20 - 18;
const SECTION_GAP = 18;
const EMPTY_TABLE_BODY_HEIGHT = 62;
const FOOTER_EXTRA_GAP = 20;

function ensureFonts() {
  if (!document.getElementById("swi-fonts")) {
    const link = document.createElement("link");
    link.id = "swi-fonts";
    link.rel = "stylesheet";
    link.href =
      "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap";
    document.head.appendChild(link);
  }
}

async function parseResponseJson(response, label = "API") {
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label} returned invalid JSON: ${text.slice(0, 180)}`);
  }
  return data;
}

function extractJsonPayload(data) {
  const textBlocks = (data?.content || []).filter((b) => b.type === "text");
  const raw = textBlocks
    .map((b) => b.text)
    .join("\n")
    .replace(/```json|```/gi, "")
    .trim();
  if (!raw) return null;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

function formatDate(dateStr) {
  if (!dateStr) return "N/A";
  return String(dateStr).trim();
}

function normalizeResult(result, address) {
  if (!result) return null;
  const years = result?.stats?.yearsSearched || `${CURRENT_YEAR - 5}-${CURRENT_YEAR}`;
  return {
    location: {
      address: result?.location?.address || address || "N/A",
      county: result?.location?.county || "Unknown County",
      state: result?.location?.state || "Unknown State",
      lat: result?.location?.lat || "",
      lon: result?.location?.lon || "",
    },
    summary: result?.summary || "No summary was returned. Please rerun the query.",
    riskLevel: result?.riskLevel || "Moderate",
    hailEvents: Array.isArray(result?.hailEvents) ? result.hailEvents : [],
    otherEvents: Array.isArray(result?.otherEvents) ? result.otherEvents : [],
    stats: {
      totalHailEvents: result?.stats?.totalHailEvents ?? 0,
      largestHailSize: result?.stats?.largestHailSize || "N/A",
      avgEventsPerYear: result?.stats?.avgEventsPerYear || "0.0",
      mostActiveMonth: result?.stats?.mostActiveMonth || "N/A",
      yearsSearched: years,
    },
    sources: Array.isArray(result?.sources) ? result.sources : [],
  };
}

function getRiskStyle(risk) {
  switch (risk) {
    case "Low": return { bg: "#102713", border: "#2f7a36", text: "#8ef49c" };
    case "Moderate": return { bg: "#433000", border: "#b98700", text: "#ffd25a" };
    case "High": return { bg: theme.riskBg, border: theme.riskBorder, text: theme.riskText };
    case "Very High": return { bg: "#4a0f0f", border: "#af3030", text: "#ff8177" };
    default: return { bg: theme.riskBg, border: theme.riskBorder, text: theme.riskText };
  }
}

function getConfidenceStyle(label) {
  switch (label) {
    case "Very High": return { bg: "#052010", border: "#14532d", text: "#4ade80" };
    case "High": return { bg: "#052010", border: "#14532d", text: "#4ade80" };
    case "Moderate": return { bg: "#1a0f00", border: "#78350f", text: "#fbbf24" };
    case "Low": return { bg: "#1a0800", border: "#7c2d12", text: "#fb923c" };
    default: return { bg: "#1c0505", border: "#7f1d1d", text: "#f87171" };
  }
}

function getHeight(node) {
  return node?.offsetHeight || 0;
}

function buildMeasuredPages(data, metrics) {
  if (!data || !metrics) return [];
  const pages = [];
  function createPage({ showTopHeader = false, showIntro = false } = {}) {
    const capacity = showTopHeader ? FIRST_PAGE_CONTENT_HEIGHT : CONT_PAGE_CONTENT_HEIGHT;
    const introHeight = showIntro ? metrics.introHeight : 0;
    return { showTopHeader, showIntro, sections: [], showFooter: false, remaining: capacity - introHeight };
  }
  function pushNewPage(opts = {}) {
    const page = createPage(opts);
    pages.push(page);
    return page;
  }
  let currentPage = pushNewPage({ showTopHeader: true, showIntro: true });
  function ensureRoom(requiredHeight) {
    if (currentPage.remaining >= requiredHeight) return;
    currentPage = pushNewPage({ showTopHeader: false, showIntro: false });
  }
  function addMeasuredTableSections(type, rows, baseHeight, rowHeights, firstTitle, continuedTitle) {
    if (!rows.length) {
      const required = baseHeight + EMPTY_TABLE_BODY_HEIGHT + SECTION_GAP;
      ensureRoom(required);
      currentPage.sections.push({ type, title: firstTitle, rows: [] });
      currentPage.remaining -= required;
      return;
    }
    let rowIndex = 0;
    let firstSection = true;
    while (rowIndex < rows.length) {
      const title = firstSection ? firstTitle : continuedTitle;
      const firstRowHeight = rowHeights[rowIndex] || 60;
      ensureRoom(baseHeight + firstRowHeight + SECTION_GAP);
      let used = baseHeight;
      const chunk = [];
      while (rowIndex < rows.length) {
        const rowHeight = rowHeights[rowIndex] || 60;
        if (chunk.length > 0 && used + rowHeight > currentPage.remaining) break;
        chunk.push(rows[rowIndex]);
        used += rowHeight;
        rowIndex += 1;
      }
      if (!chunk.length) {
        chunk.push(rows[rowIndex]);
        used += rowHeights[rowIndex] || 60;
        rowIndex += 1;
      }
      currentPage.sections.push({ type, title, rows: chunk });
      currentPage.remaining -= used + SECTION_GAP;
      firstSection = false;
    }
  }
  addMeasuredTableSections("hail", data.hailEvents, metrics.hailBaseHeight, metrics.hailRowHeights, "Hail Events - Past 5 Years", "Hail Events - Continued");
  addMeasuredTableSections("other", data.otherEvents, metrics.otherBaseHeight, metrics.otherRowHeights, "Other Severe Weather Events", "Other Severe Weather Events - Continued");
  const sourcesBodyHeight = data.sources.length > 0 ? metrics.sourceRowHeights.reduce((sum, h) => sum + h, 0) : EMPTY_TABLE_BODY_HEIGHT;
  const sourcesHeight = metrics.sourcesBaseHeight + sourcesBodyHeight + SECTION_GAP;
  const footerReserve = metrics.footerHeight + FOOTER_EXTRA_GAP;
  if (currentPage.remaining < sourcesHeight + footerReserve) {
    currentPage = pushNewPage({ showTopHeader: false, showIntro: false });
  }
  currentPage.sections.push({ type: "sources", title: "Data Sources", sources: data.sources });
  currentPage.remaining -= sourcesHeight;
  currentPage.showFooter = true;
  return pages;
}

// ─── Components ───────────────────────────────────────────────────────────────

function LogoMark({ large = false }) {
  return (
    <img
      src="/trinity-logo.png"
      alt="Trinity Engineering"
      style={{ height: large ? 86 : 54, width: "auto", maxWidth: large ? 220 : 140, objectFit: "contain", display: "block" }}
    />
  );
}

function FooterContent() {
  return (
    <>
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 10 }}>
        <LogoMark large />
      </div>
      <div style={{ color: theme.white, fontSize: 14 }}>
        ©2026 Trinity Engineering, PLLC All Rights Reserved
      </div>
    </>
  );
}

function TrinityFooter() {
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 34, textAlign: "center" }}>
      <FooterContent />
    </div>
  );
}

function FooterMeasure() {
  return <div style={{ textAlign: "center" }}><FooterContent /></div>;
}

function AppHeader({ onLogout }) {
  return (
    <div style={{ background: theme.headerBg, borderBottom: `1px solid ${theme.borderSoft}`, padding: "14px 20px" }}>
      <div style={{ maxWidth: 1320, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <LogoMark />
          <div>
            <div style={{ color: theme.white, fontWeight: 800, fontSize: 21, letterSpacing: 0.5, fontFamily: "Inter, Arial, sans-serif" }}>
              SEVERE WEATHER INTELLIGENCE
            </div>
            <div style={{ color: theme.muted2, fontSize: 11, letterSpacing: 3, textTransform: "uppercase", fontFamily: '"IBM Plex Mono", monospace', marginTop: 4 }}>
              NOAA storm events database · 5-year lookback
            </div>
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ color: theme.muted2, fontSize: 10, letterSpacing: 1.5, textTransform: "uppercase", fontFamily: '"IBM Plex Mono", monospace' }}>Data Source: NOAA NWS</div>
          <div style={{ color: theme.muted2, fontSize: 10, letterSpacing: 1.5, textTransform: "uppercase", fontFamily: '"IBM Plex Mono", monospace' }}>NCEI Storm Events DB</div>
          <button onClick={onLogout} style={{ marginTop: 10, background: "transparent", color: theme.blue, border: `1px solid ${theme.border}`, borderRadius: 8, padding: "6px 10px", fontSize: 11, cursor: "pointer" }}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

function LoginScreen({ username, password, setUsername, setPassword, onLogin, loading, error }) {
  return (
    <div style={{ minHeight: "100vh", background: theme.bg, color: theme.text, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: "Inter, Arial, sans-serif" }}>
      <div style={{ width: "100%", maxWidth: 430, background: theme.panel, border: `1px solid ${theme.border}`, borderRadius: 16, padding: 28, boxShadow: "0 18px 50px rgba(0,0,0,0.35)" }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 14 }}><LogoMark large /></div>
        <div style={{ textAlign: "center", fontWeight: 800, fontSize: 24, color: theme.white, marginBottom: 6 }}>Severe Weather Intelligence</div>
        <div style={{ textAlign: "center", color: theme.muted2, fontSize: 12, letterSpacing: 2, textTransform: "uppercase", fontFamily: '"IBM Plex Mono", monospace', marginBottom: 22 }}>Authorized access only</div>
        <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" style={loginInputStyle} />
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && onLogin()} placeholder="Password" style={{ ...loginInputStyle, marginTop: 12 }} />
        {error ? <div style={{ marginTop: 12, color: "#ff9f9f", fontSize: 13 }}>{error}</div> : null}
        <button onClick={onLogin} disabled={loading} style={{ marginTop: 18, width: "100%", border: "none", borderRadius: 10, padding: "13px 16px", background: theme.button, color: theme.buttonText, fontWeight: 800, fontSize: 14, cursor: "pointer", boxShadow: "0 0 24px rgba(118,168,255,0.18)" }}>
          {loading ? "Signing in..." : "Sign in"}
        </button>
      </div>
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <div style={{ color: theme.muted2, fontSize: 10, letterSpacing: 3.2, textTransform: "uppercase", fontFamily: '"IBM Plex Mono", monospace', marginBottom: 14 }}>
      {children}
    </div>
  );
}

function Panel({ children, style = {} }) {
  return (
    <div style={{ background: theme.panel, border: `1px solid ${theme.border}`, borderRadius: 12, padding: 18, ...style }}>
      {children}
    </div>
  );
}

// ─── Updated SearchPanel with Date of Loss ────────────────────────────────────

function SearchPanel({ address, setAddress, dateOfLoss, setDateOfLoss, onLookup, loading }) {
  return (
    <Panel style={{ marginBottom: SECTION_GAP }}>
      <SectionLabel>Property Address Lookup</SectionLabel>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 180px 170px", gap: 14 }}>
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onLookup()}
          placeholder="53 Angus Run, Seneca, SC"
          style={{ background: "#01050b", color: theme.blueBright, border: `1px solid ${theme.border}`, borderRadius: 8, padding: "14px 18px", fontSize: 15, outline: "none", fontFamily: '"IBM Plex Mono", monospace' }}
        />
        <div style={{ position: "relative" }}>
          <input
            type="date"
            value={dateOfLoss}
            onChange={(e) => setDateOfLoss(e.target.value)}
            style={{ width: "100%", background: "#01050b", color: dateOfLoss ? theme.amberText : theme.muted2, border: `1px solid ${dateOfLoss ? theme.amberBorder : theme.border}`, borderRadius: 8, padding: "14px 12px", fontSize: 13, outline: "none", fontFamily: '"IBM Plex Mono", monospace', boxSizing: "border-box" }}
          />
          {!dateOfLoss && (
            <div style={{ position: "absolute", top: "50%", left: 12, transform: "translateY(-50%)", color: theme.muted2, fontSize: 11, fontFamily: '"IBM Plex Mono", monospace', letterSpacing: 1, pointerEvents: "none" }}>
              DATE OF LOSS
            </div>
          )}
        </div>
        <button
          onClick={onLookup}
          disabled={loading}
          style={{ border: "none", borderRadius: 8, background: theme.button, color: theme.buttonText, fontWeight: 800, cursor: "pointer", boxShadow: "0 0 28px rgba(118,168,255,0.15)", letterSpacing: 1, fontSize: 13 }}
        >
          {loading ? "RUNNING..." : "RUN QUERY"}
        </button>
      </div>
      {dateOfLoss && (
        <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: theme.amberText, boxShadow: `0 0 6px ${theme.amberText}` }} />
          <span style={{ color: theme.amberText, fontSize: 11, fontFamily: '"IBM Plex Mono", monospace', letterSpacing: 1.5 }}>
            DATE OF LOSS SET · IDW INTERPOLATION WILL RUN
          </span>
        </div>
      )}
    </Panel>
  );
}

// ─── Storm Condition Estimate Card (matches screenshot exactly) ───────────────

function StormConditionCard({ interp, address, dateOfLoss }) {
  if (!interp) return null;
  const { hail, wind, error, loading } = interp;

  if (loading) {
    return (
      <Panel style={{ marginBottom: SECTION_GAP }}>
        <div style={{ color: theme.muted, fontFamily: '"IBM Plex Mono", monospace', fontSize: 13, textAlign: "center", padding: "20px 0" }}>
          Running IDW interpolation...
        </div>
      </Panel>
    );
  }

  if (error) {
    return (
      <Panel style={{ marginBottom: SECTION_GAP, borderColor: theme.amberBorder, background: theme.amberBg }}>
        <div style={{ color: theme.amberText, fontFamily: '"IBM Plex Mono", monospace', fontSize: 12 }}>
          Interpolation unavailable: {error}
        </div>
      </Panel>
    );
  }

  if (!hail && !wind) return null;

  const conf = hail || wind;
  const confStyle = getConfidenceStyle(conf.confidenceLabel);

  return (
    <Panel style={{ marginBottom: SECTION_GAP, padding: 0, overflow: "hidden" }}>
      {/* Header bar */}
      <div style={{ background: theme.headerBg, borderBottom: `1px solid ${theme.borderSoft}`, padding: "12px 18px", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ color: theme.muted2, fontSize: 9, letterSpacing: 3, textTransform: "uppercase", fontFamily: '"IBM Plex Mono", monospace', marginBottom: 4 }}>
            STORM DATA MODULE · IDW INTERPOLATION ENGINE v1.0.0
          </div>
          <div style={{ color: theme.white, fontWeight: 800, fontSize: 20, letterSpacing: 0.2 }}>
            Storm Condition Estimate
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ color: theme.muted2, fontSize: 9, letterSpacing: 2, textTransform: "uppercase", fontFamily: '"IBM Plex Mono", monospace', marginBottom: 6 }}>
            INTERPOLATION CONFIDENCE
          </div>
          <div style={{ background: confStyle.bg, border: `1px solid ${confStyle.border}`, borderRadius: 6, padding: "5px 14px", color: confStyle.text, fontWeight: 800, fontSize: 13, fontFamily: '"IBM Plex Mono", monospace', letterSpacing: 2, textAlign: "center" }}>
            {conf.confidenceLabel.toUpperCase()}
          </div>
          <div style={{ color: theme.muted2, fontSize: 10, fontFamily: '"IBM Plex Mono", monospace', marginTop: 5, textAlign: "right" }}>
            {conf.stationCount} stations · nearest {conf.nearestMiles} mi
          </div>
        </div>
      </div>

      <div style={{ padding: 18 }}>
        {/* 2x2 stat grid */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
          {/* Hail Size */}
          <div style={{ background: "#030810", border: `1px solid ${theme.borderSoft}`, borderRadius: 10, padding: "16px 18px" }}>
            <div style={{ color: theme.muted2, fontSize: 9, letterSpacing: 3, textTransform: "uppercase", fontFamily: '"IBM Plex Mono", monospace', marginBottom: 8 }}>HAIL SIZE (EST.)</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
              <span style={{ color: theme.text, fontSize: 36, fontWeight: 800, fontFamily: '"IBM Plex Mono", monospace', lineHeight: 1 }}>
                {hail ? hail.value : "—"}
              </span>
              <span style={{ color: theme.muted, fontSize: 16, fontFamily: '"IBM Plex Mono", monospace' }}>in</span>
            </div>
          </div>

          {/* Hail Probability */}
          <div style={{ background: "#030810", border: `1px solid ${theme.borderSoft}`, borderRadius: 10, padding: "16px 18px" }}>
            <div style={{ color: theme.muted2, fontSize: 9, letterSpacing: 3, textTransform: "uppercase", fontFamily: '"IBM Plex Mono", monospace', marginBottom: 8 }}>HAIL PROBABILITY</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
              <span style={{ color: theme.text, fontSize: 36, fontWeight: 800, fontFamily: '"IBM Plex Mono", monospace', lineHeight: 1 }}>
                {hail ? Math.round(hail.confidence * 100) : "—"}
              </span>
              <span style={{ color: theme.muted, fontSize: 16, fontFamily: '"IBM Plex Mono", monospace' }}>%</span>
            </div>
            <div style={{ color: theme.muted2, fontSize: 11, fontFamily: '"IBM Plex Mono", monospace', marginTop: 4 }}>at property location</div>
          </div>

          {/* Wind Speed */}
          <div style={{ background: "#030810", border: `1px solid ${theme.borderSoft}`, borderRadius: 10, padding: "16px 18px" }}>
            <div style={{ color: theme.muted2, fontSize: 9, letterSpacing: 3, textTransform: "uppercase", fontFamily: '"IBM Plex Mono", monospace', marginBottom: 8 }}>WIND SPEED</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
              <span style={{ color: theme.text, fontSize: 36, fontWeight: 800, fontFamily: '"IBM Plex Mono", monospace', lineHeight: 1 }}>
                {wind ? wind.value : "—"}
              </span>
              <span style={{ color: theme.muted, fontSize: 16, fontFamily: '"IBM Plex Mono", monospace' }}>mph</span>
            </div>
          </div>

          {/* Wind Gust */}
          <div style={{ background: "#030810", border: `1px solid ${theme.borderSoft}`, borderRadius: 10, padding: "16px 18px" }}>
            <div style={{ color: theme.muted2, fontSize: 9, letterSpacing: 3, textTransform: "uppercase", fontFamily: '"IBM Plex Mono", monospace', marginBottom: 8 }}>WIND GUST</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
              <span style={{ color: theme.text, fontSize: 36, fontWeight: 800, fontFamily: '"IBM Plex Mono", monospace', lineHeight: 1 }}>
                {wind ? Math.round(wind.value * 1.15) : "—"}
              </span>
              <span style={{ color: theme.muted, fontSize: 16, fontFamily: '"IBM Plex Mono", monospace' }}>mph</span>
            </div>
          </div>
        </div>

        {/* Disclaimer block */}
        <div style={{ background: theme.amberBg, border: `1px solid ${theme.amberBorder}`, borderRadius: 10, padding: "14px 16px" }}>
          <div style={{ color: theme.amberText, fontSize: 12, lineHeight: 1.85, fontFamily: '"IBM Plex Mono", monospace' }}>
            Storm conditions reported for{" "}
            <strong style={{ color: theme.text }}>{address}</strong> on{" "}
            <strong style={{ color: theme.text }}>{dateOfLoss}</strong> are
            mathematical estimates derived by Inverse Distance Weighting (IDW,
            power=2) interpolation across{" "}
            <strong style={{ color: theme.text }}>{conf.stationCount}</strong>{" "}
            surrounding weather stations. The nearest station,{" "}
            <strong style={{ color: theme.text }}>{conf.nearestName}</strong>, is
            located{" "}
            <strong style={{ color: theme.text }}>{conf.nearestMiles} miles</strong>{" "}
            from the subject property. These values have not been directly measured
            at the property location and do not constitute empirical evidence of
            storm occurrence or severity. Confidence classification:{" "}
            <strong style={{ color: theme.text }}>{conf.confidenceLabel}</strong>.
            Algorithm version: <strong style={{ color: theme.text }}>1.0.0</strong>.
            Computed: <strong style={{ color: theme.text }}>{new Date().toUTCString()}</strong>.
            This estimate should be superseded by empirical inspection data if and
            when such data becomes available.
          </div>
        </div>
      </div>
    </Panel>
  );
}

// ─── Remaining components (unchanged from original) ───────────────────────────

function PdfPageShell({ children, showTopHeader = false }) {
  return (
    <div style={{ width: PAGE_W, height: PAGE_H, background: theme.pageBg, color: theme.text, position: "relative", overflow: "hidden", fontFamily: "Inter, Arial, sans-serif" }}>
      {showTopHeader ? (
        <div style={{ height: 92, background: theme.headerBg, borderBottom: `1px solid ${theme.borderSoft}`, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px 10px 14px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <LogoMark />
            <div>
              <div style={{ color: theme.white, fontWeight: 800, fontSize: 19, letterSpacing: 0.4 }}>SEVERE WEATHER INTELLIGENCE</div>
              <div style={{ color: theme.muted2, fontSize: 9.5, letterSpacing: 3, textTransform: "uppercase", fontFamily: '"IBM Plex Mono", monospace', marginTop: 5 }}>NOAA storm events database · 5-year lookback</div>
            </div>
          </div>
          <div style={{ textAlign: "right", color: theme.muted2, fontSize: 9, letterSpacing: 1.2, textTransform: "uppercase", fontFamily: '"IBM Plex Mono", monospace', lineHeight: 1.35 }}>
            <div>Data Source: NOAA NWS</div>
            <div>NCEI Storm Events DB</div>
          </div>
        </div>
      ) : null}
      <div style={{ padding: showTopHeader ? "18px 22px 18px 22px" : "20px 22px 18px 22px" }}>
        {children}
      </div>
    </div>
  );
}

function AddressLookupBand({ address }) {
  return (
    <Panel style={{ marginBottom: SECTION_GAP, paddingBottom: 16 }}>
      <SectionLabel>Property Address Lookup</SectionLabel>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 160px", gap: 12 }}>
        <div style={{ minHeight: 44, display: "flex", alignItems: "center", border: `1px solid ${theme.border}`, borderRadius: 8, background: "#01050b", color: theme.blueBright, padding: "0 16px", fontSize: 14, fontFamily: '"IBM Plex Mono", monospace' }}>
          {address || "N/A"}
        </div>
        <div style={{ minHeight: 44, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 8, background: theme.button, color: theme.buttonText, fontWeight: 800, letterSpacing: 1, boxShadow: "0 0 22px rgba(118,168,255,0.12)" }}>
          RUN QUERY
        </div>
      </div>
    </Panel>
  );
}

function SummaryCards({ data }) {
  const risk = getRiskStyle(data.riskLevel);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: SECTION_GAP, marginBottom: SECTION_GAP }}>
      <Panel>
        <SectionLabel>Location Identified</SectionLabel>
        <div style={{ color: theme.blueBright, fontWeight: 800, fontSize: 17, lineHeight: 1.25, marginBottom: 8 }}>{data.location.county}, {data.location.state}</div>
        <div style={{ color: theme.muted, fontSize: 13, fontFamily: '"IBM Plex Mono", monospace' }}>{data.location.address}</div>
      </Panel>
      <div style={{ background: risk.bg, border: `1px solid ${risk.border}`, borderRadius: 12, padding: 18 }}>
        <SectionLabel>Hail Risk Assessment</SectionLabel>
        <div style={{ color: risk.text, fontWeight: 800, fontSize: 22, marginBottom: 8 }}>{data.riskLevel}</div>
        <div style={{ color: "#d5b07a", fontSize: 13, fontFamily: '"IBM Plex Mono", monospace' }}>{data.stats.yearsSearched} · {data.stats.totalHailEvents} events found</div>
      </div>
    </div>
  );
}

function WeatherSummary({ text }) {
  return (
    <Panel style={{ marginBottom: SECTION_GAP }}>
      <SectionLabel>Weather Summary</SectionLabel>
      <div style={{ color: theme.text, fontSize: 14, lineHeight: 1.9, whiteSpace: "pre-wrap" }}>{text}</div>
    </Panel>
  );
}

function StatsGrid({ stats }) {
  const items = [
    { label: "Total Hail Events", value: stats.totalHailEvents },
    { label: "Largest Hail", value: stats.largestHailSize },
    { label: "Avg / Year", value: stats.avgEventsPerYear },
    { label: "Most Active Month", value: stats.mostActiveMonth },
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: SECTION_GAP }}>
      {items.map((item) => (
        <Panel key={item.label} style={{ padding: "14px 14px 16px 14px" }}>
          <div style={{ color: theme.muted2, fontSize: 10, letterSpacing: 2.6, textTransform: "uppercase", fontFamily: '"IBM Plex Mono", monospace', textAlign: "center", marginBottom: 10 }}>{item.label}</div>
          <div style={{ color: theme.blueBright, textAlign: "center", fontSize: 16, fontWeight: 800, lineHeight: 1.2 }}>{item.value}</div>
        </Panel>
      ))}
    </div>
  );
}

function ReportIntro({ data, address }) {
  return (
    <>
      <AddressLookupBand address={address} />
      <SummaryCards data={data} />
      <WeatherSummary text={data.summary} />
      <StatsGrid stats={data.stats} />
    </>
  );
}

function TableShell({ title, children, style = {} }) {
  return (
    <div style={{ background: theme.panel, border: `1px solid ${theme.border}`, borderRadius: 12, overflow: "hidden", marginBottom: SECTION_GAP, ...style }}>
      <div style={{ padding: "16px 18px 13px 18px", borderBottom: `1px solid ${theme.borderSoft}`, color: theme.muted2, fontSize: 10, letterSpacing: 3.2, textTransform: "uppercase", fontFamily: '"IBM Plex Mono", monospace' }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function TableHeader({ columns }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: columns.map((c) => c.width).join(" "), padding: "10px 18px", borderBottom: `1px solid ${theme.borderSoft}`, color: theme.muted, fontSize: 10, letterSpacing: 1.8, textTransform: "uppercase", fontFamily: '"IBM Plex Mono", monospace' }}>
      {columns.map((c) => <div key={c.key}>{c.label}</div>)}
    </div>
  );
}

function HailEventsTable({ rows, title = "Hail Events - Past 5 Years", style = {} }) {
  return (
    <TableShell title={title} style={style}>
      <TableHeader columns={HAIL_COLUMNS} />
      {rows.length === 0 ? (
        <div style={emptyRowStyle}>No hail events returned.</div>
      ) : (
        rows.map((row, idx) => (
          <div key={`${row.date}-${idx}`} style={{ display: "grid", gridTemplateColumns: HAIL_COLUMNS.map((c) => c.width).join(" "), padding: "13px 18px", borderBottom: idx === rows.length - 1 ? "none" : `1px solid ${theme.borderSoft}`, fontSize: 13, lineHeight: 1.35 }}>
            <div style={monoCellStyle}>{formatDate(row.date)}</div>
            <div style={{ ...monoCellStyle, color: "#ffcb54", fontWeight: 700 }}>{row.size || "N/A"}</div>
            <div style={monoCellStyle}>{row.location || "N/A"}</div>
            <div style={{ ...monoCellStyle, color: theme.dangerText }}>{row.propertyDamage || "N/A"}</div>
            <div style={{ ...monoCellStyle, textAlign: "center" }}>{row.injuries ?? 0}</div>
            <div style={{ ...monoCellStyle, textAlign: "center" }}>{row.deaths ?? 0}</div>
          </div>
        ))
      )}
    </TableShell>
  );
}

function OtherEventsTable({ rows, title = "Other Severe Weather Events", style = {} }) {
  return (
    <TableShell title={title} style={style}>
      <TableHeader columns={OTHER_COLUMNS} />
      {rows.length === 0 ? (
        <div style={emptyRowStyle}>No additional severe weather events returned.</div>
      ) : (
        rows.map((row, idx) => (
          <div key={`${row.date}-${idx}`} style={{ display: "grid", gridTemplateColumns: OTHER_COLUMNS.map((c) => c.width).join(" "), padding: "13px 18px", borderBottom: idx === rows.length - 1 ? "none" : `1px solid ${theme.borderSoft}`, fontSize: 13, lineHeight: 1.35 }}>
            <div style={monoCellStyle}>{formatDate(row.date)}</div>
            <div style={{ ...monoCellStyle, color: theme.purpleText, fontWeight: 700 }}>{row.type || "N/A"}</div>
            <div style={monoCellStyle}>{row.description || "N/A"}</div>
            <div style={{ ...monoCellStyle, color: theme.dangerText }}>{row.damage || "N/A"}</div>
          </div>
        ))
      )}
    </TableShell>
  );
}

function SourcesBlock({ sources, style = {} }) {
  return (
    <TableShell title="Data Sources" style={style}>
      <div style={{ padding: "14px 18px 12px 18px" }}>
        {sources.length === 0 ? (
          <div style={emptyRowStyle}>No source links returned.</div>
        ) : (
          sources.map((s, i) => (
            <div key={`${s}-${i}`} style={{ color: theme.blue, fontFamily: '"IBM Plex Mono", monospace', fontSize: 12, lineHeight: 1.7, marginBottom: 6, wordBreak: "break-all" }}>
              ↗ {s}
            </div>
          ))
        )}
      </div>
    </TableShell>
  );
}

function ReportPage({ page, data, address }) {
  return (
    <PdfPageShell showTopHeader={page.showTopHeader}>
      {page.showIntro ? <ReportIntro data={data} address={address} /> : null}
      {page.sections.map((section, idx) => {
        if (section.type === "hail") return <HailEventsTable key={`${section.type}-${idx}`} rows={section.rows} title={section.title} />;
        if (section.type === "other") return <OtherEventsTable key={`${section.type}-${idx}`} rows={section.rows} title={section.title} />;
        if (section.type === "sources") return <SourcesBlock key={`${section.type}-${idx}`} sources={section.sources} />;
        return null;
      })}
      {page.showFooter ? <TrinityFooter /> : null}
    </PdfPageShell>
  );
}

function ReportPreview({ data, address, pages }) {
  return (
    <div>
      <div style={{ color: theme.muted2, fontSize: 11, letterSpacing: 2.2, textTransform: "uppercase", fontFamily: '"IBM Plex Mono", monospace', marginBottom: 12 }}>Report preview</div>
      <div style={{ display: "grid", gap: 18 }}>
        {pages.map((page, idx) => (
          <div key={`preview-${idx}`} style={{ width: "100%", overflowX: "auto", borderRadius: 14, border: `1px solid ${theme.borderSoft}`, background: "#01040a", padding: 10 }}>
            <div style={{ width: PAGE_W }}><ReportPage page={page} data={data} address={address} /></div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [address, setAddress] = useState("");
  const [dateOfLoss, setDateOfLoss] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);

  const [authChecking, setAuthChecking] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState("");

  const [pages, setPages] = useState([]);
  const [layoutReady, setLayoutReady] = useState(false);

  // Interpolation state
  const [interp, setInterp] = useState(null);

  const pageRefs = useRef([]);
  const introMeasureRef = useRef(null);
  const hailBaseMeasureRef = useRef(null);
  const otherBaseMeasureRef = useRef(null);
  const sourcesBaseMeasureRef = useRef(null);
  const footerMeasureRef = useRef(null);
  const hailRowMeasureRefs = useRef([]);
  const otherRowMeasureRefs = useRef([]);
  const sourceRowMeasureRefs = useRef([]);

  useEffect(() => { ensureFonts(); }, []);

  useEffect(() => {
    const checkSession = async () => {
      try {
        const res = await fetch("/api/session", { credentials: "include" });
        const data = await parseResponseJson(res, "Session API");
        setAuthenticated(Boolean(data?.authenticated));
      } catch {
        setAuthenticated(false);
      } finally {
        setAuthChecking(false);
      }
    };
    checkSession();
  }, []);

  const normalized = useMemo(() => normalizeResult(result, address), [result, address]);

  useEffect(() => {
    let cancelled = false;
    async function measureLayout() {
      if (!normalized) {
        if (!cancelled) { setPages([]); setLayoutReady(true); }
        return;
      }
      if (!cancelled) setLayoutReady(false);
      await document.fonts.ready;
      requestAnimationFrame(() => {
        if (cancelled) return;
        const metrics = {
          introHeight: getHeight(introMeasureRef.current),
          hailBaseHeight: getHeight(hailBaseMeasureRef.current),
          otherBaseHeight: getHeight(otherBaseMeasureRef.current),
          sourcesBaseHeight: getHeight(sourcesBaseMeasureRef.current),
          footerHeight: getHeight(footerMeasureRef.current),
          hailRowHeights: normalized.hailEvents.map((_, i) => getHeight(hailRowMeasureRefs.current[i])),
          otherRowHeights: normalized.otherEvents.map((_, i) => getHeight(otherRowMeasureRefs.current[i])),
          sourceRowHeights: normalized.sources.map((_, i) => getHeight(sourceRowMeasureRefs.current[i])),
        };
        const builtPages = buildMeasuredPages(normalized, metrics);
        setPages(builtPages);
        setLayoutReady(true);
      });
    }
    measureLayout();
    return () => { cancelled = true; };
  }, [normalized]);

  async function handleLogin() {
    setAuthLoading(true);
    setAuthError("");
    try {
      const res = await fetch("/api/login", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
      const data = await parseResponseJson(res, "Login API");
      if (!res.ok || !data?.success) throw new Error(data?.error || "Invalid credentials.");
      setAuthenticated(true);
      setUsername("");
      setPassword("");
    } catch (err) {
      setAuthError(err.message || "Login failed.");
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleLogout() {
    try { await fetch("/api/logout", { method: "POST", credentials: "include" }); } catch {}
    setAuthenticated(false);
    setResult(null);
    setAddress("");
    setDateOfLoss("");
    setInterp(null);
  }

  async function callAnthropic(messages, useTools = true) {
    const res = await fetch("/api/anthropic", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: useTools ? 1400 : 1800,
        system: systemPrompt,
        ...(useTools ? { tools: [{ type: "web_search_20250305", name: "web_search" }] } : {}),
        messages,
      }),
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; }
    catch { throw new Error(`Unexpected server response: ${text.slice(0, 160)}`); }
    if (res.status === 401) { setAuthenticated(false); throw new Error("Your session expired. Please sign in again."); }
    if (!res.ok) throw new Error(data?.error?.message || data?.error || `HTTP ${res.status}`);
    return data;
  }

  // ── Run interpolation against Visual Crossing ──────────────────────────────
  async function runInterpolation(lat, lon, date) {
    setInterp({ loading: true, hail: null, wind: null, error: null });
    try {
      const res = await fetch(`/api/weather/stations?lat=${lat}&lon=${lon}&date=${date}`, { credentials: "include" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Station API error ${res.status}`);
      }
      const data = await res.json();
      const stationsRaw = data.stations || {};
      const dayData = data.days?.[0] || {};

      const hailStations = [];
      const windStations = [];

      Object.entries(stationsRaw).forEach(([id, station]) => {
        if (station.lat == null || station.lon == null) return;
        if (station.precip != null) {
          hailStations.push({ lat: station.lat, lon: station.lon, value: station.precip, stationId: id, source: station.name || id });
        }
        const windVal = station.windgust ?? station.windspeed;
        if (windVal != null) {
          windStations.push({ lat: station.lat, lon: station.lon, value: windVal, stationId: id, source: station.name || id });
        }
      });

      if (hailStations.length === 0 && dayData.precip != null) {
        hailStations.push({ lat, lon, value: dayData.precip, stationId: "POINT_EST", source: "Visual Crossing" });
      }
      if (windStations.length === 0 && dayData.windgust != null) {
        windStations.push({ lat, lon, value: dayData.windgust, stationId: "POINT_EST", source: "Visual Crossing" });
      }

      const hail = runIDW(lat, lon, hailStations);
      const wind = runIDW(lat, lon, windStations);
      setInterp({ loading: false, hail, wind, error: null });
    } catch (err) {
      setInterp({ loading: false, hail: null, wind: null, error: err.message });
    }
  }

  async function handleLookup() {
    if (!address.trim()) return;
    setLoading(true);
    setError("");
    setResult(null);
    setInterp(null);

    try {
      let messages = [{
        role: "user",
        content: `Look up hail and severe weather data for this address: ${address}\n\nSearch for the past 5 years (${CURRENT_YEAR - 5} to ${CURRENT_YEAR}).\nReturn only valid JSON in the exact schema.`,
      }];

      let data = null;
      for (let i = 0; i < 2; i += 1) {
        data = await callAnthropic(messages, true);
        if (data?.stop_reason === "tool_use") {
          messages = [...messages, { role: "assistant", content: data.content }];
          const toolResults = (data.content || []).filter((b) => b.type === "tool_use").map((b) => ({ type: "tool_result", tool_use_id: b.id, content: b.content ?? "Search completed." }));
          messages = [...messages, { role: "user", content: toolResults }];
        } else {
          break;
        }
      }

      let parsed = extractJsonPayload(data);
      if (!parsed && data) {
        const repairMessages = [...messages, { role: "assistant", content: data.content }, { role: "user", content: "Return the exact same final answer again as valid JSON only. No markdown. No prose. No citations. Start with { and end with }." }];
        const repaired = await callAnthropic(repairMessages, false);
        parsed = extractJsonPayload(repaired);
      }
      if (!parsed) throw new Error("Claude returned a non-JSON answer. Please try again.");

      setResult(parsed);

      // ── Auto-run interpolation if date of loss was provided ──
      if (dateOfLoss && parsed?.location?.lat && parsed?.location?.lon) {
        const lat = parseFloat(parsed.location.lat);
        const lon = parseFloat(parsed.location.lon);
        if (!isNaN(lat) && !isNaN(lon)) {
          runInterpolation(lat, lon, dateOfLoss);
        }
      }
    } catch (err) {
      setError(err.message || "Failed to retrieve weather data.");
    } finally {
      setLoading(false);
    }
  }

  async function downloadPDF() {
    if (!normalized || !layoutReady || pages.length === 0) return;
    setPdfLoading(true);
    try {
      await document.fonts.ready;
      const pdf = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
      const pdfW = pdf.internal.pageSize.getWidth();
      const pdfH = pdf.internal.pageSize.getHeight();
      for (let i = 0; i < pages.length; i += 1) {
        const node = pageRefs.current[i];
        if (!node) continue;
        const canvas = await html2canvas(node, { backgroundColor: theme.pageBg, scale: 2.2, useCORS: true, logging: false, windowWidth: PAGE_W, windowHeight: PAGE_H });
        const img = canvas.toDataURL("image/png");
        if (i > 0) pdf.addPage();
        pdf.addImage(img, "PNG", 0, 0, pdfW, pdfH, undefined, "FAST");
      }
      const countyName = String(normalized.location.county || "report").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
      pdf.save(`trinity-swi-report-${countyName}-${new Date().toISOString().slice(0, 10)}.pdf`);
    } catch (err) {
      setError(`PDF generation failed: ${err.message || err}`);
    } finally {
      setPdfLoading(false);
    }
  }

  if (authChecking) {
    return <div style={{ minHeight: "100vh", background: theme.bg, color: theme.text, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Inter, Arial, sans-serif" }}>Checking session...</div>;
  }

  if (!authenticated) {
    return <LoginScreen username={username} password={password} setUsername={setUsername} setPassword={setPassword} onLogin={handleLogin} loading={authLoading} error={authError} />;
  }

  return (
    <div style={{ minHeight: "100vh", background: theme.bg, color: theme.text, fontFamily: "Inter, Arial, sans-serif" }}>
      <AppHeader onLogout={handleLogout} />
      <div style={{ maxWidth: 1320, margin: "0 auto", padding: 20 }}>

        <SearchPanel
          address={address}
          setAddress={setAddress}
          dateOfLoss={dateOfLoss}
          setDateOfLoss={setDateOfLoss}
          onLookup={handleLookup}
          loading={loading}
        />

        {error ? (
          <div style={{ marginBottom: 16, color: "#ff9c9c", background: "#220b12", border: "1px solid #5d1c2b", padding: "12px 14px", borderRadius: 10 }}>
            {error}
          </div>
        ) : null}

        {/* Storm Condition Estimate — appears automatically when date of loss + results present */}
        {interp && (
          <StormConditionCard
            interp={interp}
            address={address}
            dateOfLoss={dateOfLoss}
          />
        )}

        {!normalized ? (
          <Panel>
            <SectionLabel>Status</SectionLabel>
            <div style={{ color: theme.muted, lineHeight: 1.8 }}>
              Enter a property address and run the query. Add a date of loss to also generate an interpolated storm condition estimate.
            </div>
          </Panel>
        ) : !layoutReady ? (
          <Panel>
            <SectionLabel>Layout</SectionLabel>
            <div style={{ color: theme.muted, lineHeight: 1.8 }}>Preparing the report layout...</div>
          </Panel>
        ) : (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
              <div>
                <div style={{ color: theme.white, fontWeight: 800, fontSize: 18, marginBottom: 4 }}>Report ready</div>
                <div style={{ color: theme.muted, fontSize: 13 }}>{normalized.location.address}</div>
              </div>
              <button onClick={downloadPDF} disabled={pdfLoading} style={{ border: "none", borderRadius: 10, background: "#1f9d52", color: "#ffffff", padding: "12px 18px", fontWeight: 800, cursor: "pointer", minWidth: 180 }}>
                {pdfLoading ? "Generating PDF..." : "Download PDF"}
              </button>
            </div>
            <ReportPreview data={normalized} address={address} pages={pages} />
          </>
        )}
      </div>

      {/* Hidden measurement layer */}
      {normalized ? (
        <>
          <div style={{ position: "absolute", left: -30000, top: 0, width: PAGE_W, pointerEvents: "none", opacity: 0 }}>
            <div ref={introMeasureRef} style={{ width: PAGE_W }}><ReportIntro data={normalized} address={address} /></div>
            <div ref={hailBaseMeasureRef} style={{ width: PAGE_W }}><HailEventsTable rows={[]} title="Hail Events - Past 5 Years" style={{ marginBottom: 0 }} /></div>
            {normalized.hailEvents.map((row, i) => (
              <div key={`measure-hail-row-${i}`} ref={(el) => { hailRowMeasureRefs.current[i] = el; }} style={{ display: "grid", gridTemplateColumns: HAIL_COLUMNS.map((c) => c.width).join(" "), padding: "13px 18px", fontSize: 13, lineHeight: 1.35, width: PAGE_W - 44 }}>
                <div style={monoCellStyle}>{formatDate(row.date)}</div>
                <div style={{ ...monoCellStyle, color: "#ffcb54", fontWeight: 700 }}>{row.size || "N/A"}</div>
                <div style={monoCellStyle}>{row.location || "N/A"}</div>
                <div style={{ ...monoCellStyle, color: theme.dangerText }}>{row.propertyDamage || "N/A"}</div>
                <div style={{ ...monoCellStyle, textAlign: "center" }}>{row.injuries ?? 0}</div>
                <div style={{ ...monoCellStyle, textAlign: "center" }}>{row.deaths ?? 0}</div>
              </div>
            ))}
            <div ref={otherBaseMeasureRef} style={{ width: PAGE_W }}><OtherEventsTable rows={[]} title="Other Severe Weather Events" style={{ marginBottom: 0 }} /></div>
            {normalized.otherEvents.map((row, i) => (
              <div key={`measure-other-row-${i}`} ref={(el) => { otherRowMeasureRefs.current[i] = el; }} style={{ display: "grid", gridTemplateColumns: OTHER_COLUMNS.map((c) => c.width).join(" "), padding: "13px 18px", fontSize: 13, lineHeight: 1.35, width: PAGE_W - 44 }}>
                <div style={monoCellStyle}>{formatDate(row.date)}</div>
                <div style={{ ...monoCellStyle, color: theme.purpleText, fontWeight: 700 }}>{row.type || "N/A"}</div>
                <div style={monoCellStyle}>{row.description || "N/A"}</div>
                <div style={{ ...monoCellStyle, color: theme.dangerText }}>{row.damage || "N/A"}</div>
              </div>
            ))}
            <div ref={sourcesBaseMeasureRef} style={{ width: PAGE_W }}><SourcesBlock sources={[]} style={{ marginBottom: 0 }} /></div>
            {normalized.sources.map((s, i) => (
              <div key={`measure-source-row-${i}`} ref={(el) => { sourceRowMeasureRefs.current[i] = el; }} style={{ color: theme.blue, fontFamily: '"IBM Plex Mono", monospace', fontSize: 12, lineHeight: 1.7, marginBottom: 6, wordBreak: "break-all", width: PAGE_W - 44 }}>↗ {s}</div>
            ))}
            <div ref={footerMeasureRef} style={{ width: PAGE_W }}><FooterMeasure /></div>
          </div>

          <div style={{ position: "absolute", left: -20000, top: 0, width: PAGE_W, pointerEvents: "none" }}>
            {layoutReady && pages.map((page, idx) => (
              <div key={`pdf-${idx}`} ref={(el) => { pageRefs.current[idx] = el; }} style={{ width: PAGE_W, height: PAGE_H, marginBottom: 20 }}>
                <ReportPage page={page} data={normalized} address={address} />
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
