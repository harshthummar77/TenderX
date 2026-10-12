# Static assets

Files here are served from the site root (`/`).

Drop these two in this folder — the landing page and app loader reference them:

- `logo.jpeg` — header/footer logo (shown at `/logo.jpeg`)
- `loader.png` — app boot loader (shown at `/loader.png`)

Both degrade gracefully if missing (logo falls back to the "TenderX" wordmark;
the loader falls back to the spinner), so the build never breaks on their absence.
