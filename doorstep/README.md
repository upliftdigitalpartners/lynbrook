# Doorstep

**Doorstep** is the public version of the app: rent, bills and repairs for any small landlord and their tenants.
It started as a copy of **Evergreen House** (the private app for 110 Evergreen Ave, in the repository root) and is now a separate product.

| | **Evergreen House** | **Doorstep** |
|---|---|---|
| Who it's for | One family, one house | Any landlord who signs up |
| Code | repository root | `doorstep/` |
| Web address | https://upliftdigitalpartners.github.io/lynbrook/ | https://upliftdigitalpartners.github.io/lynbrook/doorstep/ |
| Database (Supabase) | `evergreen-house` · `ssvjlktqvybybuopbmlu` | `doorstep` · `aprlmkajyotlsswjgvfv` |
| Sign-in | One shared family password | Email + password per person, or **Try the demo** |
| Look | Evergreen green | Doorstep blue, door icon |
| Saved-on-phone keys / offline cache | `eh-…` / `evergreen-…` | `ds-…` / `doorstep-…` |

The two never share users, data, storage keys or offline caches. Evergreen's service worker ignores `/doorstep/`.

## Demo

- **Try the demo** signs into `demo@doorstep.example` (password `doorstep-demo`, public on purpose).
- It holds a fictional property, *Maple Street Duplex* (2 units, 2 tenants, 12 months of bills, upkeep and personal subscriptions).
- `reset_demo()` rebuilds it from scratch every night at 09:17 UTC (pg_cron job `reset-demo`), including the password, so visitors can't break it.

## How people use it

1. **Landlord:** create an account, then *Set up your property* (name, address, units). Up to 5 properties per account.
2. **Co-owner or family:** create an account, then enter the house code from *Settings › Account*.
3. **Tenants:** no account; they open the private link from their tenant's Details (rent status, pay info, repair requests).

## Database

Doorstep's database = the shared migrations `supabase/migrations/001–010` + Doorstep's own:
- `doorstep/supabase/migrations/011_doorstep.sql` adds `create_household()` for self-service sign-up.
- `doorstep/supabase/migrations/012_demo.sql` adds the demo and its nightly reset.

Edge functions live in `doorstep/supabase/functions` (assist, scan-bill, tenant, weather) with prompts that aren't specific to Evergreen. Deploy from `doorstep/`:

```bash
npx supabase functions deploy assist scan-bill tenant weather --project-ref aprlmkajyotlsswjgvfv --use-api --no-verify-jwt
```

## Reminders, email import, properties

- **Push reminders:** Doorstep has its own VAPID keys (saved as Supabase secrets; the public key is in `config.js`). The `send-reminders` function runs hourly, and `weather` runs at 12:07 and 21:07 UTC (pg_cron + pg_net, with a `CRON_SECRET`).
- **Gmail import** works for any landlord. The Apps Script looks for emails that read like bills, statements or Zelle payments. `import-bill` matches them to bills by the bill's name in the sender or subject, by account number, or by the unit named in the email, and records Zelle rent.
- **Setup guide** (Settings): home screen, reminders, bills, pay info, tenants, mortgage, Zelle alerts, Gmail import, upkeep. It's hidden in the demo.
- **Several properties:** tap the address at the top to switch, or to add another (up to 5).

## Landing, tenants, privacy, limits

- **Landing page** for signed-out visitors: what Doorstep does, how it works, the tenant side, FAQ, Try the demo, and sign in / create account.
- **"I've paid" from tenants:** the tenant page lets them say they paid (amount, method, note). The landlord gets a push alert and a **Tenants say they paid** card on the Rent tab, where **Confirm** marks it received (`rent_notices`, migration 013).
- **Privacy policy and Terms:** `privacy.html` and `terms.html`, linked from the landing page, the sign-up form and Settings.
- **Your data** (Settings): **Download my data** (JSON) and **Delete my account**. Deleting removes your login and any property only you are in, with its files (`delete_my_account()`). Neither is offered in the demo.
- **Daily AI allowance:** 80 a day per person, and 25 a day shared by everyone in the demo (`ai_usage` + `bump_ai()`), enforced in `assist` and `scan-bill`.

## Still needed

- **AI features** (Ask, scan a bill, recap) need a `GROQ_API_KEY` secret on the Doorstep Supabase project: Project Settings › Edge Functions › Secrets. Use a separate Groq key from Evergreen's, so demo visitors can't use up Evergreen's limits.
- **Texting or emailing tenants automatically** needs a paid SMS or email service (for example Twilio or Resend).
- **A custom domain** and **online rent payments** (Stripe) need accounts in your name.
- Add a **contact email** to the Privacy and Terms pages, and have someone qualified review them before a public launch.
