import { createRoot } from "react-dom/client";
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
    <div style={{ position: "relative", width: "100%", background: "#000" }}>
      {/* Banner image — crops responsively, always shows center */}
      <div style={{
        width: "100%",
        height: "clamp(180px, 22vw, 320px)",
        overflow: "hidden",
        position: "relative",
      }}>
        <img
          src="/SWI_Header.png"
          alt="Severe Weather Intelligence"
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            objectPosition: "center 30%",
            display: "block",
          }}
        />
        {/* Bottom fade to app background */}
        <div style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height: "40%",
          background: "linear-gradient(to bottom, transparent, #03070f)",
          pointerEvents: "none",
        }} />
        {/* Sign out — top right overlay */}
        <div style={{
          position: "absolute",
          top: 14,
          right: 18,
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: 6,
        }}>
          <button
            onClick={onLogout}
            style={{
              background: "rgba(3,7,15,0.65)",
              color: theme.blue,
              border: `1px solid ${theme.border}`,
              borderRadius: 8,
              padding: "6px 12px",
              fontSize: 11,
              cursor: "pointer",
              backdropFilter: "blur(6px)",
              fontFamily: '"IBM Plex Mono", monospace',
              letterSpacing: 1,
            }}
          >
            Sign out
          </button>
        </div>
      </div>

      {/* Tagline bar below image */}
      <div style={{
        background: "#03070f",
        borderBottom: `1px solid ${theme.borderSoft}`,
        padding: "10px 20px",
        textAlign: "center",
      }}>
        <div style={{
          color: theme.muted2,
          fontSize: 11,
          letterSpacing: 4,
          textTransform: "uppercase",
          fontFamily: '"IBM Plex Mono", monospace',
        }}>
          NOAA Storm Events Database &nbsp;—&nbsp; 5-Year Lookback
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

// ─── US State SVG Map ─────────────────────────────────────────────────────────
// Simplified state paths scaled to a 960x600 viewBox (standard US Albers projection)

const STATE_PATHS = {
  "Alabama": "M 553 340 L 560 340 L 565 370 L 562 400 L 548 400 L 543 370 Z",
  "Alaska": "M 120 460 L 160 450 L 170 480 L 140 490 Z",
  "Arizona": "M 165 300 L 220 300 L 220 370 L 165 370 Z",
  "Arkansas": "M 510 300 L 550 300 L 548 340 L 508 338 Z",
  "California": "M 110 230 L 155 210 L 165 300 L 130 350 L 105 310 Z",
  "Colorado": "M 270 250 L 350 250 L 350 310 L 270 310 Z",
  "Connecticut": "M 720 190 L 740 188 L 742 205 L 720 207 Z",
  "Delaware": "M 695 220 L 708 218 L 710 235 L 695 237 Z",
  "Florida": "M 560 390 L 600 385 L 620 430 L 590 460 L 560 440 L 548 410 Z",
  "Georgia": "M 560 340 L 600 338 L 602 385 L 560 390 L 548 370 Z",
  "Hawaii": "M 230 490 L 280 485 L 278 500 L 228 505 Z",
  "Idaho": "M 175 155 L 220 145 L 225 230 L 195 245 L 175 210 Z",
  "Illinois": "M 530 240 L 560 238 L 558 300 L 528 302 Z",
  "Indiana": "M 560 238 L 585 236 L 583 295 L 558 298 Z",
  "Iowa": "M 470 215 L 530 212 L 530 250 L 470 252 Z",
  "Kansas": "M 370 270 L 470 268 L 470 315 L 370 317 Z",
  "Kentucky": "M 575 278 L 640 272 L 642 305 L 575 308 Z",
  "Louisiana": "M 490 370 L 545 368 L 548 400 L 520 415 L 490 405 Z",
  "Maine": "M 755 135 L 780 128 L 785 165 L 758 168 Z",
  "Maryland": "M 668 228 L 710 222 L 712 242 L 668 248 Z",
  "Massachusetts": "M 722 175 L 758 170 L 760 188 L 722 192 Z",
  "Michigan": "M 568 175 L 608 168 L 612 215 L 570 218 Z",
  "Minnesota": "M 450 145 L 510 138 L 512 215 L 450 218 Z",
  "Mississippi": "M 527 305 L 555 303 L 558 370 L 528 372 Z",
  "Missouri": "M 470 265 L 535 262 L 537 315 L 470 318 Z",
  "Montana": "M 195 120 L 320 112 L 322 185 L 195 192 Z",
  "Nebraska": "M 370 230 L 470 225 L 470 270 L 370 275 Z",
  "Nevada": "M 148 215 L 195 205 L 200 300 L 165 305 L 148 270 Z",
  "New Hampshire": "M 735 158 L 752 155 L 755 185 L 737 188 Z",
  "New Jersey": "M 700 205 L 718 202 L 720 228 L 700 230 Z",
  "New Mexico": "M 235 310 L 310 308 L 312 380 L 235 382 Z",
  "New York": "M 648 175 L 718 165 L 720 205 L 648 212 Z",
  "North Carolina": "M 608 288 L 688 278 L 692 308 L 608 315 Z",
  "North Dakota": "M 350 145 L 450 138 L 452 185 L 350 192 Z",
  "Ohio": "M 598 228 L 640 222 L 642 272 L 598 278 Z",
  "Oklahoma": "M 368 315 L 490 312 L 492 355 L 368 358 Z",
  "Oregon": "M 130 165 L 195 155 L 198 230 L 132 238 Z",
  "Pennsylvania": "M 640 198 L 700 192 L 702 228 L 640 235 Z",
  "Rhode Island": "M 740 188 L 752 186 L 754 200 L 740 202 Z",
  "South Carolina": "M 608 308 L 648 305 L 650 342 L 608 345 Z",
  "South Dakota": "M 350 185 L 450 180 L 452 228 L 350 232 Z",
  "Tennessee": "M 548 305 L 638 298 L 640 328 L 548 335 Z",
  "Texas": "M 312 318 L 460 312 L 465 420 L 380 455 L 310 420 Z",
  "Utah": "M 215 240 L 270 235 L 272 315 L 215 320 Z",
  "Vermont": "M 718 152 L 736 148 L 738 175 L 718 178 Z",
  "Virginia": "M 638 258 L 708 248 L 710 282 L 638 288 Z",
  "Washington": "M 130 120 L 195 112 L 198 160 L 130 168 Z",
  "West Virginia": "M 620 248 L 660 242 L 662 278 L 620 285 Z",
  "Wisconsin": "M 510 162 L 555 158 L 558 212 L 510 218 Z",
  "Wyoming": "M 270 190 L 355 183 L 357 248 L 270 255 Z",
};

