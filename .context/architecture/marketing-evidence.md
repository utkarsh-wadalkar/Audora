# Marketing evidence and feedback

Audora's production website is `https://audora-download.vercel.app`. Vercel
builds the `marketing/` static Next.js export from `main`. The desktop app and
marketing runtime remain independent.

## Evidence sources

- Vercel Web Analytics records privacy-focused page traffic for the private
  owner dashboard.
- Supabase project `Audora Web` stores one random browser identifier with first
  and last-seen timestamps. The public proof panel reads aggregate first-visit
  counts for this month, last month, lifetime, and the latest 14 calendar days.
  It never exposes a browser identifier or converts website clicks into
  download claims.
- GitHub's public releases API is the source for completed release-asset download
  counts. Website click events are not presented as completed downloads.
- Only consented, manually published feedback is rendered as a testimonial.

## Data boundary

`supabase/migrations/20260908081119_audora_web_evidence.sql` owns three tables:

- `site_visitors`: anonymous identifiers and timestamps; no name, email, or IP;
- `site_metrics`: the single public aggregate row;
- `feedback_submissions`: private email, rating, message, consent, and moderation
  status.

RLS is enabled on every table. Browser calls use only the Supabase publishable
key and read the single aggregate row. A non-callable trigger function in the
unexposed `private` schema refreshes its counts and 14-day series whenever
visitor or feedback data changes. No Supabase secret key is present in source
or the browser.

## Review workflow

Feedback begins as `pending`. In Supabase Studio, change `status` to `published`
only when `consent_to_publish` is true. The publication timestamp and public
review count update automatically. Use `rejected` to keep a submission private
without deleting it. A real review can also be added through Table Editor with
the listener's permission; the same consent and publication rules apply.

## Runtime configuration

Vercel Production defines `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. These are intentionally browser-safe.
Never add `sb_secret_*`, a service-role key, a database password, or private
feedback to this context directory.

The feedback form stores the submission in Supabase and sends it to
`utkarshwadalkarg6genai@gmail.com` through FormSubmit. FormSubmit's one-time
mailbox activation remains associated with that address.
