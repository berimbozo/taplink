import { useState, useEffect, useCallback } from "react";

// ─── Config ───────────────────────────────────────────────────────────────────
const API_BASE = import.meta.env?.VITE_API_BASE_URL ?? "https://your-app.up.railway.app";
const ADMIN_KEY = import.meta.env?.VITE_ADMIN_API_KEY ?? "";

const api = {
  get:  (path)       => fetch(`${API_BASE}${path}`).then(async r => {
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
    return data;
  }),
  post: (path, body) => fetch(`${API_BASE}${path}`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "x-admin-key": ADMIN_KEY },
    body:    JSON.stringify(body),
  }).then(async r => {
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
    return data;
  }),
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
const StarIcon = ({ filled }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill={filled ? "#FBBF24" : "none"} stroke="#FBBF24" strokeWidth="2">
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
  </svg>
);
const Stars = ({ rating }) => (
  <div style={{ display: "flex", gap: 2 }}>
    {[1,2,3,4,5].map(i => <StarIcon key={i} filled={i <= rating} />)}
  </div>
);

function timeAgo(dateStr) {
  if (!dateStr) return null;
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins < 2)   return "just now";
  if (mins < 60)  return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

const defaultConfig = {
  accentColor:     "#C41E3A",
  bgColor:         "#ffffff",
  textColor:       "#1a1a1a",
  showStars:       true,
  showPhoto:       true,
  showName:        true,
  showBadge:       true,
  displayStyle:    "carousel",
  maxReviews:      6,
  minRating:       4,
  ctaEnabled:      true,
  ctaText:         "Book Your Free Trial",
  ctaLink:         "#",
  ctaColor:        "#C41E3A",
  reviewSource:    "google",
  refreshSchedule: "manual",
  autoAiPick:      false,
};