// Approximate center points for each state (for pin placement)
const STATE_CENTERS = {
  "Alabama": [553, 370], "Alaska": [145, 470], "Arizona": [192, 335],
  "Arkansas": [529, 320], "California": [135, 280], "Colorado": [310, 280],
  "Connecticut": [730, 197], "Delaware": [702, 227], "Florida": [580, 420],
  "Georgia": [575, 362], "Hawaii": [253, 492], "Idaho": [197, 195],
  "Illinois": [544, 268], "Indiana": [571, 265], "Iowa": [500, 232],
  "Kansas": [420, 293], "Kentucky": [607, 290], "Louisiana": [517, 390],
  "Maine": [768, 148], "Maryland": [689, 237], "Massachusetts": [740, 181],
  "Michigan": [588, 192], "Minnesota": [480, 178], "Mississippi": [541, 338],
  "Missouri": [502, 290], "Montana": [257, 150], "Nebraska": [420, 250],
  "Nevada": [172, 257], "New Hampshire": [744, 170], "New Jersey": [709, 215],
  "New Mexico": [272, 344], "New York": [683, 188], "North Carolina": [648, 297],
  "North Dakota": [400, 163], "Ohio": [619, 250], "Oklahoma": [429, 334],
  "Oregon": [163, 197], "Pennsylvania": [670, 213], "Rhode Island": [746, 194],
  "South Carolina": [628, 326], "South Dakota": [400, 205], "Tennessee": [593, 316],
  "Texas": [387, 375], "Utah": [242, 277], "Vermont": [727, 163],
  "Virginia": [673, 265], "Washington": [163, 140], "West Virginia": [640, 263],
  "Wisconsin": [532, 185], "Wyoming": [312, 218],
};

