# ArtSouthwest artist intake

The intake collects artist profiles, portraits and three to five available works. Artists can request a call, save a private draft and report changes after submitting. The review desk manages calls, corrections, image review and publication. The production catalog uses the read-only published feed.

## Live form

[Open the ArtSouthwest artist webform](https://artist.artsouthwest.com/?campaign=taos-artists).

The catalog lives at [artsouthwest.com](https://artsouthwest.com/) and the private staff desk at [curator.artsouthwest.com](https://curator.artsouthwest.com/). The three sites use Neon Postgres and private Object Storage behind the named Cloudflare tunnel on the Mac. Artists can start immediately, return in the same browser, or save a one-time private link. Email receipts and emailed sign-in links require a configured transactional sender.

## Local preview

Use Node.js 24 for deployment. The app also runs on Node.js 22.18 or later.

```sh
npm ci
cp .env.example .env
npm run dev
```

Open `http://127.0.0.1:4080`. Put a private password in `REVIEWER_PASSWORD` in your local `.env` to open `/review`. Use fictional records in preview. With SMTP unconfigured, transactional messages are written locally under `data/dev-mail/`. Open the resume URL in the corresponding local message. The preview does not send email.

React handles the multi-step form and reviewer interface. Vite builds the client. Express serves the client, API and private media on one origin. Without Neon settings, the local preview uses SQLite at `data/intake.sqlite` and a private disk for images. Use the Neon settings for integration testing.

## Artist and reviewer flows

- The invitation discloses the 20% platform sales commission before the artist starts. There is no submission fee. Seller agreements and checkout are separate.
- The artist enters email on the same page as the bio. The form checks its format at final submission. A private browser session lasts seven days. Profile and work changes save as the artist goes. Saves from a stale editor cannot overwrite a newer version.
- When email delivery is configured, artists can request a private link from **Manage submission**. That link works once and expires in 24 hours. Opening it lets the artist return from a second browser. A verified address can request a fresh link at `/resume`.
- Every photo must have at least 1,080 pixels on its longest side and fit within 12 MB and 52 megapixels. JPEG, PNG and WebP are supported. Export HEIC as JPEG for this release. Originals stay private. The app creates orientation-corrected JPEG previews with metadata removed.
- Artists grant website permission before they submit. The reviewer verifies artwork details, permissions, image credits, availability, seller authority and any cultural access restrictions before publication.
- A reviewer can request a correction, approve and publish a submitted version, or unpublish the profile. A correction appears in the artist’s submission and can be emailed to a verified address. Reporting a sold work removes it and its images from the public feed. Withdrawal removes the profile and its public media without waiting for a reviewer.
- Call requests are assigned to the configured owner. Set the queue to acknowledged, completed or closed as work is done. An artist’s call consent or submission never subscribes them to marketing.

The private desk shows last activity and upload history. An upload start without a later outcome can indicate interruption. A published artist can select **Update my profile or artwork** to send a new revision. The catalog keeps the existing published version until a reviewer publishes the revision. Final submission records the application state and queues one receipt when email delivery is configured. The email queue shows failed deliveries for retry with a stable Message-ID. A crash during delivery may still cause a provider to deliver an email more than once.

## Production setup

See the [artsouthwest.com deployment instructions](DEPLOYMENT.md) and [Render Blueprint](render.yaml).

Use one Node service behind a TLS proxy that serves the configured public origin. Keep the application port private to the proxy. Allow at least 12 MiB and 90 seconds for uploads. Configure `TRUST_PROXY_HOPS=1` if exactly one trusted reverse proxy sits in front. The [Dockerfile](Dockerfile) runs the service as a non-root user. The SQLite deployment uses one replica with the database and media on a mounted disk that supports local filesystem locks.

### Neon Postgres and Object Storage

The app uses Neon when `DATABASE_URL` is set. The Node server uses a Postgres connection pool and keeps originals and derivatives in the private `uploads` bucket declared in `neon.ts`. Set `NEON_MEDIA_BUCKET` if deploying to a different private bucket. The server checks draft or publication permission before serving an image.

Run `neon deploy` on the linked branch to provision services and pull `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `AWS_ENDPOINT_URL_S3`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY`. Apply the versioned schema using `npm run migrate:postgres`, then run `npm run build` and `npm start`. The migration uses the direct connection string. The app loads the ignored `.env` and `.env.local` files. Keep the database and storage credentials on the server.

The Neon schema command initializes tables. Use the [migration and verification runbook](DEPLOYMENT.md#move-the-live-sqlite-records-to-neon) to move existing records and images before switching the public origin. The backup and retention commands below operate on the SQLite data directory.

| Setting | Purpose |
|---|---|
| `NODE_ENV=production` | Enables production configuration checks. |
| `PUBLIC_URL` | Exact HTTPS origin for the form, cookie protection and private links. |
| `DATA_DIR` | Mounted private directory. Use `/app/data` in the container. |
| `REVIEWER_PASSWORD` | High-entropy secret, at least 24 characters, for the pilot reviewer account. Store outside Git. |
| `REVIEWER_ID`, `CALLBACK_OWNER` | Names used in the internal audit and callback queue. Staff coverage belongs to the project team. |
| `SMTP_URL`, `MAIL_FROM`, `REPLY_TO` | Transactional mail transport, verified sender and monitored replies. Use an authenticated transactional sender. |
| `MAIL_QUEUE_KEY` | 32 random bytes as 64 hexadecimal characters. Keep it stable across deploys and preserve it securely for restore. |

Set secrets through your host. Generate a random queue key with `openssl rand -hex 32`. Start the process after building. The app exposes `/api/health`. Test one fictional submission and real mailbox delivery, including resume and receipt, before sending the campaign. The Mailchimp button points to `https://artist.artsouthwest.com/?campaign=taos-artists`. Send the invitation only to contacts with documented permission. No campaign sending is built into the form.

Production config checks provide a guard against using the local email spool accidentally. Test that asset access and email work on the selected host before moving to real artist data. The live deployment uses artsouthwest.com. Configure the sender on the server before enabling transactional email. [SQLite single-host guidance](https://www.sqlite.org/whentouse.html) · [Mailchimp permission guidance](https://mailchimp.com/help/the-importance-of-permission/).

### Catalog feed

Read `GET /api/catalog` for a versioned JSON object with `version: 1` and an `artists` array. Each published artist has a stable slug and linked work objects. Prices use minor units and an explicit currency. Media `src` values are paths on the intake origin. The public feed and approved media can be read from another website. Keep time-to-live short or revalidate on each read so sales and withdrawals take effect. The published view contains no draft data, internal notes, private contact details, original uploads or permission evidence. Treat the published fields as text in the catalog renderer.

### Backups and retention

- Run `npm run backup -- backups/2026-11-23` to create a fresh database snapshot and copy its referenced media. An existing backup directory can’t be overwritten. Run before retention, and keep encrypted backups on private storage outside the running volume. Use a 30-day backup rotation for the pilot. Preserve the production mail queue key separately from the backup.
- To restore, stop the service, place the verified snapshot and `media/` into a fresh private data directory, configure the original mail key, and switch the mount. Restore with outbound mail paused or redirected until you reconcile queued messages against delivery records. Check a published derivative and a private submission before reopening. Test restores using fictional data.
- `npm run retention` reports eligible records. Run `npm run retention -- --apply` nightly after backup to expire inactive drafts and withdrawn records after 30 days, completed or closed callbacks and sent mail records after 90 days, expired tokens and old rate counters. It also removes unregistered files older than one day and local preview mail older than seven days. Submitted or published records stay active until the team withdraws them. The operator handles deletion requests and backup expiry. Review older open call requests and drafts in the desk.

Restrict the volume, backups and secret access to the operator. Do not copy artist submissions, invitation exports, SMTP settings, drafts or database files into source control.

## Verification

```sh
npm run build
npm test
npm run test:browser
```

The API tests start a loopback server and use fictional records and a simulated mailer. They verify the 1,080-pixel threshold, resume links, stale edits, media access, duplicate callbacks and receipts, editorial publication, sold and withdrawn records, mail retry, backup and restore, and retention. Browser tests use local Chrome and a private test email spool. They cover desktop callback handling and an iPhone-sized submission and resume. If using Playwright’s bundled Chromium, install it and set `PLAYWRIGHT_USE_BUNDLED=1` for the browser test. Browser tests require the prior build.

The Adobe Door photograph depicts a fictional studio.
