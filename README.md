# Evergreen House

A rent, bill and home-upkeep tracker for a two-family house, built as an installable web app (PWA).

- **App:** https://upliftdigitalpartners.github.io/lynbrook/
- **Hosting:** GitHub Pages (static files in this repo, no build step)
- **Backend:** Supabase: database, sign-in, photo storage and a reminder function

## What it does
- Monthly list of bills with one-tap “paid”, amount and due day per month
- Floors (whole house / 1st / 2nd) and categories, with filters and totals
- Bill details: account #, autopay, payment website, notes, payment method, confirmation #, bill photo or receipt
- Rent: tenants per floor, rent received (full or partial), grace period and late status, lease end alerts, text/call the tenant
- Upkeep: recurring maintenance tasks that reschedule themselves when marked done, one-off repair log with costs and contractors
- Summary: rent in vs. bills + upkeep out, net per month, bills by floor and category
- Push reminders for bills, late rent and upcoming upkeep
- Add all due dates to your phone calendar (.ics) and export history (CSV)
- Works offline: changes made offline sync when you’re back online
- Installs to the Home Screen on iPhone and Android

## Privacy
This repo is public, so it holds **no personal data**. Account numbers, amounts and photos live only in Supabase,
behind row-level security: only signed-in members of a household can read or change its data.
`config.js` contains only the Supabase URL, the anon key and the push public key, which are all meant to be public.

## Layout
| Path | What |
|---|---|
| `index.html`, `styles.css`, `app.js` | The app |
| `config.js` | Public Supabase / push settings |
| `sw.js` | Service worker: offline cache and push notifications |
| `manifest.webmanifest`, `icons/` | Install metadata and icons |
| `vendor/` | Supabase JS client (v2.45.4), bundled so the app works offline |
| `supabase/migrations/` | Database schema and security rules (`001` bills, `002` rent & upkeep) |
| `supabase/functions/send-reminders/` | Edge function that sends reminders; run hourly by `pg_cron` |

## Getting in
The family shares one **house password**. Open the app and enter it; each device stays signed in.
Change it under **Settings → Family password**. Behind the scenes it signs in to one shared
Supabase account (`HOUSE_EMAIL` in `config.js`); new sign-ups are turned off in Supabase.

## Changing the app
Edit the files and push. GitHub Pages redeploys automatically.
When you change any cached file, bump `VERSION` in `sw.js` so phones pick up the update.
