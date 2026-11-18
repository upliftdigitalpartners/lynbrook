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

## Not in Doorstep yet

- **AI features** (Ask, scan a bill, recap) need a `GROQ_API_KEY` secret on the Doorstep Supabase project.
- **Push reminders** need their own VAPID keys plus the `send-reminders` function and its schedule.
- **Gmail bill import and the setup guide** are hidden, because the importer is tuned to Evergreen's utilities.
- **Switching between properties** isn't available yet; the app opens the first one.
