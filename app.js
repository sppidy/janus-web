// Janus // web — vanilla JS client
// API: FastAPI backend served on same origin (or CORS-enabled over VPN).

(() => {
  "use strict";

  const API_BASE = (() => {
    // Allow override via ?api=http://host:8000
    const p = new URLSearchParams(location.search).get("api");
    if (p) return p.replace(/\/$/, "");
    return "/api";
  })();
  const WS_BASE = (() => {
    if (API_BASE.startsWith("http")) {
      return API_BASE.replace(/^http/, "ws").replace(/\/api$/, "");
    }
    return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;
  })();

  const ACCENTS = {
    lime:    { neon: "#b4ff00", glow: "rgba(180,255,0,0.5)",  soft: "rgba(180,255,0,0.12)" },
    cyan:    { neon: "#00f0ff", glow: "rgba(0,240,255,0.5)",  soft: "rgba(0,240,255,0.12)" },
    magenta: { neon: "#ff00aa", glow: "rgba(255,0,170,0.5)",  soft: "rgba(255,0,170,0.12)" },
    amber:   { neon: "#ffb300", glow: "rgba(255,179,0,0.5)",  soft: "rgba(255,179,0,0.12)" },
  };

  const NAV_ITEMS = [
    { id: "dash",    label: "DASHBOARD" },
    { id: "watch",   label: "WATCHLIST" },
    { id: "chart",   label: "CHARTS" },
    { id: "strat",   label: "STRATEGY" },
    { id: "scan",    label: "SCANNER" },
    { id: "agent",   label: "AGENT" },
    { id: "logs",    label: "LOGS" },
    { id: "set",     label: "SETTINGS" },
  ];

  // ── State ──
  const state = {
    apiKey: localStorage.getItem("janus_api_key") || "",
    accent: localStorage.getItem("janus_accent") || "lime",
    view: "dash",
    status: null,
    prices: {},
    regime: "—",
    chatHistory: [],
    ws: null,
    wsReconnect: null,
    chartData: [],
    chartSymbol: "",
    chartTf: "1h",
    pollers: [],
  };

  // ── Utilities ──
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const fmt = {
    money: (n) => (n == null || isNaN(n)) ? "—" : `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`,
    pct:   (n) => (n == null || isNaN(n)) ? "—" : `${Number(n) >= 0 ? "+" : ""}${Number(n).toFixed(2)}%`,
    num:   (n, d = 2) => (n == null || isNaN(n)) ? "—" : Number(n).toFixed(d),
    time:  (t) => {
      try { return new Date(t).toLocaleTimeString("en-GB"); }
      catch { return "—"; }
    },
  };

  function toast(msg, isError = false, ms = 2800) {
    const el = $("#toast");
    el.textContent = msg;
    el.className = "toast" + (isError ? " err" : "");
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, ms);
  }

  async function api(path, opts = {}) {
    const headers = Object.assign(
      { "Content-Type": "application/json", "X-API-Key": state.apiKey },
      opts.headers || {}
    );
    const res = await fetch(API_BASE + path, { ...opts, headers });
    if (res.status === 401) {
      localStorage.removeItem("janus_api_key");
      state.apiKey = "";
      showLogin("Session expired — re-enter API key.");
      throw new Error("unauthorized");
    }
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try { const j = await res.json(); detail = j.detail || detail; } catch {}
      throw new Error(detail);
    }
    return res.json();
  }

  // ── Login ──
  function showLogin(err) {
    $("#login").hidden = false;
    $("#app").hidden = true;
    stopPollers();
    if (err) {
      const e = $("#login-error");
      e.hidden = false;
      e.textContent = err;
    }
  }
  function showApp() {
    $("#login").hidden = true;
    $("#app").hidden = false;
    $("#login-error").hidden = true;
  }

  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const key = $("#api-key-input").value.trim();
    if (!key) return;
    const btn = $("#login-btn");
    btn.disabled = true; btn.textContent = "CONNECTING...";
    try {
      const prev = state.apiKey;
      state.apiKey = key;
      const s = await api("/status");
      if (s.status === "ok") {
        localStorage.setItem("janus_api_key", key);
        showApp();
        await init();
      } else {
        state.apiKey = prev;
        showLogin("Invalid response from server.");
      }
    } catch (err) {
      showLogin("Connection failed: " + err.message);
    } finally {
      btn.disabled = false; btn.textContent = "CONNECT";
    }
  });

  $("#logout-btn").addEventListener("click", () => {
    localStorage.removeItem("janus_api_key");
    state.apiKey = "";
    closeWs();
    showLogin();
  });

  // ── Nav ──
  function buildNav() {
    const nav = $("#nav");
    nav.innerHTML = "";
    for (const item of NAV_ITEMS) {
      const b = document.createElement("button");
      b.innerHTML = `<span class="nav-dot"></span>${item.label}`;
      b.dataset.view = item.id;
      if (item.id === state.view) b.classList.add("active");
      b.addEventListener("click", () => switchView(item.id));
      nav.appendChild(b);
    }
  }
  function switchView(id) {
    state.view = id;
    $$(".nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === id));
    const crumb = NAV_ITEMS.find((n) => n.id === id);
    $("#crumb-section").textContent = crumb ? crumb.label : id.toUpperCase();
    renderView();
  }

  // ── View rendering ──
  function renderView() {
    const view = $("#view");
    view.innerHTML = "";
    const tplId = {
      dash:  "tpl-dashboard",
      watch: "tpl-watchlist",
      chart: "tpl-chart",
      strat: "tpl-strategy",
      scan:  "tpl-scanner",
      agent: "tpl-agent",
      logs:  "tpl-logs",
      set:   "tpl-settings",
    }[state.view];
    const tpl = $("#" + tplId);
    if (!tpl) return;
    view.appendChild(tpl.content.cloneNode(true));

    switch (state.view) {
      case "dash":  mountDashboard(); break;
      case "watch": mountWatchlist(); break;
      case "chart": mountChart(); break;
      case "strat": mountStrategy(); break;
      case "scan":  mountScanner(); break;
      case "agent": mountAgent(); break;
      case "logs":  mountLogs(); break;
      case "set":   mountSettings(); break;
    }
  }

  // ── Dashboard ──
  function mountDashboard() {
    paintDashboard();
  }
  function paintDashboard() {
    const s = state.status;
    if (!s) return;
    const sum = s.summary || {};
    const positions = s.positions || [];
    const trades = s.recent_trades || [];
    const watchlist = s.watchlist || [];
    const auto = s.autopilot || {};

    const bind = (k, v) => { const el = $(`[data-bind="${k}"]`); if (el) el.textContent = v; };

    bind("totalValue", fmt.money(sum.total_value));
    bind("cash", fmt.money(sum.cash));
    bind("returnPct", fmt.pct(sum.total_return_pct));
    bind("realized", fmt.money(sum.realized_pnl));
    bind("posCount", positions.length);
    bind("posCountTag", positions.length);
    bind("portfolio", s.portfolio || "main");
    bind("autoState", auto.running ? "RUNNING" : "STOPPED");

    const retEl = $('[data-bind="returnPct"]');
    if (retEl) {
      retEl.classList.toggle("up",   (sum.total_return_pct ?? 0) > 0);
      retEl.classList.toggle("down", (sum.total_return_pct ?? 0) < 0);
    }
    const autoEl = $('[data-bind="autoState"]');
    if (autoEl) {
      autoEl.classList.toggle("up",   !!auto.running);
      autoEl.classList.toggle("down", !auto.running);
    }

    // Positions table
    const posBody = $('[data-bind="positionsBody"]');
    if (posBody) {
      if (positions.length === 0) {
        posBody.innerHTML = `<tr><td colspan="6" class="muted">no open positions</td></tr>`;
      } else {
        posBody.innerHTML = positions.map((p) => {
          const pnlCls = p.pnl >= 0 ? "val-up" : "val-down";
          return `<tr>
            <td>${escapeHTML(p.symbol)}</td>
            <td>${p.quantity}</td>
            <td>${fmt.num(p.avg_price)}</td>
            <td>${fmt.num(p.current_price)}</td>
            <td class="${pnlCls}">${fmt.money(p.pnl)}</td>
            <td class="${pnlCls}">${fmt.pct(p.pnl_pct)}</td>
          </tr>`;
        }).join("");
      }
    }

    // Trades table
    const tBody = $('[data-bind="tradesBody"]');
    if (tBody) {
      if (trades.length === 0) {
        tBody.innerHTML = `<tr><td colspan="6" class="muted">no recent trades</td></tr>`;
      } else {
        tBody.innerHTML = trades.slice().reverse().map((t) => {
          const side = (t.action || t.side || "").toUpperCase();
          const cls = side === "BUY" ? "side-buy" : "side-sell";
          const price = t.exit_price ?? t.entry_price ?? t.price;
          const pnl = t.pnl;
          const pnlCls = pnl == null ? "" : pnl >= 0 ? "val-up" : "val-down";
          return `<tr>
            <td>${fmt.time(t.timestamp || t.time)}</td>
            <td class="${cls}">${side || "—"}</td>
            <td>${escapeHTML(t.symbol || "—")}</td>
            <td>${t.quantity ?? "—"}</td>
            <td>${fmt.num(price)}</td>
            <td class="${pnlCls}">${pnl != null ? fmt.money(pnl) : ""}</td>
          </tr>`;
        }).join("");
      }
    }

    // Bind auto buttons
    const start = $('[data-action="auto-start"]');
    const stop  = $('[data-action="auto-stop"]');
    if (start) start.onclick = () => autopilotControl("start");
    if (stop)  stop.onclick  = () => autopilotControl("stop");
  }

  async function autopilotControl(action) {
    try {
      const body = action === "start" ? JSON.stringify({}) : JSON.stringify({});
      await api(`/autopilot/${action}`, { method: "POST", body });
      toast(`Autopilot ${action.toUpperCase()} ok`);
      refreshStatus();
    } catch (e) {
      toast(`Autopilot ${action}: ${e.message}`, true);
    }
  }

  // ── Watchlist ──
  const _wlPrev = {};
  function mountWatchlist() { paintWatchlist(); }
  function paintWatchlist() {
    const grid = $("#wl-grid");
    if (!grid) return;
    const watchlist = state.status?.watchlist || [];
    const count = $("#wl-count");
    if (count) count.textContent = `${watchlist.length} symbols`;
    grid.innerHTML = watchlist.map((sym) => {
      const price = state.prices[sym];
      const prev = _wlPrev[sym];
      const dir = prev != null && price != null
        ? (price > prev ? "up" : price < prev ? "down" : "")
        : "";
      return `<div class="wl-item ${dir}" data-sym="${escapeHTML(sym)}">
        <div class="wl-sym">${escapeHTML(sym)}</div>
        <div class="wl-price">${price != null ? fmt.num(price) : "—"}</div>
      </div>`;
    }).join("");
    Object.assign(_wlPrev, state.prices);

    // Click tile to jump to Charts for that symbol
    grid.querySelectorAll(".wl-item").forEach((el) => {
      el.style.cursor = "pointer";
      el.addEventListener("click", () => {
        state.chartSymbol = el.dataset.sym;
        switchView("chart");
      });
    });
  }

  // ── Charts (lightweight-charts) ──
  const _chart = {
    main: null, sub: null,
    candleSeries: null, volumeSeries: null,
    ma20Series: null, ema50Series: null,
    bbUpSeries: null, bbLoSeries: null, bbMidSeries: null,
    rsiSeries: null,
    indicators: { ma20: false, ema50: false, bb: false, vol: true, rsi: true },
    resizeObs: null,
  };

  async function mountChart() {
    const input = $("#chart-symbol");
    const suggest = $("#chart-suggest");
    const watchlist = state.status?.watchlist || [];
    if (!state.chartSymbol && watchlist.length) state.chartSymbol = watchlist[0];
    input.value = state.chartSymbol || "";

    let hlIndex = -1;
    let items = [];

    const closeSuggest = () => { suggest.hidden = true; hlIndex = -1; };
    const openSuggest = () => {
      const q = input.value.trim().toUpperCase();
      items = watchlist.filter((s) => s.toUpperCase().includes(q)).slice(0, 15);
      if (!items.length) { closeSuggest(); return; }
      suggest.innerHTML = items.map((s, i) => {
        const p = state.prices[s];
        return `<div class="suggest-item ${i === hlIndex ? "hl" : ""}" data-sym="${escapeHTML(s)}">
          <span>${escapeHTML(s)}</span>
          <span class="s-price">${p != null ? fmt.num(p) : ""}</span>
        </div>`;
      }).join("");
      suggest.hidden = false;
      suggest.querySelectorAll(".suggest-item").forEach((el) => {
        el.addEventListener("mousedown", (e) => {
          e.preventDefault();
          input.value = el.dataset.sym;
          state.chartSymbol = el.dataset.sym;
          closeSuggest();
          loadChart();
        });
      });
    };

    input.addEventListener("focus", openSuggest);
    input.addEventListener("input", () => { hlIndex = -1; openSuggest(); });
    input.addEventListener("blur", () => setTimeout(closeSuggest, 120));
    input.addEventListener("keydown", (e) => {
      if (suggest.hidden && (e.key === "ArrowDown" || e.key === "ArrowUp")) { openSuggest(); return; }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        hlIndex = Math.min(items.length - 1, hlIndex + 1);
        openSuggest();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        hlIndex = Math.max(0, hlIndex - 1);
        openSuggest();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const pick = hlIndex >= 0 ? items[hlIndex] : input.value.trim().toUpperCase();
        if (!pick) return;
        input.value = pick;
        state.chartSymbol = pick;
        closeSuggest();
        loadChart();
      } else if (e.key === "Escape") {
        closeSuggest();
      }
    });

    $$("#tf-group button").forEach((b) => {
      b.classList.toggle("active", b.dataset.tf === state.chartTf);
      b.onclick = () => {
        state.chartTf = b.dataset.tf;
        $$("#tf-group button").forEach((x) => x.classList.toggle("active", x.dataset.tf === state.chartTf));
        loadChart();
      };
    });

    // Indicator toggles
    $$("#ind-bar button[data-ind]").forEach((b) => {
      const key = b.dataset.ind;
      b.classList.toggle("active", !!_chart.indicators[key]);
      b.onclick = () => {
        _chart.indicators[key] = !_chart.indicators[key];
        b.classList.toggle("active", _chart.indicators[key]);
        refreshIndicators();
      };
    });
    const resetBtn = $('[data-action="chart-reset"]');
    if (resetBtn) resetBtn.onclick = () => {
      if (_chart.main) _chart.main.timeScale().fitContent();
      if (_chart.sub) _chart.sub.timeScale().fitContent();
    };

    initCharts();
    await loadChart();
  }

  function initCharts() {
    const main = $("#chart-main");
    const sub = $("#chart-sub");
    if (!main || !sub || !window.LightweightCharts) return;

    // Teardown old charts if re-mounting
    if (_chart.main) { try { _chart.main.remove(); } catch {} _chart.main = null; }
    if (_chart.sub)  { try { _chart.sub.remove();  } catch {} _chart.sub  = null; }
    main.innerHTML = ""; sub.innerHTML = "";

    const commonOpts = {
      layout: {
        background: { color: "#10141d" },
        textColor: "#7a8a7e",
        fontFamily: "JetBrains Mono, ui-monospace, monospace",
        fontSize: 10,
      },
      grid: {
        vertLines: { color: "rgba(180,255,0,0.04)" },
        horzLines: { color: "rgba(180,255,0,0.04)" },
      },
      rightPriceScale: { borderColor: "#1e2730" },
      timeScale: { borderColor: "#1e2730", timeVisible: true, secondsVisible: false },
      crosshair: {
        mode: 1,
        vertLine: { color: "#b4ff00", width: 1, style: 2, labelBackgroundColor: "#161c26" },
        horzLine: { color: "#b4ff00", width: 1, style: 2, labelBackgroundColor: "#161c26" },
      },
    };

    _chart.main = LightweightCharts.createChart(main, {
      ...commonOpts,
      width: main.clientWidth,
      height: main.clientHeight,
    });
    _chart.candleSeries = _chart.main.addCandlestickSeries({
      upColor: "#3ddc97", downColor: "#ff4d6d",
      wickUpColor: "#3ddc97", wickDownColor: "#ff4d6d",
      borderVisible: false,
    });
    _chart.volumeSeries = _chart.main.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
      color: "rgba(180,255,0,0.35)",
    });
    _chart.main.priceScale("vol").applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });

    _chart.sub = LightweightCharts.createChart(sub, {
      ...commonOpts,
      width: sub.clientWidth,
      height: sub.clientHeight,
    });
    _chart.rsiSeries = _chart.sub.addLineSeries({
      color: "#b4ff00", lineWidth: 1, priceLineVisible: false, lastValueVisible: true,
    });
    // 30/70 reference bands
    _chart.rsiSeries.createPriceLine({ price: 30, color: "#3ddc97", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "30" });
    _chart.rsiSeries.createPriceLine({ price: 70, color: "#ff4d6d", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "70" });

    // Sync time scales between main + sub panes
    const syncing = { val: false };
    const sync = (a, b) => (range) => {
      if (syncing.val || !range) return;
      syncing.val = true;
      try { b.timeScale().setVisibleLogicalRange(range); } catch {}
      syncing.val = false;
    };
    _chart.main.timeScale().subscribeVisibleLogicalRangeChange(sync(_chart.main, _chart.sub));
    _chart.sub.timeScale().subscribeVisibleLogicalRangeChange(sync(_chart.sub, _chart.main));

    // Crosshair legend
    _chart.main.subscribeCrosshairMove((param) => {
      const leg = $("#chart-legend");
      if (!leg) return;
      if (!param || !param.time || !param.seriesData) return;
      const c = param.seriesData.get(_chart.candleSeries);
      if (!c) return;
      const chg = c.close - c.open;
      const pct = (chg / c.open) * 100;
      const col = chg >= 0 ? "#3ddc97" : "#ff4d6d";
      leg.innerHTML = `<b>${escapeHTML(state.chartSymbol)}</b> · O ${c.open.toFixed(2)} H ${c.high.toFixed(2)} L ${c.low.toFixed(2)} C ${c.close.toFixed(2)} · <span style="color:${col}">${chg >= 0 ? "+" : ""}${pct.toFixed(2)}%</span>`;
    });

    // Resize on container changes
    if (_chart.resizeObs) _chart.resizeObs.disconnect();
    _chart.resizeObs = new ResizeObserver(() => {
      if (_chart.main) _chart.main.applyOptions({ width: main.clientWidth, height: main.clientHeight });
      if (_chart.sub)  _chart.sub.applyOptions({ width: sub.clientWidth, height: sub.clientHeight });
    });
    _chart.resizeObs.observe(main);
    _chart.resizeObs.observe(sub);
  }

  function refreshIndicators() {
    const wrap = $("#chart-wrap");
    if (wrap) wrap.classList.toggle("no-sub", !_chart.indicators.rsi);
    if (_chart.main) _chart.main.applyOptions({ width: $("#chart-main").clientWidth, height: $("#chart-main").clientHeight });
    // Re-apply overlays from last-loaded candles
    if (_chart._lastCandles) applyIndicators(_chart._lastCandles);
  }

  function applyIndicators(candles) {
    if (!_chart.main) return;
    const closes = candles.map((c) => c.c);
    const times  = candles.map((c) => Math.floor(new Date(c.t).getTime() / 1000));

    // Volume
    if (_chart.indicators.vol) {
      _chart.volumeSeries.setData(candles.map((c, i) => ({
        time: times[i],
        value: c.v || 0,
        color: c.c >= c.o ? "rgba(61,220,151,0.35)" : "rgba(255,77,109,0.35)",
      })));
    } else {
      _chart.volumeSeries.setData([]);
    }

    // MA20
    if (_chart.indicators.ma20) {
      if (!_chart.ma20Series) _chart.ma20Series = _chart.main.addLineSeries({ color: "#00f0ff", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      const ma = smaSeries(closes, 20);
      _chart.ma20Series.setData(ma.map((v, i) => v == null ? null : { time: times[i], value: v }).filter(Boolean));
    } else if (_chart.ma20Series) {
      _chart.main.removeSeries(_chart.ma20Series); _chart.ma20Series = null;
    }

    // EMA50
    if (_chart.indicators.ema50) {
      if (!_chart.ema50Series) _chart.ema50Series = _chart.main.addLineSeries({ color: "#ffb300", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      const ema = emaSeries(closes, 50);
      _chart.ema50Series.setData(ema.map((v, i) => v == null ? null : { time: times[i], value: v }).filter(Boolean));
    } else if (_chart.ema50Series) {
      _chart.main.removeSeries(_chart.ema50Series); _chart.ema50Series = null;
    }

    // Bollinger Bands
    if (_chart.indicators.bb) {
      const bb = bbSeries(closes, 20, 2);
      if (!_chart.bbUpSeries) _chart.bbUpSeries = _chart.main.addLineSeries({ color: "rgba(180,255,0,0.6)", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      if (!_chart.bbLoSeries) _chart.bbLoSeries = _chart.main.addLineSeries({ color: "rgba(180,255,0,0.6)", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      if (!_chart.bbMidSeries) _chart.bbMidSeries = _chart.main.addLineSeries({ color: "rgba(180,255,0,0.3)", lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false });
      _chart.bbUpSeries.setData(bb.up.map((v, i) => v == null ? null : { time: times[i], value: v }).filter(Boolean));
      _chart.bbLoSeries.setData(bb.lo.map((v, i) => v == null ? null : { time: times[i], value: v }).filter(Boolean));
      _chart.bbMidSeries.setData(bb.mid.map((v, i) => v == null ? null : { time: times[i], value: v }).filter(Boolean));
    } else {
      for (const k of ["bbUpSeries", "bbLoSeries", "bbMidSeries"]) {
        if (_chart[k]) { _chart.main.removeSeries(_chart[k]); _chart[k] = null; }
      }
    }

    // RSI sub-pane
    if (_chart.indicators.rsi && _chart.sub) {
      const rsi = rsiSeries(closes, 14);
      _chart.rsiSeries.setData(rsi.map((v, i) => v == null ? null : { time: times[i], value: v }).filter(Boolean));
    }
  }

  async function loadChart() {
    if (!state.chartSymbol) return;
    const leg = $("#chart-legend");
    if (leg) leg.innerHTML = `<b>${escapeHTML(state.chartSymbol)}</b> · loading...`;
    try {
      const d = await api(`/candles?symbol=${encodeURIComponent(state.chartSymbol)}&timeframe=${state.chartTf}&limit=500`);
      const candles = d.candles || [];
      state.chartData = candles;
      _chart._lastCandles = candles;

      if (!_chart.candleSeries) initCharts();
      if (!candles.length) {
        _chart.candleSeries.setData([]);
        if (leg) leg.innerHTML = `<b>${escapeHTML(state.chartSymbol)}</b> · no data`;
        return;
      }

      const candleData = candles.map((c) => ({
        time: Math.floor(new Date(c.t).getTime() / 1000),
        open: c.o, high: c.h, low: c.l, close: c.c,
      }));
      _chart.candleSeries.setData(candleData);
      applyIndicators(candles);
      _chart.main.timeScale().fitContent();
      if (_chart.sub) _chart.sub.timeScale().fitContent();

      const first = candles[0], last = candles[candles.length - 1];
      const chg = ((last.c - first.c) / first.c) * 100;
      const col = chg >= 0 ? "#3ddc97" : "#ff4d6d";
      if (leg) {
        leg.innerHTML = `<b>${escapeHTML(state.chartSymbol)}</b> · ${state.chartTf} · LAST ${last.c.toFixed(2)} ` +
          `· <span style="color:${col}">${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%</span>`;
      }

      const wrap = $("#chart-wrap");
      if (wrap) wrap.classList.toggle("no-sub", !_chart.indicators.rsi);
    } catch (e) {
      if (leg) leg.innerHTML = `<b>${escapeHTML(state.chartSymbol)}</b> · error: ${escapeHTML(e.message)}`;
    }
  }

  // ── Scanner ──
  function mountScanner() {
    $('[data-action="scan-rules"]').onclick = () => runScan(false);
    $('[data-action="scan-ai"]').onclick = () => runScan(true);
  }

  async function runScan(useAI) {
    const body = $("#scan-body");
    const stateEl = $("#scan-state");
    body.innerHTML = `<tr><td colspan="7" class="muted">scanning...</td></tr>`;
    stateEl.textContent = useAI ? "ai scan starting..." : "running rule scan...";
    try {
      if (!useAI) {
        const d = await api("/scan");
        renderSignals(d.signals || []);
        stateEl.textContent = `${(d.signals || []).length} signals · rules`;
        return;
      }
      const start = await api("/ai-scan");
      const jobId = start.job_id;
      stateEl.textContent = `ai scan job ${jobId.slice(0, 8)}...`;
      // poll
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        await sleep(2500);
        const job = await api(`/scan/status/${jobId}`);
        if (job.status === "completed") {
          renderSignals(job.signals || []);
          stateEl.textContent = `${(job.signals || []).length} signals · AI${job.error ? " (partial)" : ""}`;
          if (job.error) toast(job.error, true, 6000);
          return;
        }
        if (job.status === "failed") {
          stateEl.textContent = "ai scan failed";
          toast(job.error || "AI scan failed", true);
          body.innerHTML = `<tr><td colspan="7" class="muted">failed — see toast</td></tr>`;
          return;
        }
      }
      stateEl.textContent = "ai scan timed out";
    } catch (e) {
      stateEl.textContent = "error";
      body.innerHTML = `<tr><td colspan="7" class="muted">error: ${escapeHTML(e.message)}</td></tr>`;
    }
  }

  function renderSignals(signals) {
    const body = $("#scan-body");
    if (!signals.length) {
      body.innerHTML = `<tr><td colspan="7" class="muted">no signals</td></tr>`;
      return;
    }
    body.innerHTML = signals.map((s) => {
      const sig = (s.signal || "HOLD").toUpperCase();
      const cls = sig === "BUY" ? "side-buy" : sig === "SELL" ? "side-sell" : "";
      return `<tr>
        <td>${escapeHTML(s.symbol || "—")}</td>
        <td class="${cls}">${sig}</td>
        <td>${fmt.num(s.price)}</td>
        <td>${s.confidence != null ? (Number(s.confidence) * 100).toFixed(0) + "%" : "—"}</td>
        <td>${fmt.num(s.stop_loss)}</td>
        <td>${fmt.num(s.target)}</td>
        <td class="muted">${escapeHTML(s.reason || "—")}</td>
      </tr>`;
    }).join("");
  }

  // ── Agent chat ──
  function mountAgent() {
    const log = $("#chat-log");
    log.innerHTML = state.chatHistory.map((m) => renderMsg(m)).join("") ||
      `<div class="msg ai"><div class="role">SYSTEM</div><div class="body">AGENT ONLINE — ask about portfolio, market, or type BUY/SELL SYMBOL.</div></div>`;
    log.scrollTop = log.scrollHeight;

    $("#chat-form").onsubmit = async (e) => {
      e.preventDefault();
      const input = $("#chat-input");
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      pushMsg({ role: "user", content: text });

      const stateEl = $("#chat-state");
      stateEl.textContent = "thinking...";
      try {
        const start = await api("/chat", {
          method: "POST",
          body: JSON.stringify({
            message: text,
            history: state.chatHistory.slice(-10).map((m) => ({ role: m.role, content: m.content })),
          }),
        });
        const jobId = start.job_id;
        const deadline = Date.now() + 300_000;
        while (Date.now() < deadline) {
          await sleep(2000);
          const job = await api(`/chat/status/${jobId}`);
          if (job.status === "completed") {
            pushMsg({ role: "assistant", content: job.reply || "(no reply)" });
            stateEl.textContent = "ready";
            return;
          }
          if (job.status === "failed") {
            pushMsg({ role: "assistant", content: "⚠ " + (job.error || "failed"), err: true });
            stateEl.textContent = "error";
            return;
          }
        }
        pushMsg({ role: "assistant", content: "⚠ timed out", err: true });
        stateEl.textContent = "timeout";
      } catch (e) {
        pushMsg({ role: "assistant", content: "⚠ " + e.message, err: true });
        stateEl.textContent = "error";
      }
    };
  }

  function renderMsg(m) {
    const cls = "msg " + (m.role === "user" ? "user" : "ai") + (m.err ? " err" : "");
    const label = m.role === "user" ? "YOU" : "AGENT";
    return `<div class="${cls}"><div class="role">${label}</div><div class="body">${escapeHTML(m.content)}</div></div>`;
  }
  function pushMsg(m) {
    state.chatHistory.push({ role: m.role, content: m.content, err: !!m.err });
    const log = $("#chat-log");
    if (!log) return;
    log.insertAdjacentHTML("beforeend", renderMsg(state.chatHistory[state.chatHistory.length - 1]));
    log.scrollTop = log.scrollHeight;
  }

  // ── Logs (WebSocket) ──
  function mountLogs() {
    $('[data-action="logs-clear"]').onclick = () => { $("#log-stream").textContent = ""; };
    openWs();
  }

  function openWs() {
    if (!state.apiKey) return;
    closeWs();
    // Auth via first-message rather than ?token= query string. Keeps the API
    // key out of reverse-proxy access logs and any URL-capturing telemetry.
    const url = `${WS_BASE}/ws/logs`;
    let ws;
    try { ws = new WebSocket(url); } catch { return; }
    state.ws = ws;
    updateWsPill(false, "CONNECTING");

    ws.onopen = () => {
      // Send auth as the very first frame, then mark LIVE on first server msg.
      try { ws.send(JSON.stringify({ type: "auth", key: state.apiKey })); } catch {}
      updateWsPill(true, "LIVE");
    };
    ws.onclose = () => {
      updateWsPill(false, "DISCONNECTED");
      if (state.view === "logs" && state.apiKey) {
        clearTimeout(state.wsReconnect);
        state.wsReconnect = setTimeout(openWs, 3000);
      }
    };
    ws.onerror = () => updateWsPill(false, "ERROR");
    ws.onmessage = (ev) => {
      let line = ev.data;
      try {
        const o = JSON.parse(ev.data);
        if (o.type === "pong") return;
        line = o.message || o.line || ev.data;
      } catch {}
      appendLogLine(line);
    };
  }
  function closeWs() {
    clearTimeout(state.wsReconnect);
    if (state.ws) {
      try { state.ws.close(); } catch {}
      state.ws = null;
    }
  }
  function updateWsPill(ok, label) {
    const pill = $("#ws-state");
    if (!pill) return;
    pill.classList.toggle("ok", ok);
    pill.querySelector("span:last-child").textContent = label;
  }
  function appendLogLine(line) {
    const pre = $("#log-stream");
    if (!pre) return;
    const level = /\b(ERROR|WARN|WARNING|INFO|DEBUG)\b/.exec(line)?.[1] || "INFO";
    const el = document.createElement("span");
    el.className = "log-line " + level;
    el.textContent = line + (line.endsWith("\n") ? "" : "\n");
    pre.appendChild(el);
    // Trim to last 2000 lines
    if (pre.childNodes.length > 2000) {
      while (pre.childNodes.length > 2000) pre.removeChild(pre.firstChild);
    }
    pre.scrollTop = pre.scrollHeight;
  }

  // ── Strategy builder ──
  const INDICATORS = [
    "close", "open", "high", "low",
    "sma20", "sma50", "ema20", "ema50",
    "rsi14", "bb_up", "bb_lo", "bb_mid",
    "atr14", "volume",
  ];
  const OPS = [">", ">=", "<", "<=", "cross_above", "cross_below"];
  const ACTIONS = ["BUY", "SELL", "EXIT"];

  const STRAT_TEMPLATES = {
    ema_cross: {
      name: "EMA Cross",
      rules: [
        { indicator: "ema20", op: "cross_above", value: "ema50", action: "BUY" },
        { indicator: "ema20", op: "cross_below", value: "ema50", action: "EXIT" },
      ],
    },
    rsi_mr: {
      name: "RSI Mean Reversion",
      rules: [
        { indicator: "rsi14", op: "<", value: "30", action: "BUY" },
        { indicator: "rsi14", op: ">", value: "70", action: "EXIT" },
      ],
    },
    bb_breakout: {
      name: "Bollinger Breakout",
      rules: [
        { indicator: "close", op: "cross_above", value: "bb_up", action: "BUY" },
        { indicator: "close", op: "cross_below", value: "bb_mid", action: "EXIT" },
      ],
    },
    sma_trend: {
      name: "SMA Trend",
      rules: [
        { indicator: "close", op: ">", value: "sma50", action: "BUY" },
        { indicator: "close", op: "<", value: "sma50", action: "EXIT" },
      ],
    },
  };

  state.strategy = state.strategy || {
    name: "",
    rules: [],
    symbol: "",
    tf: "1h",
    settings: { capital: 100000, pos: 100, fee: 0.05, sl: 3, tp: 6, slip: 0.03 },
  };
  if (!state.strategy.settings) {
    state.strategy.settings = { capital: 100000, pos: 100, fee: 0.05, sl: 3, tp: 6, slip: 0.03 };
  }

  const _stratChart = {
    main: null, sub: null,
    candleSeries: null, equitySeries: null,
    markers: [],
  };

  function mountStrategy() {
    const symFallback = state.strategy.symbol || state.chartSymbol || state.status?.watchlist?.[0] || "";
    $("#strat-name").value = state.strategy.name || "";
    $("#strat-symbol").value = symFallback;
    state.strategy.symbol = symFallback.toUpperCase();
    $("#strat-tf").value = state.strategy.tf || "1h";
    const s = state.strategy.settings;
    $("#strat-capital").value = s.capital;
    $("#strat-pos").value = s.pos;
    $("#strat-fee").value = s.fee;
    $("#strat-sl").value = s.sl;
    $("#strat-tp").value = s.tp;
    $("#strat-slip").value = s.slip;

    renderStrategyRules();

    $("#strat-name").oninput = (e) => { state.strategy.name = e.target.value; };
    $("#strat-symbol").oninput = (e) => { state.strategy.symbol = e.target.value.toUpperCase(); };
    $("#strat-tf").onchange = (e) => { state.strategy.tf = e.target.value; };
    for (const k of ["capital", "pos", "fee", "sl", "tp", "slip"]) {
      $(`#strat-${k}`).oninput = (e) => { state.strategy.settings[k] = Number(e.target.value); };
    }

    $("#strat-template").onchange = (e) => {
      const key = e.target.value;
      if (!key) return;
      const tpl = STRAT_TEMPLATES[key];
      state.strategy.name = tpl.name;
      state.strategy.rules = tpl.rules.map((r) => ({ ...r, value: String(r.value) }));
      $("#strat-name").value = state.strategy.name;
      renderStrategyRules();
      toast(`Loaded template: ${tpl.name}`);
      e.target.value = "";
    };

    $('[data-action="strat-add"]').onclick = () => {
      state.strategy.rules.push({ indicator: "close", op: ">", value: "sma20", action: "BUY" });
      renderStrategyRules();
    };
    $('[data-action="strat-clear"]').onclick = () => {
      state.strategy.rules = [];
      renderStrategyRules();
    };
    $('[data-action="strat-save"]').onclick = () => {
      localStorage.setItem("neon_strategy", JSON.stringify(state.strategy));
      toast("Strategy saved");
    };
    $('[data-action="strat-load"]').onclick = () => {
      const raw = localStorage.getItem("neon_strategy");
      if (!raw) return toast("no saved strategy", true);
      try {
        const loaded = JSON.parse(raw);
        state.strategy = Object.assign({}, state.strategy, loaded);
        state.strategy.settings = Object.assign({}, state.strategy.settings, loaded.settings || {});
        mountStrategy();
        toast("Strategy loaded");
      } catch { toast("corrupt saved strategy", true); }
    };
    $('[data-action="strat-backtest"]').onclick = runBacktest;
    $('[data-action="strat-ai-gen"]').onclick = generateStrategyWithAI;

    initStratChart();
  }

  function initStratChart() {
    if (!window.LightweightCharts) return;
    const main = $("#strat-chart-main");
    const sub = $("#strat-chart-sub");
    if (!main || !sub) return;
    if (_stratChart.main) { try { _stratChart.main.remove(); } catch {} _stratChart.main = null; }
    if (_stratChart.sub)  { try { _stratChart.sub.remove();  } catch {} _stratChart.sub  = null; }
    main.innerHTML = ""; sub.innerHTML = "";

    const common = {
      layout: { background: { color: "#10141d" }, textColor: "#7a8a7e", fontFamily: "JetBrains Mono, ui-monospace, monospace", fontSize: 10 },
      grid: { vertLines: { color: "rgba(180,255,0,0.04)" }, horzLines: { color: "rgba(180,255,0,0.04)" } },
      rightPriceScale: { borderColor: "#1e2730" },
      timeScale: { borderColor: "#1e2730", timeVisible: true, secondsVisible: false },
      crosshair: {
        mode: 1,
        vertLine: { color: "#b4ff00", width: 1, style: 2, labelBackgroundColor: "#161c26" },
        horzLine: { color: "#b4ff00", width: 1, style: 2, labelBackgroundColor: "#161c26" },
      },
    };
    _stratChart.main = LightweightCharts.createChart(main, { ...common, width: main.clientWidth, height: main.clientHeight });
    _stratChart.candleSeries = _stratChart.main.addCandlestickSeries({
      upColor: "#3ddc97", downColor: "#ff4d6d",
      wickUpColor: "#3ddc97", wickDownColor: "#ff4d6d",
      borderVisible: false,
    });

    _stratChart.sub = LightweightCharts.createChart(sub, { ...common, width: sub.clientWidth, height: sub.clientHeight });
    _stratChart.equitySeries = _stratChart.sub.addAreaSeries({
      topColor: "rgba(180,255,0,0.35)",
      bottomColor: "rgba(180,255,0,0.02)",
      lineColor: "#b4ff00",
      lineWidth: 2,
      priceLineVisible: false,
    });

    const syncing = { val: false };
    const sync = (src, dst) => (range) => {
      if (syncing.val || !range) return;
      syncing.val = true;
      try { dst.timeScale().setVisibleLogicalRange(range); } catch {}
      syncing.val = false;
    };
    _stratChart.main.timeScale().subscribeVisibleLogicalRangeChange(sync(_stratChart.main, _stratChart.sub));
    _stratChart.sub.timeScale().subscribeVisibleLogicalRangeChange(sync(_stratChart.sub, _stratChart.main));

    _stratChart.main.subscribeCrosshairMove((param) => {
      const leg = $("#strat-chart-legend");
      if (!leg || !param?.time || !param.seriesData) return;
      const c = param.seriesData.get(_stratChart.candleSeries);
      if (!c) return;
      const sym = $("#strat-symbol").value.toUpperCase() || state.strategy.symbol;
      leg.innerHTML = `<b>${escapeHTML(sym)}</b> · O ${c.open.toFixed(2)} H ${c.high.toFixed(2)} L ${c.low.toFixed(2)} C ${c.close.toFixed(2)}`;
    });

    if (_stratChart.resizeObs) _stratChart.resizeObs.disconnect();
    _stratChart.resizeObs = new ResizeObserver(() => {
      if (_stratChart.main) _stratChart.main.applyOptions({ width: main.clientWidth, height: main.clientHeight });
      if (_stratChart.sub)  _stratChart.sub.applyOptions({ width: sub.clientWidth, height: sub.clientHeight });
    });
    _stratChart.resizeObs.observe(main);
    _stratChart.resizeObs.observe(sub);
  }

  function renderStrategyRules() {
    const box = $("#strat-rules");
    if (!box) return;
    box.innerHTML = state.strategy.rules.map((r, i) => {
      const opts = (arr, cur) => arr.map((v) => `<option ${v === cur ? "selected" : ""}>${v}</option>`).join("");
      return `<div class="strat-rule" data-i="${i}">
        <select data-f="indicator">${opts(INDICATORS, r.indicator)}</select>
        <select data-f="op">${opts(OPS, r.op)}</select>
        <input data-f="value" value="${escapeHTML(String(r.value))}" placeholder="value or indicator" />
        <select data-f="action">${opts(ACTIONS, r.action)}</select>
        <span class="muted small">rule #${i + 1}</span>
        <button class="rm" title="remove">✕</button>
      </div>`;
    }).join("");

    box.querySelectorAll(".strat-rule").forEach((row) => {
      const i = Number(row.dataset.i);
      row.querySelectorAll("[data-f]").forEach((el) => {
        el.onchange = el.oninput = () => {
          state.strategy.rules[i][el.dataset.f] = el.value;
        };
      });
      row.querySelector(".rm").onclick = () => {
        state.strategy.rules.splice(i, 1);
        renderStrategyRules();
      };
    });
  }

  // ── Indicators (pure JS, operate on candle arrays) ──
  function smaSeries(closes, n) {
    const out = new Array(closes.length).fill(null);
    let sum = 0;
    for (let i = 0; i < closes.length; i++) {
      sum += closes[i];
      if (i >= n) sum -= closes[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }
  function emaSeries(closes, n) {
    const out = new Array(closes.length).fill(null);
    const k = 2 / (n + 1);
    let ema = null;
    for (let i = 0; i < closes.length; i++) {
      if (i < n - 1) continue;
      if (ema == null) {
        let s = 0;
        for (let j = 0; j < n; j++) s += closes[i - j];
        ema = s / n;
      } else {
        ema = closes[i] * k + ema * (1 - k);
      }
      out[i] = ema;
    }
    return out;
  }
  function rsiSeries(closes, n) {
    const out = new Array(closes.length).fill(null);
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      const g = Math.max(0, diff);
      const l = Math.max(0, -diff);
      if (i <= n) {
        avgGain += g; avgLoss += l;
        if (i === n) {
          avgGain /= n; avgLoss /= n;
          out[i] = 100 - 100 / (1 + (avgLoss === 0 ? 100 : avgGain / avgLoss));
        }
      } else {
        avgGain = (avgGain * (n - 1) + g) / n;
        avgLoss = (avgLoss * (n - 1) + l) / n;
        out[i] = 100 - 100 / (1 + (avgLoss === 0 ? 100 : avgGain / avgLoss));
      }
    }
    return out;
  }
  function bbSeries(closes, n, mult = 2) {
    const sma = smaSeries(closes, n);
    const up = new Array(closes.length).fill(null);
    const lo = new Array(closes.length).fill(null);
    for (let i = n - 1; i < closes.length; i++) {
      let s = 0;
      for (let j = 0; j < n; j++) { const d = closes[i - j] - sma[i]; s += d * d; }
      const sd = Math.sqrt(s / n);
      up[i] = sma[i] + mult * sd;
      lo[i] = sma[i] - mult * sd;
    }
    return { mid: sma, up, lo };
  }

  function atrSeries(highs, lows, closes, n) {
    const out = new Array(closes.length).fill(null);
    const trs = new Array(closes.length).fill(0);
    for (let i = 0; i < closes.length; i++) {
      if (i === 0) { trs[i] = highs[i] - lows[i]; continue; }
      trs[i] = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      );
    }
    let atr = null;
    for (let i = 0; i < closes.length; i++) {
      if (i < n - 1) continue;
      if (atr == null) {
        let s = 0;
        for (let j = 0; j < n; j++) s += trs[i - j];
        atr = s / n;
      } else {
        atr = (atr * (n - 1) + trs[i]) / n;
      }
      out[i] = atr;
    }
    return out;
  }

  function valueAt(i, token, series) {
    const t = String(token).trim().toLowerCase();
    if (!isNaN(Number(t))) return Number(t);
    const map = {
      close: series.closes, open: series.opens, high: series.highs, low: series.lows,
      volume: series.volumes,
      sma20: series.sma20, sma50: series.sma50,
      ema20: series.ema20, ema50: series.ema50,
      rsi14: series.rsi14, atr14: series.atr14,
      bb_up: series.bb_up, bb_lo: series.bb_lo, bb_mid: series.bb_mid,
    };
    const arr = map[t];
    if (!arr) return null;
    return arr[i];
  }

  function evalRule(rule, i, series) {
    const lhs = valueAt(i, rule.indicator, series);
    const rhs = valueAt(i, rule.value, series);
    if (lhs == null || rhs == null) return false;
    switch (rule.op) {
      case ">":  return lhs > rhs;
      case ">=": return lhs >= rhs;
      case "<":  return lhs < rhs;
      case "<=": return lhs <= rhs;
      case "cross_above": {
        const pLhs = valueAt(i - 1, rule.indicator, series);
        const pRhs = valueAt(i - 1, rule.value, series);
        return pLhs != null && pRhs != null && pLhs <= pRhs && lhs > rhs;
      }
      case "cross_below": {
        const pLhs = valueAt(i - 1, rule.indicator, series);
        const pRhs = valueAt(i - 1, rule.value, series);
        return pLhs != null && pRhs != null && pLhs >= pRhs && lhs < rhs;
      }
    }
    return false;
  }

  async function runBacktest() {
    const bt = $("#strat-bt-state");
    const body = $("#strat-bt-body");
    const kpisEl = $("#strat-bt-kpis");
    const countEl = $("#strat-bt-count");
    if (!state.strategy.rules.length) { toast("add at least one rule", true); return; }
    const sym = ($("#strat-symbol")?.value || state.strategy.symbol || state.chartSymbol || "").trim().toUpperCase();
    if (!sym) { toast("pick a symbol", true); return; }
    state.strategy.symbol = sym;
    state.strategy.tf = $("#strat-tf")?.value || state.strategy.tf;
    const settings = state.strategy.settings;
    const feeRate  = (settings.fee  || 0) / 100;
    const slipRate = (settings.slip || 0) / 100;
    const slPct    = (settings.sl   || 0) / 100;
    const tpPct    = (settings.tp   || 0) / 100;
    const posPct   = (settings.pos  || 100) / 100;
    const capital0 = Number(settings.capital) || 100000;

    bt.textContent = "loading candles...";
    body.innerHTML = `<tr><td colspan="10" class="muted">loading...</td></tr>`;
    try {
      const d = await api(`/candles?symbol=${encodeURIComponent(sym)}&timeframe=${state.strategy.tf}&limit=500`);
      const candles = d.candles || [];
      if (candles.length < 60) throw new Error("not enough candles");
      const closes = candles.map((c) => c.c);
      const highs  = candles.map((c) => c.h);
      const lows   = candles.map((c) => c.l);
      const bb = bbSeries(closes, 20, 2);
      const series = {
        closes, opens: candles.map((c) => c.o), highs, lows,
        volumes: candles.map((c) => c.v),
        sma20: smaSeries(closes, 20), sma50: smaSeries(closes, 50),
        ema20: emaSeries(closes, 20), ema50: emaSeries(closes, 50),
        rsi14: rsiSeries(closes, 14),
        atr14: atrSeries(highs, lows, closes, 14),
        bb_up: bb.up, bb_lo: bb.lo, bb_mid: bb.mid,
      };

      const trades = [];
      const equityPts = [];
      let equity = capital0;
      let peak = capital0;
      let maxDD = 0;
      let pos = null; // { side, entry, entryTime, entryIdx, qty, slPrice, tpPrice }
      const markers = [];

      const enter = (side, price, c, idx) => {
        const slipped = price * (1 + (side === "BUY" ? slipRate : -slipRate));
        const cash = equity * posPct;
        const qty = cash / slipped;
        const fee = cash * feeRate;
        equity -= fee;
        pos = {
          side, entry: slipped, entryTime: c.t, entryIdx: idx, qty,
          slPrice: side === "BUY" ? slipped * (1 - slPct) : slipped * (1 + slPct),
          tpPrice: side === "BUY" ? slipped * (1 + tpPct) : slipped * (1 - tpPct),
        };
        markers.push({
          time: Math.floor(new Date(c.t).getTime() / 1000),
          position: side === "BUY" ? "belowBar" : "aboveBar",
          color: side === "BUY" ? "#3ddc97" : "#ff4d6d",
          shape: side === "BUY" ? "arrowUp" : "arrowDown",
          text: `${side} ${slipped.toFixed(2)}`,
        });
      };

      const exit = (exitPrice, c, idx, reason) => {
        const slipped = exitPrice * (1 - (pos.side === "BUY" ? slipRate : -slipRate));
        const raw = pos.side === "BUY" ? (slipped - pos.entry) : (pos.entry - slipped);
        const grossPnl = raw * pos.qty;
        const fee = slipped * pos.qty * feeRate;
        const pnl = grossPnl - fee;
        const pnlPct = (raw / pos.entry) * 100;
        equity += pnl;
        if (equity > peak) peak = equity;
        const dd = peak > 0 ? (peak - equity) / peak * 100 : 0;
        if (dd > maxDD) maxDD = dd;
        trades.push({
          entryTime: pos.entryTime, exitTime: c.t,
          side: pos.side, entry: pos.entry, exit: slipped,
          qty: pos.qty, pnl, pnlPct, bars: idx - pos.entryIdx, reason,
        });
        markers.push({
          time: Math.floor(new Date(c.t).getTime() / 1000),
          position: pos.side === "BUY" ? "aboveBar" : "belowBar",
          color: pnl >= 0 ? "#3ddc97" : "#ff4d6d",
          shape: "circle",
          text: `EXIT ${slipped.toFixed(2)} (${pnl >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)`,
        });
        pos = null;
      };

      // Iterate after warm-up
      const warmup = 50;
      for (let i = warmup; i < candles.length; i++) {
        const c = candles[i];

        // SL/TP check first (intrabar on high/low)
        if (pos) {
          if (pos.side === "BUY") {
            if (c.l <= pos.slPrice) { exit(pos.slPrice, c, i, "SL"); }
            else if (c.h >= pos.tpPrice) { exit(pos.tpPrice, c, i, "TP"); }
          } else {
            if (c.h >= pos.slPrice) { exit(pos.slPrice, c, i, "SL"); }
            else if (c.l <= pos.tpPrice) { exit(pos.tpPrice, c, i, "TP"); }
          }
        }

        // Evaluate rules (on close)
        const fires = state.strategy.rules.filter((r) => evalRule(r, i, series));
        const want = fires.length ? fires[fires.length - 1].action : null;

        if (pos == null && (want === "BUY" || want === "SELL")) {
          enter(want, c.c, c, i);
        } else if (pos && (
          want === "EXIT" ||
          (want === "SELL" && pos.side === "BUY") ||
          (want === "BUY"  && pos.side === "SELL")
        )) {
          exit(c.c, c, i, "SIGNAL");
        }

        equityPts.push({
          time: Math.floor(new Date(c.t).getTime() / 1000),
          value: pos
            ? equity + (pos.side === "BUY" ? (c.c - pos.entry) : (pos.entry - c.c)) * pos.qty
            : equity,
        });
      }

      // Close any open position at last bar
      if (pos) {
        const last = candles[candles.length - 1];
        exit(last.c, last, candles.length - 1, "EOP");
      }

      // Metrics
      const total = trades.length;
      const wins = trades.filter((t) => t.pnl > 0);
      const losses = trades.filter((t) => t.pnl <= 0);
      const winRate = total ? (wins.length / total) * 100 : 0;
      const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
      const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
      const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
      const netPnl = equity - capital0;
      const retPct = (netPnl / capital0) * 100;
      const avgWin = wins.length ? grossWin / wins.length : 0;
      const avgLoss = losses.length ? -grossLoss / losses.length : 0;
      const expectancy = total ? netPnl / total : 0;

      // Max consecutive losers
      let maxConsLoss = 0, cur = 0;
      for (const t of trades) {
        if (t.pnl <= 0) { cur++; if (cur > maxConsLoss) maxConsLoss = cur; }
        else cur = 0;
      }

      // Sharpe-ish ratio on per-trade returns
      let sharpe = 0;
      if (total > 1) {
        const rets = trades.map((t) => t.pnlPct);
        const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
        const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
        sharpe = sd > 0 ? mean / sd : 0;
      }

      kpisEl.innerHTML = [
        ["NET P&L",        fmt.money(netPnl),            netPnl >= 0 ? "up" : "down"],
        ["RETURN",         retPct.toFixed(2) + "%",      retPct >= 0 ? "up" : "down"],
        ["TRADES",         String(total),                ""],
        ["WIN RATE",       winRate.toFixed(1) + "%",     winRate >= 50 ? "up" : "down"],
        ["PROFIT FACTOR",  profitFactor === Infinity ? "∞" : profitFactor.toFixed(2), profitFactor >= 1 ? "up" : "down"],
        ["AVG WIN",        fmt.money(avgWin),            "up"],
        ["AVG LOSS",       fmt.money(avgLoss),           "down"],
        ["EXPECTANCY",     fmt.money(expectancy),        expectancy >= 0 ? "up" : "down"],
        ["MAX DD",         maxDD.toFixed(2) + "%",       "down"],
        ["MAX CONS LOSS",  String(maxConsLoss),          ""],
        ["SHARPE (per trade)", sharpe.toFixed(2),        sharpe >= 0 ? "up" : "down"],
        ["FINAL EQUITY",   fmt.money(equity),            equity >= capital0 ? "up" : "down"],
      ].map(([label, value, cls]) =>
        `<div class="bt-kpi"><div class="k-label">${label}</div><div class="k-value ${cls}">${value}</div></div>`
      ).join("");

      countEl.textContent = `${total} trades`;
      if (!total) {
        body.innerHTML = `<tr><td colspan="10" class="muted">no trades fired — adjust rules</td></tr>`;
      } else {
        body.innerHTML = trades.slice().reverse().map((t, i) => {
          const n = total - i;
          const pnlCls = t.pnl >= 0 ? "val-up" : "val-down";
          const sideCls = t.side === "BUY" ? "side-buy" : "side-sell";
          return `<tr>
            <td>${n}</td>
            <td>${fmt.time(t.entryTime)}</td>
            <td>${fmt.time(t.exitTime)}</td>
            <td class="${sideCls}">${t.side}</td>
            <td>${fmt.num(t.entry)}</td>
            <td>${fmt.num(t.exit)}</td>
            <td class="${pnlCls}">${fmt.money(t.pnl)}</td>
            <td class="${pnlCls}">${t.pnlPct.toFixed(2)}%</td>
            <td>${t.bars}</td>
            <td class="muted">${escapeHTML(t.reason)}</td>
          </tr>`;
        }).join("");
      }
      bt.textContent = `${total} trades · ${sym} ${state.strategy.tf}`;

      // Render price + markers + equity
      if (!_stratChart.main) initStratChart();
      if (_stratChart.main && _stratChart.candleSeries) {
        const candleData = candles.map((c) => ({
          time: Math.floor(new Date(c.t).getTime() / 1000),
          open: c.o, high: c.h, low: c.l, close: c.c,
        }));
        _stratChart.candleSeries.setData(candleData);
        markers.sort((a, b) => a.time - b.time);
        _stratChart.candleSeries.setMarkers(markers);
        _stratChart.main.timeScale().fitContent();
      }
      if (_stratChart.equitySeries) {
        _stratChart.equitySeries.setData(equityPts);
        if (_stratChart.sub) _stratChart.sub.timeScale().fitContent();
      }
    } catch (e) {
      bt.textContent = "error";
      body.innerHTML = `<tr><td colspan="10" class="muted">error: ${escapeHTML(e.message)}</td></tr>`;
    }
  }

  async function generateStrategyWithAI() {
    const prompt = $("#strat-ai-prompt").value.trim();
    if (!prompt) { toast("describe what you want", true); return; }
    const stateEl = $("#strat-ai-state");
    const outEl = $("#strat-ai-out");
    stateEl.textContent = "generating...";
    outEl.textContent = "";

    const system = `You are a quant strategy generator. Given a natural-language request, return ONE JSON object and NOTHING else. Schema:
{
  "name": string,
  "rules": [
    { "indicator": one of ${JSON.stringify(INDICATORS)},
      "op": one of ${JSON.stringify(OPS)},
      "value": number as string OR one of ${JSON.stringify(INDICATORS)},
      "action": one of ${JSON.stringify(ACTIONS)} }
  ]
}
Only output the JSON. No prose, no markdown, no code fences.`;
    const full = `${system}\n\nREQUEST: ${prompt}`;

    try {
      const start = await api("/chat", {
        method: "POST",
        body: JSON.stringify({ message: full, history: [] }),
      });
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        await sleep(2000);
        const job = await api(`/chat/status/${start.job_id}`);
        if (job.status === "completed") {
          const reply = (job.reply || "").trim();
          outEl.textContent = reply;
          outEl.hidden = false;
          const parsed = extractJson(reply);
          if (parsed && Array.isArray(parsed.rules)) {
            state.strategy.name = parsed.name || state.strategy.name;
            state.strategy.rules = parsed.rules.map((r) => ({
              indicator: r.indicator, op: r.op, value: String(r.value), action: r.action,
            }));
            $("#strat-name").value = state.strategy.name || "";
            renderStrategyRules();
            stateEl.textContent = `loaded ${parsed.rules.length} rules`;
            toast("Strategy generated");
          } else {
            stateEl.textContent = "parse failed — see output";
          }
          return;
        }
        if (job.status === "failed") {
          stateEl.textContent = "ai failed";
          outEl.textContent = job.error || "error";
          return;
        }
      }
      stateEl.textContent = "timeout";
    } catch (e) {
      stateEl.textContent = "error";
      outEl.textContent = e.message;
    }
  }

  function extractJson(text) {
    if (!text) return null;
    // Strip markdown fences if any
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const raw = fence ? fence[1] : text;
    // Find first { and matching last }
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first < 0 || last < 0) return null;
    try { return JSON.parse(raw.slice(first, last + 1)); }
    catch { return null; }
  }

  // ── Settings ──
  function mountSettings() {
    $("#settings-key").value = state.apiKey;
    $("#about-api").textContent = API_BASE;
    $('[data-action="save-key"]').onclick = async () => {
      const k = $("#settings-key").value.trim();
      if (!k) return;
      const prev = state.apiKey;
      state.apiKey = k;
      try {
        await api("/status");
        localStorage.setItem("janus_api_key", k);
        $("#settings-status").textContent = "OK — reconnected.";
        toast("API key saved");
        refreshStatus();
        openWs();
      } catch (e) {
        state.apiKey = prev;
        $("#settings-status").textContent = "Invalid: " + e.message;
      }
    };
    $('[data-action="clear-key"]').onclick = () => {
      localStorage.removeItem("janus_api_key");
      state.apiKey = "";
      closeWs();
      showLogin();
    };
    $$("#accents button").forEach((b) => {
      b.onclick = () => applyAccent(b.dataset.accent);
    });
  }

  function applyAccent(name) {
    const a = ACCENTS[name] || ACCENTS.lime;
    const r = document.documentElement.style;
    r.setProperty("--neon", a.neon);
    r.setProperty("--neon-glow", a.glow);
    r.setProperty("--neon-soft", a.soft);
    r.setProperty("--border-hot", a.neon.replace(")", ", 0.35)").replace("rgb", "rgba")); // best-effort
    localStorage.setItem("janus_accent", name);
    state.accent = name;
  }

  // ── Data loop ──
  async function refreshStatus() {
    try {
      state.status = await api("/status");
      if (state.view === "dash") paintDashboard();
      if (state.view === "watch") paintWatchlist();
      setConnPill(true);
    } catch (e) {
      setConnPill(false);
    }
  }

  async function refreshPrices() {
    try {
      const d = await api("/prices");
      state.prices = d.prices || {};
      if (state.view === "dash") paintDashboard();
      paintTicker();
    } catch {}
  }

  async function refreshRegime() {
    try {
      const d = await api("/market-regime");
      state.regime = d.regime || "—";
      $("#regime-val").textContent = state.regime;
    } catch {}
  }

  function setConnPill(ok) {
    const pill = $("#conn-pill");
    pill.classList.toggle("ok", ok);
    pill.querySelector("span:last-child").textContent = ok ? "ONLINE" : "OFFLINE";
  }

  function paintTicker() {
    const t = $("#ticker");
    if (!t) return;
    const syms = Object.keys(state.prices);
    if (!syms.length) { t.textContent = ""; return; }
    const prev = paintTicker._prev || {};
    const segs = syms.map((s) => {
      const p = state.prices[s];
      const diff = prev[s] != null ? p - prev[s] : 0;
      const cls = diff > 0 ? "up" : diff < 0 ? "down" : "";
      const arrow = diff > 0 ? "▲" : diff < 0 ? "▼" : "·";
      return `<span class="sym">${escapeHTML(s)}</span><span class="${cls}">${fmt.num(p)} ${arrow}</span>`;
    }).join("  ");
    t.innerHTML = `<span class="ticker-track">${segs}   ${segs}</span>`;
    paintTicker._prev = { ...state.prices };
  }

  function tickClock() {
    const el = $("#clock");
    if (!el) return;
    const d = new Date();
    el.textContent = d.toLocaleTimeString("en-GB");
  }

  function stopPollers() {
    state.pollers.forEach(clearInterval);
    state.pollers = [];
    closeWs();
  }

  function startPollers() {
    stopPollers();
    state.pollers.push(setInterval(refreshStatus, 15000));
    state.pollers.push(setInterval(refreshPrices, 5000));
    state.pollers.push(setInterval(refreshRegime, 60000));
    state.pollers.push(setInterval(tickClock, 1000));
  }

  // ── Init ──
  async function init() {
    applyAccent(state.accent);
    buildNav();
    renderView();
    tickClock();
    await Promise.all([refreshStatus(), refreshPrices(), refreshRegime()]);
    startPollers();
  }

  function escapeHTML(s) {
    if (s == null) return "";
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // boot
  if (state.apiKey) {
    showApp();
    init().catch((e) => showLogin("Startup failed: " + e.message));
  } else {
    showLogin();
  }
})();