const TABS = ["Reviews", "Appearance", "Settings", "Embed"];

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab]                   = useState("Reviews");
  const [reviews, setReviews]           = useState([]);
  const [meta, setMeta]                 = useState({ overallRating: null, totalReviews: null });
  const [config, setConfig]             = useState(defaultConfig);
  const [loading, setLoading]           = useState(true);
  const [saving, setSaving]             = useState(false);
  const [aiLoading, setAiLoading]       = useState(false);
  const [aiNote, setAiNote]             = useState(null);
  const [toast, setToast]               = useState(null);
  const [previewMode, setPreviewMode]   = useState("desktop");
  const [cacheStatus, setCacheStatus]   = useState(null);
  const [refreshing, setRefreshing]     = useState(false);
  const [capabilities, setCapabilities] = useState({ outscraperAvailable: false });

  const showToast = (msg, type = "success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  };

  const loadCacheStatus = useCallback(async () => {
    try {
      const status = await api.get("/api/reviews/cache-status");
      setCacheStatus(status);
    } catch {}
  }, []);

  // Load reviews + config + capabilities on mount
  useEffect(() => {
    (async () => {
      try {
        const [revData, cfgData, caps] = await Promise.all([
          api.get("/api/reviews"),
          api.get("/api/config"),
          api.get("/api/system/capabilities"),
        ]);
        setReviews(revData.reviews || []);
        setMeta({ overallRating: revData.overallRating, totalReviews: revData.totalReviews });
        setConfig({ ...defaultConfig, ...cfgData });
        setCapabilities(caps);
      } catch (e) {
        showToast("Failed to load data from API. Check API_BASE URL.", "error");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Load cache status whenever we know source is outscraper
  useEffect(() => {
    if (config.reviewSource === "outscraper") {
      loadCacheStatus();
    }
  }, [config.reviewSource, loadCacheStatus]);

  const togglePin = async (id, currentPinned) => {
    const newPinned = !currentPinned;
    setReviews(rs => rs.map(r => r.id === id ? { ...r, pinned: newPinned } : r));
    try {
      await api.post("/api/reviews/pin", { reviewId: id, pinned: newPinned });
    } catch {
      setReviews(rs => rs.map(r => r.id === id ? { ...r, pinned: currentPinned } : r));
      showToast("Failed to update pin.", "error");
    }
  };

  const saveConfig = async (overrides = {}) => {
    setSaving(true);
    const updated = { ...config, ...overrides };
    try {
      await api.post("/api/config", updated);
      showToast("Widget settings saved!");
    } catch {
      showToast("Failed to save settings.", "error");
    } finally {
      setSaving(false);
    }
  };

  const handleSourceToggle = async (newSource) => {
    if (newSource === "outscraper" && !capabilities.outscraperAvailable) {
      showToast("Outscraper is unavailable — set OUTSCRAPER_API_KEY on the server first.", "error");
      return;
    }
    const prev = config.reviewSource;
    setConfig(c => ({ ...c, reviewSource: newSource }));
    try {
      await api.post("/api/config", { ...config, reviewSource: newSource });
      // Reload reviews with new source
      const revData = await api.get("/api/reviews");
      setReviews(revData.reviews || []);
      setMeta({ overallRating: revData.overallRating, totalReviews: revData.totalReviews });
      if (newSource === "outscraper") loadCacheStatus();
      showToast(`Switched to ${newSource === "outscraper" ? "Outscraper" : "Google Places"}.`);
    } catch (err) {
      // Revert on failure
      setConfig(c => ({ ...c, reviewSource: prev }));
      showToast(`Switch failed: ${err.message}`, "error");
    }
  };

  const runRefresh = async () => {
    setRefreshing(true);
    try {
      const result = await api.post("/api/reviews/refresh", {});
      showToast(`Refresh complete — ${result.reviewCount} reviews cached.`);
      const revData = await api.get("/api/reviews");
      setReviews(revData.reviews || []);
      setMeta({ overallRating: revData.overallRating, totalReviews: revData.totalReviews });
      await loadCacheStatus();
    } catch (err) {
      showToast(`Refresh failed: ${err.message}`, "error");
      await loadCacheStatus();
    } finally {
      setRefreshing(false);
    }
  };

  const runAiPick = async () => {
    setAiLoading(true);
    setAiNote(null);
    try {
      const res = await api.post("/api/ai-pick", { reviews });
      setAiNote(res.reasoning);
      const revData = await api.get("/api/reviews");
      setReviews(revData.reviews || []);
      showToast("AI picks updated!");
    } catch (err) {
      const msg = err.message || "";
      if (msg.toLowerCase().includes("credit")) {
        showToast("AI pick failed: insufficient Anthropic credits. Add credits at console.anthropic.com.", "error");
      } else {
        showToast("AI pick failed. Check your Anthropic API key.", "error");
      }
    } finally {
      setAiLoading(false);
    }
  };

  const cfg = (key, val) => setConfig(c => ({ ...c, [key]: val }));

  const pinnedCount    = reviews.filter(r => r.pinned).length;
  const aiCount        = reviews.filter(r => r.aiPicked).length;
  const visibleReviews = reviews.filter(r => r.rating >= config.minRating).slice(0, config.maxReviews);

  if (loading) return (
    <div style={{ background: "#0f0f0f", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: "#eee", fontFamily: "system-ui" }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
        <div>Connecting to API...</div>
      </div>
    </div>
  );

  return (
    <div style={{ fontFamily: "'Inter', system-ui, sans-serif", background: "#0f0f0f", minHeight: "100vh", color: "#e5e5e5", display: "flex", flexDirection: "column" }}>

      {/* Toast */}
      {toast && (
        <div style={{ position: "fixed", top: 16, right: 16, zIndex: 999, padding: "10px 18px", borderRadius: 8, background: toast.type === "error" ? "#7f1d1d" : "#14532d", color: "#fff", fontSize: 13, fontWeight: 600, boxShadow: "0 4px 16px rgba(0,0,0,0.4)" }}>
          {toast.type === "error" ? "❌" : "✅"} {toast.msg}
        </div>
      )}

      {/* Header */}
      <div style={{ background: "#1a1a1a", borderBottom: "1px solid #2a2a2a", padding: "16px 24px", display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ width: 32, height: 32, borderRadius: 8, background: config.accentColor, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 14 }}>R</div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>Reviews Portal</div>
          <div style={{ fontSize: 11, color: "#888" }}>
            {meta.overallRating ? `⭐ ${meta.overallRating} · ${meta.totalReviews} reviews` : "Admin Dashboard"}
          </div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {TABS.map(t => (
            <button key={t} onClick={() => setTab(t)} style={{ padding: "6px 14px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600, background: tab === t ? config.accentColor : "#2a2a2a", color: tab === t ? "#fff" : "#aaa" }}>{t}</button>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, maxWidth: 1100, margin: "0 auto", padding: "24px 16px", width: "100%" }}>

        {/* REVIEWS TAB */}
        {tab === "Reviews" && (
          <div>
            {/* Source bar */}
            <div style={{ background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: 10, padding: "12px 16px", marginBottom: 16, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: "#666", textTransform: "uppercase", letterSpacing: 1 }}>Data Source</span>
              <div style={{ display: "flex", gap: 6 }}>
                {[["google", "Google Places"], ["outscraper", "Outscraper"]].map(([val, label]) => {
                  const disabled = val === "outscraper" && !capabilities.outscraperAvailable;
                  return (
                    <button
                      key={val}
                      onClick={() => !disabled && handleSourceToggle(val)}
                      title={disabled ? "Set OUTSCRAPER_API_KEY on the server to enable this option." : undefined}
                      style={{ padding: "5px 12px", borderRadius: 6, border: `1px solid ${config.reviewSource === val ? config.accentColor : "#444"}`, background: config.reviewSource === val ? config.accentColor + "22" : "transparent", color: disabled ? "#555" : config.reviewSource === val ? config.accentColor : "#aaa", fontSize: 12, fontWeight: 600, cursor: disabled ? "not-allowed" : "pointer" }}
                    >
                      {label}{disabled ? " (unavailable)" : ""}
                    </button>
                  );
                })}
              </div>

              {config.reviewSource === "outscraper" && (
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginLeft: "auto", flexWrap: "wrap" }}>
                  {cacheStatus?.lastRefreshSuccess === false && (
                    <span style={{ fontSize: 12, color: "#f87171", background: "#7f1d1d33", border: "1px solid #7f1d1d", borderRadius: 6, padding: "3px 8px" }}>
                      ⚠ Last refresh failed — showing previous data
                    </span>
                  )}
                  {cacheStatus?.fetchedAt && (
                    <span style={{ fontSize: 12, color: "#888" }}>
                      Updated {timeAgo(cacheStatus.fetchedAt)} · {cacheStatus.reviewCount} reviews cached
                    </span>
                  )}
                  <button
                    onClick={runRefresh}
                    disabled={refreshing}
                    style={{ padding: "5px 12px", borderRadius: 6, border: "1px solid #444", background: refreshing ? "#222" : "#2a2a2a", color: refreshing ? "#555" : "#aaa", fontSize: 12, fontWeight: 600, cursor: refreshing ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: 6 }}
                  >
                    {refreshing ? (
                      <>
                        <span style={{ display: "inline-block", width: 10, height: 10, border: "2px solid #555", borderTopColor: "#aaa", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />
                        Refreshing...
                      </>
                    ) : "↻ Refresh Reviews"}
                  </button>
                </div>
              )}
            </div>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Manage Reviews</h2>
                <p style={{ margin: "4px 0 0", color: "#888", fontSize: 13 }}>
                  {reviews.length} reviews · {pinnedCount} pinned · {aiCount} AI-selected
                </p>
              </div>
              <button onClick={runAiPick} disabled={aiLoading} style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 18px", borderRadius: 8, border: "none", cursor: aiLoading ? "not-allowed" : "pointer", background: aiLoading ? "#333" : "linear-gradient(135deg, #7c3aed, #4f46e5)", color: "#fff", fontWeight: 700, fontSize: 13 }}>
                {aiLoading ? "⏳ Analyzing..." : "✨ AI Pick Best Reviews"}
              </button>
            </div>

            {aiNote && (
              <div style={{ background: "#1e1b4b", border: "1px solid #4f46e5", borderRadius: 10, padding: "12px 16px", marginBottom: 20, fontSize: 13, color: "#c7d2fe", lineHeight: 1.6 }}>
                <strong style={{ color: "#a5b4fc" }}>🤖 Claude's reasoning:</strong> {aiNote}
              </div>
            )}

            {reviews.length === 0 ? (
              <div style={{ textAlign: "center", padding: "60px 0", color: "#555" }}>
                <div style={{ fontSize: 32, marginBottom: 12 }}>📭</div>
                <div>
                  {config.reviewSource === "outscraper"
                    ? "No cached reviews yet. Click \"↻ Refresh Reviews\" to fetch from Outscraper."
                    : "No reviews loaded. Check your Google Places API key and Place ID."}
                </div>
              </div>
            ) : (
              <div style={{ display: "grid", gap: 12 }}>
                {reviews.map(r => (
                  <div key={r.id} style={{ background: "#1a1a1a", border: `1px solid ${r.aiPicked ? "#4f46e5" : r.pinned ? config.accentColor : "#2a2a2a"}`, borderRadius: 12, padding: "14px 16px", display: "flex", gap: 14, alignItems: "flex-start", position: "relative" }}>
                    <div style={{ position: "absolute", top: 10, right: 80, display: "flex", gap: 6 }}>
                      {r.aiPicked && <span style={{ fontSize: 11, background: "#4f46e5", color: "#fff", borderRadius: 4, padding: "2px 7px", fontWeight: 600 }}>✨ AI Pick</span>}
                      {r.pinned   && <span style={{ fontSize: 11, background: config.accentColor, color: "#fff", borderRadius: 4, padding: "2px 7px", fontWeight: 600 }}>📌 Pinned</span>}
                    </div>
                    {r.avatar && <img src={r.avatar} alt={r.author} style={{ width: 44, height: 44, borderRadius: "50%", flexShrink: 0 }} />}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                        <span style={{ fontWeight: 700, fontSize: 14 }}>{r.author}</span>
                        <Stars rating={r.rating} />
                        <span style={{ fontSize: 11, color: "#666", marginLeft: "auto", paddingRight: 100 }}>{r.date}</span>
                      </div>
                      <p style={{ margin: 0, fontSize: 13, color: "#bbb", lineHeight: 1.6 }}>{r.text}</p>
                    </div>
                    <button onClick={() => togglePin(r.id, r.pinned)} style={{ flexShrink: 0, padding: "6px 12px", borderRadius: 6, border: `1px solid ${r.pinned ? config.accentColor : "#444"}`, background: r.pinned ? config.accentColor + "22" : "transparent", color: r.pinned ? config.accentColor : "#888", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>
                      {r.pinned ? "Unpin" : "Pin"}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* APPEARANCE TAB */}
        {tab === "Appearance" && (
          <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 24 }}>
            <div style={{ background: "#1a1a1a", borderRadius: 12, padding: 20, border: "1px solid #2a2a2a", height: "fit-content" }}>
              <h3 style={{ margin: "0 0 16px", fontSize: 15 }}>Widget Settings</h3>

              <Section label="Colors">
                <ColorRow label="Accent color"  value={config.accentColor} onChange={v => cfg("accentColor", v)} />
                <ColorRow label="Background"    value={config.bgColor}     onChange={v => cfg("bgColor", v)} />
                <ColorRow label="Text color"    value={config.textColor}   onChange={v => cfg("textColor", v)} />
              </Section>

              <Section label="Display">
                <ToggleRow label="Show star ratings"   value={config.showStars}  onChange={v => cfg("showStars", v)} />
                <ToggleRow label="Show reviewer photo" value={config.showPhoto}  onChange={v => cfg("showPhoto", v)} />
                <ToggleRow label="Show reviewer name"  value={config.showName}   onChange={v => cfg("showName", v)} />
                <ToggleRow label="Show rating badge"   value={config.showBadge}  onChange={v => cfg("showBadge", v)} />
              </Section>

              <Section label="Layout">
                <SelectRow label="Style" value={config.displayStyle} onChange={v => cfg("displayStyle", v)} options={[["carousel","Carousel"],["grid","Grid"],["list","List"]]} />
                <RangeRow label={`Max reviews: ${config.maxReviews}`} value={config.maxReviews} min={1} max={8} onChange={v => cfg("maxReviews", Number(v))} />
                <RangeRow label={`Min rating: ${config.minRating}★`} value={config.minRating} min={1} max={5} onChange={v => cfg("minRating", Number(v))} />
              </Section>

              <Section label="Call to Action">
                <ToggleRow label="Show CTA button" value={config.ctaEnabled} onChange={v => cfg("ctaEnabled", v)} />
                {config.ctaEnabled && <>
                  <InputRow label="Button text" value={config.ctaText} onChange={v => cfg("ctaText", v)} />
                  <InputRow label="Button link" value={config.ctaLink} onChange={v => cfg("ctaLink", v)} />
                  <ColorRow label="Button color" value={config.ctaColor} onChange={v => cfg("ctaColor", v)} />
                </>}
              </Section>

              <button onClick={() => saveConfig()} disabled={saving} style={{ width: "100%", padding: "10px", borderRadius: 8, border: "none", background: saving ? "#333" : config.accentColor, color: "#fff", fontWeight: 700, fontSize: 14, cursor: saving ? "not-allowed" : "pointer", marginTop: 4 }}>
                {saving ? "Saving..." : "💾 Save Settings"}
              </button>
            </div>

            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <h3 style={{ margin: 0, fontSize: 15 }}>Live Preview</h3>
                <div style={{ display: "flex", gap: 6 }}>
                  {["desktop","mobile"].map(m => (
                    <button key={m} onClick={() => setPreviewMode(m)} style={{ padding: "5px 12px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600, background: previewMode === m ? config.accentColor : "#2a2a2a", color: previewMode === m ? "#fff" : "#aaa" }}>
                      {m === "desktop" ? "🖥 Desktop" : "📱 Mobile"}
                    </button>
                  ))}
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "center", background: "#111", borderRadius: 12, padding: 24, border: "1px solid #2a2a2a" }}>
                <div style={{ width: previewMode === "mobile" ? 375 : "100%", transition: "width 0.3s" }}>
                  <WidgetPreview reviews={visibleReviews} config={config} meta={meta} mobile={previewMode === "mobile"} />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* SETTINGS TAB */}
        {tab === "Settings" && (
          <div style={{ maxWidth: 560 }}>
            <h2 style={{ margin: "0 0 8px", fontSize: 20, fontWeight: 700 }}>Settings</h2>
            <p style={{ color: "#888", fontSize: 13, marginBottom: 24 }}>Configure your review data source and automation preferences.</p>

            <div style={{ background: "#1a1a1a", borderRadius: 12, padding: 20, border: "1px solid #2a2a2a", marginBottom: 16 }}>
              <Section label="Review Source">
                <div style={{ fontSize: 13, color: "#ccc", marginBottom: 8 }}>
                  Google Places returns up to 5 recent reviews. Outscraper fetches all reviews (requires <code style={{ background: "#2a2a2a", padding: "1px 5px", borderRadius: 3 }}>OUTSCRAPER_API_KEY</code> on the server).
                </div>
                <Row label="Source">
                  <div style={{ display: "flex", gap: 6 }}>
                    {[["google", "Google Places"], ["outscraper", "Outscraper"]].map(([val, label]) => {
                      const disabled = val === "outscraper" && !capabilities.outscraperAvailable;
                      return (
                        <button
                          key={val}
                          onClick={() => !disabled && handleSourceToggle(val)}
                          title={disabled ? "Set OUTSCRAPER_API_KEY on the server to enable." : undefined}
                          style={{ padding: "5px 12px", borderRadius: 6, border: `1px solid ${config.reviewSource === val ? config.accentColor : "#444"}`, background: config.reviewSource === val ? config.accentColor + "22" : "transparent", color: disabled ? "#555" : config.reviewSource === val ? config.accentColor : "#aaa", fontSize: 12, fontWeight: 600, cursor: disabled ? "not-allowed" : "pointer" }}
                        >
                          {label}{disabled ? " (unavailable)" : ""}
                        </button>
                      );
                    })}
                  </div>
                </Row>
                {!capabilities.outscraperAvailable && (
                  <div style={{ fontSize: 12, color: "#f59e0b", background: "#78350f33", border: "1px solid #78350f", borderRadius: 6, padding: "8px 10px", marginTop: 8 }}>
                    ⚠ Outscraper is not configured on this server. Add <code style={{ background: "#2a2a2a", padding: "1px 4px", borderRadius: 3 }}>OUTSCRAPER_API_KEY</code> to your Railway environment variables to enable it.
                  </div>
                )}
              </Section>
            </div>

            {config.reviewSource === "outscraper" && (
              <div style={{ background: "#1a1a1a", borderRadius: 12, padding: 20, border: "1px solid #2a2a2a", marginBottom: 16 }}>
                <Section label="Outscraper Refresh">
                  <Row label="Refresh schedule">
                    <div style={{ display: "flex", gap: 6 }}>
                      {[["manual", "Manual only"], ["weekly", "Weekly (Sun 2am)"]].map(([val, label]) => (
                        <button
                          key={val}
                          onClick={() => cfg("refreshSchedule", val)}
                          style={{ padding: "5px 12px", borderRadius: 6, border: `1px solid ${config.refreshSchedule === val ? config.accentColor : "#444"}`, background: config.refreshSchedule === val ? config.accentColor + "22" : "transparent", color: config.refreshSchedule === val ? config.accentColor : "#aaa", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </Row>
                  <ToggleRow
                    label="Auto-run AI Pick after each refresh"
                    value={config.autoAiPick}
                    onChange={v => cfg("autoAiPick", v)}
                  />
                  {config.autoAiPick && (
                    <div style={{ fontSize: 12, color: "#888", marginTop: 4 }}>
                      After each refresh, Claude will automatically select the best reviews. Previous picks will be replaced.
                    </div>
                  )}
                </Section>
              </div>
            )}

            <button onClick={() => saveConfig()} disabled={saving} style={{ padding: "10px 24px", borderRadius: 8, border: "none", background: saving ? "#333" : config.accentColor, color: "#fff", fontWeight: 700, fontSize: 14, cursor: saving ? "not-allowed" : "pointer" }}>
              {saving ? "Saving..." : "💾 Save Settings"}
            </button>
          </div>
        )}

        {/* EMBED TAB */}
        {tab === "Embed" && (
          <div style={{ maxWidth: 700 }}>
            <h2 style={{ margin: "0 0 8px", fontSize: 20 }}>Embed Your Widget</h2>
            <p style={{ color: "#888", fontSize: 13, marginBottom: 24 }}>Paste this snippet into your GymDesk site's custom HTML section. The widget auto-updates whenever you change settings here.</p>

            <div style={{ background: "#1a1a1a", borderRadius: 12, padding: 20, border: "1px solid #2a2a2a", marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: "#888" }}>JavaScript Snippet</span>
                <button onClick={() => { navigator.clipboard?.writeText(snippetCode(API_BASE)); showToast("Copied to clipboard!"); }} style={{ padding: "5px 12px", borderRadius: 6, border: "none", background: "#2a2a2a", color: "#aaa", fontSize: 12, cursor: "pointer" }}>📋 Copy</button>
              </div>
              <pre style={{ margin: 0, fontSize: 12, color: "#7dd3fc", lineHeight: 1.8, overflowX: "auto", whiteSpace: "pre-wrap" }}>{snippetCode(API_BASE)}</pre>
            </div>

            <div style={{ background: "#1a1a1a", borderRadius: 12, padding: 20, border: "1px solid #2a2a2a" }}>
              <h4 style={{ margin: "0 0 12px", fontSize: 14 }}>📋 GymDesk Setup</h4>
              {[
                ["Log into GymDesk", "Go to your website editor"],
                ["Find 'Custom Code' or 'Embed HTML'", "Usually under Website → Pages → Edit"],
                ["Paste the snippet above", "Place it wherever you want reviews to appear"],
                ["Save and publish", "The widget will load automatically"],
              ].map(([title, desc], i) => (
                <div key={i} style={{ display: "flex", gap: 12, marginBottom: 12 }}>
                  <div style={{ width: 22, height: 22, borderRadius: "50%", background: "#2a2a2a", border: `1px solid ${config.accentColor}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: config.accentColor, flexShrink: 0 }}>{i+1}</div>
                  <div><div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div><div style={{ fontSize: 12, color: "#666" }}>{desc}</div></div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{ borderTop: "1px solid #1a1a1a", padding: "16px 24px", textAlign: "center", fontSize: 11, color: "#444" }}>
        Reviews Widget — Open Source, MIT License ·{" "}
        <a href="https://github.com/your-org/reviews-widget" target="_blank" rel="noreferrer" style={{ color: "#555", textDecoration: "none" }}>GitHub</a>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

const snippetCode = (base) =>
`<!-- Google Reviews Widget -->
<div id="reviews-widget"></div>
<script src="${base}/widget.js"></script>`;

// ─── Widget Preview ───────────────────────────────────────────────────────────
function WidgetPreview({ reviews, config, meta, mobile }) {
  const [idx, setIdx] = useState(0);
  const style = mobile ? "carousel" : config.displayStyle;

  const cardStyle = {
    background: config.bgColor, color: config.textColor, borderRadius: 12,
    padding: mobile ? 14 : 18, border: `1px solid ${config.accentColor}22`,
    boxShadow: "0 2px 12px rgba(0,0,0,0.08)", display: "flex", flexDirection: "column", gap: 10,
  };

  const ReviewCard = ({ r }) => (
    <div style={cardStyle}>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        {config.showPhoto && r.avatar && <img src={r.avatar} alt={r.author} style={{ width: 38, height: 38, borderRadius: "50%" }} />}
        <div>
          {config.showName  && <div style={{ fontWeight: 700, fontSize: 13 }}>{r.author}</div>}
          {config.showStars && <Stars rating={r.rating} />}
        </div>
        <div style={{ marginLeft: "auto", fontSize: 11, color: "#999" }}>{r.date}</div>
      </div>
      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: config.textColor + "cc" }}>{r.text}</p>
    </div>
  );

  if (!reviews.length) return <div style={{ padding: 40, textAlign: "center", color: "#888", background: config.bgColor, borderRadius: 16 }}>No reviews to preview</div>;

  return (
    <div style={{ background: config.bgColor, borderRadius: 16, padding: mobile ? 14 : 24, fontFamily: "inherit" }}>
      {config.showBadge && meta.overallRating && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, padding: "10px 14px", background: config.accentColor + "11", borderRadius: 10, border: `1px solid ${config.accentColor}33` }}>
          <span style={{ fontSize: 24, fontWeight: 800, color: config.accentColor }}>{meta.overallRating}</span>
          <div><Stars rating={Math.round(meta.overallRating)} /><div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>{meta.totalReviews} Google Reviews</div></div>
        </div>
      )}

      {style === "carousel" && (
        <div>
          <ReviewCard r={reviews[idx % reviews.length]} />
          <div style={{ display: "flex", justifyContent: "center", gap: 8, marginTop: 12, alignItems: "center" }}>
            <button onClick={() => setIdx(i => (i - 1 + reviews.length) % reviews.length)} style={{ width: 28, height: 28, borderRadius: "50%", border: `1px solid ${config.accentColor}`, background: "transparent", color: config.accentColor, cursor: "pointer", fontSize: 14 }}>‹</button>
            {reviews.map((_, i) => <div key={i} onClick={() => setIdx(i)} style={{ width: 7, height: 7, borderRadius: "50%", background: i === idx % reviews.length ? config.accentColor : config.accentColor + "44", cursor: "pointer" }} />)}
            <button onClick={() => setIdx(i => (i + 1) % reviews.length)} style={{ width: 28, height: 28, borderRadius: "50%", border: `1px solid ${config.accentColor}`, background: "transparent", color: config.accentColor, cursor: "pointer", fontSize: 14 }}>›</button>
          </div>
        </div>
      )}
      {style === "grid" && <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 12 }}>{reviews.slice(0,4).map(r => <ReviewCard key={r.id} r={r} />)}</div>}
      {style === "list" && <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{reviews.map(r => <ReviewCard key={r.id} r={r} />)}</div>}

      {config.ctaEnabled && (
        <div style={{ textAlign: "center", marginTop: 18 }}>
          <a href={config.ctaLink} style={{ display: "inline-block", padding: "11px 28px", borderRadius: 8, background: config.ctaColor, color: "#fff", fontWeight: 700, fontSize: 14, textDecoration: "none" }}>{config.ctaText}</a>
        </div>
      )}
    </div>
  );
}

// ─── Form Controls ────────────────────────────────────────────────────────────
const Section   = ({ label, children }) => <div style={{ marginBottom: 20 }}><div style={{ fontSize: 11, fontWeight: 700, color: "#666", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>{label}</div><div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{children}</div></div>;
const Row       = ({ label, children }) => <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13 }}><span style={{ color: "#ccc" }}>{label}</span>{children}</div>;
const ToggleRow = ({ label, value, onChange }) => <Row label={label}><div onClick={() => onChange(!value)} style={{ width: 36, height: 20, borderRadius: 10, background: value ? "#4f46e5" : "#444", cursor: "pointer", position: "relative", transition: "background 0.2s" }}><div style={{ width: 16, height: 16, borderRadius: "50%", background: "#fff", position: "absolute", top: 2, left: value ? 18 : 2, transition: "left 0.2s" }} /></div></Row>;
const ColorRow  = ({ label, value, onChange }) => <Row label={label}><input type="color" value={value} onChange={e => onChange(e.target.value)} style={{ width: 32, height: 26, borderRadius: 4, border: "none", cursor: "pointer", background: "none" }} /></Row>;
const RangeRow  = ({ label, value, min, max, onChange }) => <div style={{ fontSize: 13 }}><div style={{ color: "#ccc", marginBottom: 4 }}>{label}</div><input type="range" min={min} max={max} value={value} onChange={e => onChange(e.target.value)} style={{ width: "100%", accentColor: "#4f46e5" }} /></div>;
const SelectRow = ({ label, value, onChange, options }) => <Row label={label}><select value={value} onChange={e => onChange(e.target.value)} style={{ background: "#2a2a2a", color: "#eee", border: "1px solid #444", borderRadius: 6, padding: "4px 8px", fontSize: 12 }}>{options.map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select></Row>;
const InputRow  = ({ label, value, onChange }) => <div style={{ fontSize: 13 }}><div style={{ color: "#ccc", marginBottom: 4 }}>{label}</div><input value={value} onChange={e => onChange(e.target.value)} style={{ width: "100%", background: "#2a2a2a", color: "#eee", border: "1px solid #444", borderRadius: 6, padding: "6px 8px", fontSize: 12, boxSizing: "border-box" }} /></div>;
