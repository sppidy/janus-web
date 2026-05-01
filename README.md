# aitrader-web

Web dashboard for the Janus. Part of [`janus`](https://github.com/sppidy/janus).

- Vanilla JavaScript, **no build step**
- TradingView `lightweight-charts` vendored locally
- JetBrains Mono via Google Fonts
- Talks to `nse-backend` over HTTP + WebSocket (`/ws/logs`)

## Files

```
index.html           # Shell + nav + per-view templates
app.js               # All view logic + WebSocket subscription
styles.css           # NEON palette (dark grid + lime accent)
lightweight-charts.js  # Vendored chart lib
```

## Run

This bundle is normally served by `nse-backend` at `https://<host>/dashboard` (the backend mounts this directory as static files).

For standalone local dev, just serve the directory with any static server:

```bash
python -m http.server 8000
# then open http://localhost:8000
```

…and configure the backend URL + API key in the Settings view.

## Views

Dashboard · Watchlist · Charts (candle + indicator toggles + RSI sub-pane) · Strategy (rule builder + client-side backtester + AI-generate via `/api/chat`) · Scanner · Agent chat · Logs (WebSocket live stream) · Settings.

## License

[Apache-2.0](LICENSE). Contributing guidelines and security policy live in the [super-repo](https://github.com/sppidy/janus).
