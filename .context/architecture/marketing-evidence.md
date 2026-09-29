# Marketing evidence and feedback

Audora's production website is `https://audora-download.vercel.app`. Vercel
builds the `marketing/` static Next.js export from `main`. The desktop app and
marketing runtime remain independent.

## Evidence sources

- Vercel Web Analytics records privacy-focused page traffic for the private
  owner dashboard.
- TiDB Cloud project `Audora-Web` stores one random browser identifier with first
  and last-seen timestamps. The public proof panel reads aggregate first-visit
  counts for this month, last month, lifetime, and the latest 14 calendar days.
  It never exposes a browser identifier or converts website clicks into
  download claims.
- GitHub's public releases API is the source for completed release-asset download
  counts. Website click events are not presented as completed downloads.
- Only consented, manually published feedback is rendered as a testimonial.

## Data boundary

`marketing/tidb/schema.sql` owns two TiDB tables:

- `site_visitors`: anonymous identifiers and timestamps; no name, email, or IP;
- `feedback_submissions`: private email, rating, message, consent, and moderation
  status.

The TiDB URL is server-only. Browser code calls Next.js route handlers, which
use parameterized TiDB queries and never expose database credentials.

## Review workflow

Feedback begins as `pending`. Run `marketing/tidb/review-consented.sql` in TiDB
Cloud SQL Editor to review the consented queue. Publish only selected IDs with
the explicit `UPDATE` shown in that file; the frontend displays those rows on
its next evidence refresh. Leave unselected rows pending or mark them rejected.

## Runtime configuration

Vercel Production defines the server-only `TIDB_DATABASE_URL`. Never add a
database password or private feedback to this context directory.

The feedback form stores submissions only in TiDB. It does not send feedback by
email.