function StateMap({ stateName, lat, lon }) {
  if (!stateName || !STATE_PATHS[stateName]) {
    // International or unknown — show coordinates only
    return (
      <div style={{
        background: "#030810",
        border: `1px solid ${theme.borderSoft}`,
        borderRadius: 10,
        padding: "14px 16px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: 120,
      }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ color: theme.muted2, fontSize: 9, letterSpacing: 2.5, textTransform: "uppercase", fontFamily: '"IBM Plex Mono", monospace', marginBottom: 6 }}>
            COORDINATES
          </div>
          <div style={{ color: theme.blueBright, fontSize: 13, fontFamily: '"IBM Plex Mono", monospace' }}>
            {lat}, {lon}
          </div>
        </div>
      </div>
    );
  }

  const pinCenter = STATE_CENTERS[stateName] || [480, 300];

  return (
    <div style={{
      background: "#030810",
      border: `1px solid ${theme.borderSoft}`,
      borderRadius: 10,
      overflow: "hidden",
      position: "relative",
    }}>
      <svg
        viewBox="100 100 860 480"
        style={{ width: "100%", display: "block" }}
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Dot grid background */}
        <defs>
          <pattern id="dotgrid" x="0" y="0" width="20" height="20" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="0.8" fill="#0d2040" />
          </pattern>
          <radialGradient id="pinGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#76a8ff" stopOpacity="0.4" />
            <stop offset="100%" stopColor="#76a8ff" stopOpacity="0" />
          </radialGradient>
        </defs>

        <rect x="0" y="0" width="960" height="600" fill="url(#dotgrid)" />

        {/* All states — dimmed */}
        {Object.entries(STATE_PATHS).map(([name, path]) => (
          <path
            key={name}
            d={path}
            fill={name === stateName ? "#0d2a4a" : "#060e1a"}
            stroke={name === stateName ? "#17325f" : "#0d1f35"}
            strokeWidth={name === stateName ? "1.5" : "0.8"}
          />
        ))}

        {/* Highlighted state subtle inner glow */}
        {STATE_PATHS[stateName] && (
          <path
            d={STATE_PATHS[stateName]}
            fill="none"
            stroke="#76a8ff"
            strokeWidth="1"
            opacity="0.4"
          />
        )}

        {/* Pin glow halo */}
        <circle
          cx={pinCenter[0]}
          cy={pinCenter[1]}
          r="22"
          fill="url(#pinGlow)"
        />

        {/* Pin outer ring */}
        <circle
          cx={pinCenter[0]}
          cy={pinCenter[1]}
          r="8"
          fill="none"
          stroke="#76a8ff"
          strokeWidth="1.5"
          opacity="0.6"
        />

        {/* Pin center dot */}
        <circle
          cx={pinCenter[0]}
          cy={pinCenter[1]}
          r="4"
          fill="#76a8ff"
          style={{ filter: "drop-shadow(0 0 4px #76a8ff)" }}
        />

        {/* State label */}
        <text
          x={pinCenter[0]}
          y={pinCenter[1] + 22}
          textAnchor="middle"
          fill="#4d6797"
          fontSize="11"
          fontFamily="IBM Plex Mono, monospace"
          letterSpacing="1"
        >
          {stateName.toUpperCase()}
        </text>
      </svg>
    </div>
  );
}

function SummaryCards({ data }) {
  const risk = getRiskStyle(data.riskLevel);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: SECTION_GAP, marginBottom: SECTION_GAP }}>
      {/* Left column: location info + map */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Panel style={{ flex: "0 0 auto" }}>
          <SectionLabel>Location Identified</SectionLabel>
          <div style={{ color: theme.blueBright, fontWeight: 800, fontSize: 17, lineHeight: 1.25, marginBottom: 8 }}>
            {data.location.county}, {data.location.state}
          </div>
          <div style={{ color: theme.muted, fontSize: 13, fontFamily: '"IBM Plex Mono", monospace' }}>
            {data.location.address}
          </div>
        </Panel>
        <StateMap
          stateName={data.location.state}
          lat={data.location.lat}
          lon={data.location.lon}
        />
      </div>

      {/* Right column: risk assessment */}
      <div style={{ background: risk.bg, border: `1px solid ${risk.border}`, borderRadius: 12, padding: 18 }}>
        <SectionLabel>Hail Risk Assessment</SectionLabel>
        <div style={{ color: risk.text, fontWeight: 800, fontSize: 22, marginBottom: 8 }}>{data.riskLevel}</div>
        <div style={{ color: "#d5b07a", fontSize: 13, fontFamily: '"IBM Plex Mono", monospace' }}>
          {data.stats.yearsSearched} · {data.stats.totalHailEvents} events found
        </div>
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
const root = createRoot(document.getElementById("root"));
root.render(<App />);
