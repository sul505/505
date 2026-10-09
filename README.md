# 💧 Drop to Ocean

**Start as a single drop of water and grow into an entire ocean.**

Drop to Ocean is an idle/incremental clicker game. Click the drop, buy generators that collect water for you,
unlock upgrades, and grow through 8 stages: **Droplet → Puddle → Pond → Lake → River → Sea → Ocean → Blue Planet**.
When the run slows down, **Evaporate** to earn Clouds and start again even stronger.

The whole game is a single HTML file (`game/index.html`) with no build step and no dependencies,
so it runs in any browser, on mobile, and as a desktop app.

## Features

- **12 generators**, from a Dew Collector to an Ice Comet, unlocked stage by stage
- **73 upgrades**: click upgrades, production upgrades, and 5 tiers for every generator
- **8 stages**, each with its own colors, flavor text and production bonus (+25% per stage)
- **Golden drops** that appear at random: Lucky Splash, Flood (x7 production) or Whirlpool (x77 clicks)
- **Prestige (Evaporate)**: earn Clouds for +2% production each, and spend them on 8 permanent Cloud upgrades
- **64 achievements**, each giving +1% production, including a secret one
- **Offline progress** (up to 8 hours), autosave every 10 seconds, and save export/import
- Sound effects made in code (no audio files), with a mute button
- Works on desktop and phones (touch-friendly)

**Pacing (simulated):** the first Ocean takes about 3 hours of play. After one Evaporate, the next Ocean takes about 1 hour.
Golden drops make a real player faster than the simulation.

## Play it locally

Open `game/index.html` in any browser. That's it.

## Publish it

### 1. itch.io (free, best first step)

1. Zip the **contents** of the `game` folder (`npm run zip-web`, or zip `index.html` + `icon.svg` by hand).
2. On itch.io: **Upload new project** → Kind of project: **HTML** → upload the zip → tick **"This file will be played in the browser"**.
3. Viewport: **1280 × 800**. Turn on **Mobile friendly** and **Fullscreen button**.
4. Set a price, or set it free with "pay what you want" donations.

### 2. Web game portals (ad revenue)

[CrazyGames](https://developer.crazygames.com/) and [Poki](https://developers.poki.com/) accept HTML5 games and share ad revenue.
Upload the same zip. They may ask you to add their SDK for ads (for example a rewarded ad that doubles a golden drop).

### 3. Steam / desktop

```bash
npm install          # installs Electron and electron-builder
npm start            # run the desktop version
npm run dist         # build into the dist/ folder
```

- On Windows, `npm run dist` makes `dist/win-unpacked` (upload this folder to Steam) and a portable `.exe`.
- On Linux it makes `dist/linux-unpacked` and an AppImage. Build on a Mac for a macOS version.
- Steam needs a Steamworks account ($100 per game), store page art (capsules, screenshots, trailer) and a review.
  Open the store page early to collect wishlists.
- Press **F11** for fullscreen in the desktop version.

### 4. Your own website / GitHub Pages

Upload the `game` folder to any static host and share the link.

## Make it yours

Everything is in `game/index.html`, near the top of the script:

| What | Where |
|---|---|
| Game name | `<title>`, the `.logo` text, and the intro modal |
| Stages, colors, flavor text | `STAGES`, `TICKER` |
| Generators (cost, production) | `GENS` |
| Upgrades | `UPS`, `TIER_OWN`, `TIER_COST` |
| Prestige upgrades | `CLOUD_UPS` |
| Achievements | `ACH` |
| Prestige formula | `cloudGain` |

Saves are stored in the browser under the key `dropToOcean_save_v1`. Change it if you make big changes that break old saves.

## Ideas for v1.1

- Steam achievements and cloud saves (with [steamworks.js](https://github.com/ceifa/steamworks.js))
- Background music
- A second prestige layer (Rain → Clouds → Storms)
- Rewarded ads on web portals: "watch an ad for 2x production for 5 minutes"
