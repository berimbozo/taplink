# 🥋 BJJ Reviews Widget

A free, self-hosted Google Reviews widget built specifically for martial arts gym owners. Display your best Google reviews on your website with full control over appearance — no monthly subscription, no third-party widget fees.

**Built by a gym owner, for gym owners.**

![Node.js](https://img.shields.io/badge/Node.js-18+-green) ![Railway](https://img.shields.io/badge/Hosted%20on-Railway-blueviolet) ![License](https://img.shields.io/badge/License-MIT-blue)

---

## ✨ Features

- **Live Google Reviews** — pulls directly from your Google Business listing
- **Admin Portal** — a private dashboard to manage everything
- **Pin reviews** — manually choose which reviews are always shown
- **AI-powered selection** — uses Claude AI to automatically pick the reviews most likely to convert visitors into leads
- **Full appearance control** — colors, fonts, layout, star ratings, reviewer photos
- **Responsive** — carousel on mobile, grid or list on desktop
- **CTA button** — add a "Book Your Free Trial" button directly on the widget
- **One embed snippet** — paste one `<script>` tag into GymDesk (or any website) and you're done

---

## 🏗️ How It Works

The project has three parts:

```
┌─────────────────────┐     ┌──────────────────────┐     ┌────────────────┐
│   Admin Portal      │────▶│  Backend API          │────▶│  Your Website  │
│   (React app)       │     │  (Node.js / Railway)  │     │  (GymDesk etc) │
│   Manage reviews,   │     │  Google Places API    │     │  <script> tag  │
│   tweak appearance  │     │  Postgres DB          │     │  widget.js     │
└─────────────────────┘     │  Claude AI            │     └────────────────┘
                            └──────────────────────┘
```

---

## 🚀 Setup Guide

### What you'll need before starting

- A [Railway](https://railway.app) account (free tier works)
- A [Google Cloud](https://console.cloud.google.com) account (free tier works)
- An [Anthropic](https://console.anthropic.com) account for AI picks (~$0.01 per use)
- Node.js 18+ installed locally (for the admin portal)
- Basic comfort with a terminal / command line

**Time to set up: ~30–45 minutes the first time**

---

### Step 1 — Get your Google Places API Key

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a new project (e.g. `reviews-widget`)
2. Go to **APIs & Services → Library** and enable:
   - **Places API**
   - **Places API (New)**
3. Go to **APIs & Services → Credentials → Create Credentials → API Key**
4. Click **Edit** on your new key:
   - Under *API restrictions* → restrict to **Places API**
   - Under *Application restrictions* → add your Railway domain once deployed
5. Copy your API key — you'll need it shortly

> 💡 **Find your Place ID:** Go to the [Place ID Finder](https://developers.google.com/maps/documentation/javascript/examples/places-placeid-finder), search your gym name, and copy the ID (looks like `ChIJN1t_tDeuEmsR...`)

---

### Step 2 — Get your Anthropic API Key

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Sign up / log in and go to **API Keys → Create Key**
3. Copy the key — it starts with `sk-ant-...`

> 💡 The AI pick feature costs roughly $0.01 each time you run it. You're only charged when you click the button.

---

### Step 3 — Deploy the Backend to Railway

1. Fork or clone this repo to your GitHub account
2. Go to [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo**
3. Select your forked repo
4. In your Railway project, click **+ New** → **Database** → **Add PostgreSQL**
5. Go to your **backend service → Variables** and manually add `DATABASE_URL` using the internal URL from your Postgres service:
   - Click your **Postgres service** → **Variables** → copy the value of `DATABASE_URL`
   - Go back to your **backend service** → **Variables** → add `DATABASE_URL` with that value
   - Railway's auto-injection can silently fail — manually setting it ensures it works

   > ⚠️ If the app starts but immediately exits with `ECONNREFUSED ::1:5432`, `DATABASE_URL` is not reaching the app. Follow the step above to set it manually.

6. While in your backend service Variables, also add the following:

| Variable | Value |
|---|---|
| `GOOGLE_PLACES_API_KEY` | Your Google API key from Step 1 |
| `GOOGLE_PLACE_ID` | Your gym's Place ID |
| `ANTHROPIC_API_KEY` | Your Anthropic key from Step 2 |
| `ADMIN_API_KEY` | **Make up a strong secret password** (e.g. run `openssl rand -hex 32` in your terminal) |
| `API_BASE_URL` | Your Railway public URL (e.g. `https://your-app.up.railway.app`) — set after first deploy |

7. Railway will auto-detect Node.js and deploy. Check the **Logs** tab — you should see:
   ```
   ✅ Database tables ready
   🚀 Reviews Widget API running on port 3000
   ```

---

### Step 4 — Set Up the Admin Portal

The admin portal is a React app. You can deploy it as a second Railway service or host it locally.

**Option A: Deploy to Railway (recommended)**

1. In your Railway project → **+ New → GitHub Repo** → select the same repo, but set the **Root Directory** to `/admin`
2. Set build command: `npm run build`
3. Set start command: `npx serve dist`
4. Add environment variables:
   - `VITE_API_BASE_URL` = your backend Railway URL
   - `VITE_ADMIN_API_KEY` = the same `ADMIN_API_KEY` you set on the backend

**Option B: Run locally (simpler for personal use)**

```bash
cd admin
cp .env.example .env.local
# Edit .env.local with your API URL and admin key
npm install
npm run dev
# Open http://localhost:5173
```

---

### Step 5 — Embed on Your Website

1. Open your admin portal and go to the **Embed** tab
2. Copy the snippet — it looks like this:

```html
<!-- Google Reviews Widget -->
<div id="reviews-widget"></div>
<script src="https://your-app.up.railway.app/widget.js"></script>
```

3. In **GymDesk**, the two parts of the snippet go in different places:
   - **`<script src="…/widget.js">`** → **Website → Settings → Body Tags** — paste it here once. It loads the widget script for your whole site.
   - **`<div id="reviews-widget"></div>`** → open the specific page in the editor → add a **Custom HTML** block → paste just this div wherever you want the reviews to appear.
4. Save and publish.

> The widget will automatically use whatever settings you've saved in the admin portal. No need to re-embed when you change the appearance.

> **GymDesk tip — Section Heading:** The admin portal has a built-in "Section Title" toggle (e.g. "What Our Members Say"), but on GymDesk the widget's heading won't match your site's native font and style. The better approach is to **leave the portal's section title off** and instead add an `<h1>` or heading block directly above the Custom HTML block in GymDesk's page editor. That way the heading inherits your site's typography automatically.

---

## 📁 Project Structure

```
bjj-reviews-widget/
├── server.js          # Express backend (Railway)
├── package.json
├── .env.example       # Environment variable reference
└── admin/             # React admin portal
    ├── src/
    │   └── App.jsx    # Main portal UI
    ├── package.json
    └── .env.example
```

---

## 🔧 Environment Variables Reference

| Variable | Where | Description |
|---|---|---|
| `GOOGLE_PLACES_API_KEY` | Backend | Google Cloud API key |
| `GOOGLE_PLACE_ID` | Backend | Your gym's Google Place ID |
| `ANTHROPIC_API_KEY` | Backend | Claude AI API key |
| `ADMIN_API_KEY` | Backend + Portal | Shared secret to protect admin routes |
| `API_BASE_URL` | Backend | Your Railway backend public URL |
| `ADMIN_PORTAL_URL` | Backend | Your portal URL (for CORS) |
| `DATABASE_URL` | Backend | Set manually — copy from Railway Postgres service Variables (auto-injection can silently fail) |
| `VITE_API_BASE_URL` | Portal | Points to your backend |
| `VITE_ADMIN_API_KEY` | Portal | Same as backend `ADMIN_API_KEY` |

---

## ⚠️ Known Limitations

- **Google Places API returns a maximum of 5 reviews** for free. This is a Google limitation — not something we can work around without a paid third-party data provider.
- The AI pick feature requires an Anthropic API key and costs a small amount per use (~$0.01).
- This is a v1 — it works great but has no built-in user authentication beyond the admin key. Keep your `ADMIN_API_KEY` private and don't share the portal URL publicly.

---

## 🗺️ Roadmap / Future Ideas

- [ ] Support for multiple locations / Place IDs
- [ ] Auto-refresh reviews on a schedule (cron job)
- [ ] Email alert when a new review comes in
- [ ] More widget themes and layout options
- [ ] Password-protected admin login UI
- [ ] Export reviews to CSV

PRs welcome! If you're a gym owner who uses this and wants a feature, open an issue.

---

## 🙏 Contributing

This project was built by a BJJ gym owner for the community. If you find it useful, consider:
- ⭐ Starring the repo
- 🐛 Opening issues for bugs or ideas
- 🔀 Submitting a PR if you're technical

---

## 📄 License

MIT — free to use, modify, and share.