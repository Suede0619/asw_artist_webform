# Southwest Arts artist intake

The intake collects artist profiles, portraits and three to five available works. Artists can request a call, save a private draft, resume by email and report changes after submitting. The review desk manages calls, corrections, image review and publication. The future catalog can use the read-only published feed.

## Local preview

Use Node.js 24 for deployment. The app also runs on Node.js 22.18 or later.

```sh
npm ci
cp .env.example .env
npm run dev
```

Open `http://127.0.0.1:4080`. Put a private password in `REVIEWER_PASSWORD` in your local `.env` to open `/review`. Use fictional records in preview. With SMTP unconfigured, transactional messages are written locally under `data/dev-mail/`. Open the resume URL in the corresponding local message. The preview does not send email.

React handles the multi-step form and reviewer interface. Vite builds the client. Express serves the client, API and private media on one origin. Node’s SQLite library creates and migrates `data/intake.sqlite` on startup. Originals, previews and the database live on the same private disk. There is no separate database account or import step.

## Artist and reviewer flows

- The invitation discloses the 20% platform sales commission before the artist starts. There is no submission fee. Seller agreements and checkout are separate.
- Email verifies access before the artist can edit. A resume link expires in 24 hours and works once. Artists can request a new link. The browser can keep a session for seven days. Profile and work changes save as the artist goes. Saves from a stale editor cannot overwrite a newer version.
- Every photo must have at least 1,080 pixels on its longest side and fit within 12 MB and 52 megapixels. JPEG, PNG and WebP are supported. Export HEIC as JPEG for this release. Originals stay private. The app creates orientation-corrected JPEG previews with metadata removed.
- The reviewer verifies artwork details, permissions, image credits, availability, seller authority and any cultural access restrictions. An artist can submit with website permission unchecked. That submission needs a correction and opt-in before publication.
- A reviewer can send a correction request with a private link, approve and publish a submitted version, or unpublish the profile. Reporting a sold work removes it and its images from the public feed. Withdrawal removes the profile and its public media without waiting for a reviewer.
- Call requests are assigned to the configured owner. Set the queue to acknowledged, completed or closed as work is done. An artist’s call consent or submission never subscribes them to marketing.

The private desk shows last activity and upload history. An upload start without a later outcome can indicate interruption. The email queue shows failed deliveries and supports retries. A successful save or final submission records one application state and one receipt job. SMTP is retried and uses a stable Message-ID. A crash during delivery may still cause a provider to deliver an email more than once.

## Production setup

See the [artsouthwest.com deployment instructions](DEPLOYMENT.md) and [Render Blueprint](render.yaml).

Use one Node service with a durable, private, local disk volume. The [Dockerfile](Dockerfile) runs the service as a non-root user. Use a single replica and keep the SQLite database and media on the same mounted disk. Use a TLS proxy that serves only the configured public origin. Keep the application port private to the proxy. Set the proxy body limit to at least 12 MiB and allow 90 seconds for uploads. Configure `TRUST_PROXY_HOPS=1` only if exactly one trusted reverse proxy sits in front. Use a host volume service that supports local filesystem locks. A multi-instance design would need a shared database, object storage and distributed job processing.

| Setting | Purpose |
|---|---|
| `NODE_ENV=production` | Enables production configuration checks. |
| `PUBLIC_URL` | Exact HTTPS origin for the form, cookie protection and private links. |
| `DATA_DIR` | Mounted private directory. Use `/app/data` in the container. |
| `REVIEWER_PASSWORD` | High-entropy secret, at least 24 characters, for the pilot reviewer account. Store outside Git. |
| `REVIEWER_ID`, `CALLBACK_OWNER` | Names used in the internal audit and callback queue. Staff coverage belongs to the project team. |
| `SMTP_URL`, `MAIL_FROM`, `REPLY_TO` | Transactional mail transport, verified sender and monitored replies. Use an authenticated transactional sender. |
| `MAIL_QUEUE_KEY` | 32 random bytes as 64 hexadecimal characters. Keep it stable across deploys and preserve it securely for restore. |

Set secrets through your host. Generate a random queue key with `openssl rand -hex 32`. Start the process after building. The app exposes `/api/health`. Test one fictional submission and real mailbox delivery, including resume and receipt, before sending the campaign. The Mailchimp CTA points to the form origin with `/?campaign=taos-artists`. Send the invitation only to contacts with documented permission. No campaign sending is built into the form.

Production config checks provide a guard against using the local email spool accidentally. Test that asset access and email work on the selected host before moving to real artist data. This repository supplies the app and deployment instructions. It has no production domain, SMTP credentials or live checkout. [SQLite single-host guidance](https://www.sqlite.org/whentouse.html) · [Mailchimp permission guidance](https://mailchimp.com/help/the-importance-of-permission/).

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

The Threshold logo and Studio Light photograph are generated campaign assets. The photograph depicts a fictional studio.
