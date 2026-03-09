/**
 * Returns the embeddable widget script as a string.
 * @param {string} apiBase - The public URL of the backend (no trailing slash).
 */
export function buildWidgetScript(apiBase) {
  return `
(function() {
  const API = "${apiBase}";

  function init() {
    const el = document.getElementById("reviews-widget");
    if (!el) return;
    load(el);
  }

  async function load(el) {
    try {
      const [cfgRes, revRes] = await Promise.all([
        fetch(API + "/api/config"),
        fetch(API + "/api/reviews")
      ]);
      const config  = await cfgRes.json();
      const { reviews, overallRating, totalReviews } = await revRes.json();
      render(el, config, reviews, overallRating, totalReviews);
    } catch(e) {
      console.error("Reviews widget failed to load:", e);
    }
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function safeSrc(url) {
    // Block javascript: and data: URIs in href/src attributes
    return /^https?:\\/\\//i.test(String(url || "")) ? url : "#";
  }

  function stars(n) {
    return Array.from({length:5}, (_,i) =>
      '<span style="color:' + (i < n ? "#FBBF24" : "#ddd") + '">★</span>'
    ).join("");
  }

  function truncateText(text, maxChars) {
    if (!maxChars || text.length <= maxChars) return { short: text, full: null };
    const cut = text.lastIndexOf(" ", maxChars);
    return { short: text.slice(0, cut > 0 ? cut : maxChars), full: text };
  }

  function buildCard(r, cfg, extraStyle) {
    const maxChars = cfg.reviewMaxChars || 0;
    const safeText = escapeHtml(r.text);
    const { short, full } = truncateText(safeText, maxChars);
    const uid = "rw-rm-" + Math.random().toString(36).slice(2);
    const readMore = full
      ? '<span id="' + uid + '-short">' + short + '… <button class="rw-readmore" data-uid="' + uid + '" style="background:none;border:none;color:' + (cfg.accentColor||"#C41E3A") + ';cursor:pointer;font-size:12px;font-weight:700;padding:0">Read more</button></span>'
        + '<span id="' + uid + '-full" style="display:none">' + full + ' <button class="rw-readless" data-uid="' + uid + '" style="background:none;border:none;color:' + (cfg.accentColor||"#C41E3A") + ';cursor:pointer;font-size:12px;font-weight:700;padding:0">Show less</button></span>'
      : short;
    return '<div class="rw-card" style="background:' + cfg.bgColor + ';border:1px solid ' + cfg.accentColor + '22;border-radius:12px;padding:16px;box-shadow:0 2px 8px rgba(0,0,0,0.07);box-sizing:border-box;' + (extraStyle||"") + '">'
      + '<div style="display:flex;gap:10px;align-items:center;margin-bottom:8px;">'
      + (cfg.showPhoto && r.avatar ? '<img src="' + safeSrc(r.avatar) + '" style="width:36px;height:36px;border-radius:50%;flex-shrink:0">' : "")
      + '<div>'
      + (cfg.showName ? '<div style="font-weight:700;font-size:13px">' + escapeHtml(r.author) + '</div>' : "")
      + (cfg.showStars ? '<div>' + stars(r.rating) + '</div>' : "")
      + '</div></div>'
      + '<p style="margin:0;font-size:13px;line-height:1.6;color:' + cfg.textColor + 'cc">' + readMore + '</p>'
      + '</div>';
  }

  function wireReadMore(container) {
    container.querySelectorAll(".rw-readmore").forEach(btn => {
      btn.addEventListener("click", () => {
        const uid = btn.dataset.uid;
        document.getElementById(uid + "-short").style.display = "none";
        document.getElementById(uid + "-full").style.display  = "inline";
      });
    });
    container.querySelectorAll(".rw-readless").forEach(btn => {
      btn.addEventListener("click", () => {
        const uid = btn.dataset.uid;
        document.getElementById(uid + "-short").style.display = "inline";
        document.getElementById(uid + "-full").style.display  = "none";
      });
    });
  }

  function render(el, cfg, reviews, overallRating, totalReviews) {
    const isMobile = window.innerWidth < 768;
    const style    = isMobile && cfg.displayStyle !== "row" ? "carousel" : cfg.displayStyle;
    const pageSize = cfg.maxReviews || 6;

    // Filter reviews: prefer pinned + aiPicked, fall back to all above minRating
    // Don't slice here — pageSize controls the initial visible count
    let display = reviews.filter(r => r.pinned || r.aiPicked);
    if (display.length === 0) display = reviews.filter(r => r.rating >= (cfg.minRating || 4));

    const wrap = document.createElement("div");
    wrap.style.cssText = "font-family:system-ui,sans-serif;background:" + cfg.bgColor + ";color:" + cfg.textColor + ";border-radius:16px;padding:24px;box-sizing:border-box;";

    // Section title
    if (cfg.showSectionTitle && cfg.sectionTitle) {
      wrap.innerHTML += '<div style="text-align:center;margin-bottom:20px;">'
        + '<h2 style="margin:0;font-size:22px;font-weight:800;color:' + cfg.textColor + '">' + cfg.sectionTitle + '</h2>'
        + '</div>';
    }

    // Badge
    if (cfg.showBadge) {
      wrap.innerHTML += \`<div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;padding:10px 14px;background:\${cfg.accentColor}11;border-radius:10px;border:1px solid \${cfg.accentColor}33;">
        <span style="font-size:28px;font-weight:800;color:\${cfg.accentColor}">\${overallRating}</span>
        <div>\${stars(Math.round(overallRating))}<div style="font-size:11px;color:#888;margin-top:2px">\${totalReviews} Google Reviews</div></div>
      </div>\`;
    }

    if (style === "carousel") {
      // Carousel cycles through a fixed set — cap at pageSize, no show-more needed
      const carouselDisplay = display.slice(0, pageSize);
      let idx = 0;
      const carouselId = "rw-" + Math.random().toString(36).slice(2);
      wrap.innerHTML += '<div id="' + carouselId + '">'
        + carouselDisplay.map((r,i) => buildCard(r, cfg, 'display:' + (i===0?"block":"none") + ';')).join("")
        + '<div style="display:flex;justify-content:center;gap:8px;margin-top:12px;align-items:center;">'
        + '<button id="' + carouselId + '-prev" style="width:28px;height:28px;border-radius:50%;border:1px solid ' + cfg.accentColor + ';background:transparent;color:' + cfg.accentColor + ';cursor:pointer;font-size:16px">&#8249;</button>'
        + carouselDisplay.map((_,i) => '<div id="' + carouselId + '-dot-' + i + '" style="width:7px;height:7px;border-radius:50%;background:' + (i===0?cfg.accentColor:cfg.accentColor+'44') + ';cursor:pointer;display:inline-block"></div>').join("")
        + '<button id="' + carouselId + '-next" style="width:28px;height:28px;border-radius:50%;border:1px solid ' + cfg.accentColor + ';background:transparent;color:' + cfg.accentColor + ';cursor:pointer;font-size:16px">&#8250;</button>'
        + '</div></div>';

      el.appendChild(wrap);
      wireReadMore(wrap);

      const showCard = (n) => {
        idx = (n + carouselDisplay.length) % carouselDisplay.length;
        wrap.querySelectorAll(".rw-card").forEach((c,i) => c.style.display = i===idx?"block":"none");
        carouselDisplay.forEach((_,i) => { const d = document.getElementById(carouselId+"-dot-"+i); if(d) d.style.background = i===idx ? cfg.accentColor : cfg.accentColor+"44"; });
      };
      document.getElementById(carouselId+"-prev")?.addEventListener("click", () => showCard(idx-1));
      document.getElementById(carouselId+"-next")?.addEventListener("click", () => showCard(idx+1));
      carouselDisplay.forEach((_,i) => document.getElementById(carouselId+"-dot-"+i)?.addEventListener("click", () => showCard(i)));
      const intervalId = setInterval(() => {
        if (!document.getElementById(carouselId)) { clearInterval(intervalId); return; }
        showCard(idx+1);
      }, 5000);

    } else {
      // Grid, row, list — all support "Show more" pagination
      let containerStyle, cardExtra = "";
      if (style === "grid") {
        containerStyle = "display:grid;grid-template-columns:repeat(2,1fr);gap:12px";
      } else if (style === "row") {
        containerStyle = "display:flex;flex-direction:row;gap:16px;overflow-x:auto;padding-bottom:8px;align-items:stretch;";
        cardExtra = "flex:0 0 260px;display:flex;flex-direction:column;";
      } else {
        containerStyle = "display:flex;flex-direction:column;gap:10px";
      }

      const cc = document.createElement("div");
      cc.style.cssText = containerStyle;
      let shown = Math.min(pageSize, display.length);

      function refreshCards() {
        cc.innerHTML = display.slice(0, shown).map(r => buildCard(r, cfg, cardExtra)).join("");
        wireReadMore(cc);
      }
      refreshCards();
      wrap.appendChild(cc);
      el.appendChild(wrap);

      // Show more button
      if (cfg.showMoreButton && display.length > pageSize) {
        const moreDiv = document.createElement("div");
        moreDiv.style.cssText = "text-align:center;margin-top:14px;";
        const moreBtn = document.createElement("button");
        moreBtn.textContent = "Show more reviews";
        moreBtn.style.cssText = "background:none;border:1px solid " + cfg.accentColor + ";color:" + cfg.accentColor + ";padding:8px 22px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;";
        moreBtn.addEventListener("click", () => {
          shown = Math.min(shown + pageSize, display.length);
          refreshCards();
          if (shown >= display.length) moreDiv.style.display = "none";
        });
        moreDiv.appendChild(moreBtn);
        el.appendChild(moreDiv);
      }
    }

    // CTA
    if (cfg.ctaEnabled && cfg.ctaText) {
      const cta = document.createElement("div");
      cta.style.textAlign = "center";
      cta.style.marginTop = "18px";
      cta.innerHTML = '<a href="'+safeSrc(cfg.ctaLink)+'" style="display:inline-block;padding:11px 28px;border-radius:8px;background:'+cfg.ctaColor+';color:#fff;font-weight:700;font-size:14px;text-decoration:none">'+escapeHtml(cfg.ctaText)+'</a>';
      el.appendChild(cta);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
  `.trim();
}
