# ArtSouthwest deployment

| Website | Live address |
|---|---|
| Public catalog and Taos day planner | [artsouthwest.com](https://artsouthwest.com/) |
| Artist invitation, intake and revisions | [artist.artsouthwest.com](https://artist.artsouthwest.com/?campaign=taos-artists) |
| Password-protected staff desk | [curator.artsouthwest.com](https://curator.artsouthwest.com/) |

Three DNS-only CNAME records in Cloudflare route to the Render service. Render manages their TLS certificates. Host-based route checks protect the artist and staff APIs. Artist and staff session cookies belong to their own hosts. The original campaign address redirects to the current invitation. An existing artist who opens the old form URL in the original browser can transfer a valid session once with a short-lived private link. The Render service reads and writes directly to Neon Postgres and private Object Storage.

## Verify a submission

1. Submit a fictional artist profile, portrait and three available works through a test origin linked to a Neon test branch. Save the receipt reference.
2. Open the staff desk, sign in, choose **Submissions**, and search by reference. The desk shows which storage backend it is using and counts stored photos.
3. Open the submission. Confirm the profile, availability, prices, portrait, artwork previews and permissions. Click a preview to inspect it at a larger size.
4. To approve a real submission, confirm editorial and image clearance, record the reason and choose **Publish**. The catalog gets the approved artist and artworks from `GET /api/catalog` on its next read. Sold works and withdrawals come down through the artist’s update flow.
5. For a database check, open the correct project and branch in [Neon Console](https://console.neon.tech/). Open **Tables** under **Postgres database**. Inspect `applications` for the saved record and `assets` for the photo records. `publications` contains approved catalog snapshots. Use the staff desk to see photos. The original bytes and display previews live in the private `uploads` bucket in **Object Storage**.

Keep the reviewer password in a password manager and in the Render service’s `REVIEWER_PASSWORD` secret. Add individual staff identities before expanding access to the team. Use the review desk for routine work and restrict raw Neon Console access to operators.

## Artist access and the first campaign

Collectors browse without signing in. Artists can begin intake without an account or early email check. They can return in the original browser, or choose **Save a private link** in the submission receipt or **Manage submission**. A saved link works once, expires after 180 days and grants the same submission on another device. Artists can create a new link after redeeming one. Published artists can use the same form to submit a revision. The current version stays visible until staff approve the revision.

Use `https://artist.artsouthwest.com/?campaign=taos-artists` for the invitation button. Send a Mailchimp test to an internal address first and verify the destination on a phone. Automated receipt and sign-in email need a verified transactional sender. Later, verify the artist's email with a link after intake and use it for passwordless access.

## Move the live SQLite records to Neon

1. Keep the current tunnel connector and its DNS records. Verify the backup path and target branch. Confirm you can open the current staff desk and the public HTTPS form. Record the current origin command and process ID for recovery.
2. Apply the Postgres schema with `npm run migrate:postgres` using the direct database connection. Rehearse against a separate Neon branch with fictional data. Verify the private bucket, consent, publication and withdrawal.
3. Arrange a short read/write maintenance window. Stop the current origin and make a fresh private SQLite snapshot with `DATA_DIR=./data/callback-intake npm run backup -- backups/pre-neon-cutover`. Run `npm run import:sqlite -- backups/pre-neon-cutover` to check the snapshot and every referenced file locally.
4. Confirm you are using the expected Neon branch and server credentials. With the old origin stopped, run `DATA_DIR=./data/callback-intake npm run import:sqlite -- backups/pre-neon-cutover --apply`. The script retains record, session and asset IDs. It verifies both stored images for every asset and stops on conflicting rows or image bytes. The source stays intact. If the source uses a configured queue key, give the import and runtime that same key privately.
5. Build the catalog, set `CATALOG_DIR` to its output and start the new origin with `npm run start:domains`. Verify each hostname on loopback before pointing all three tunnel ingress routes at that origin. The service disables email links until SMTP is configured.
6. Verify HTTPS, the saved reference and its images, callback queue, anonymous access restrictions, and a new test draft against the live service. Smoke-test before reopening invitations. If verification fails before accepting new Neon writes, stop the new origin and restart the recorded SQLite origin. If Neon has received new writes, pause writes and reconcile those records before rolling back.

Build `production-release` in [the website repository](https://github.com/Suede0619/sw-arts-website). The apex renders browse pages on the server and refreshes its approved feed after a curator decision, a sale or a withdrawal. It serves fingerprinted catalog assets with long cache lifetimes. The old `/discover/` path redirects to the catalog home.

Venue photo references live in the catalog. The hosted build reads the corresponding WebP files from `media/venue-photos/` in the private Object Storage bucket and verifies their fingerprints. To remove a photo, remove its listing’s `image` field, pin the new catalog commit and deploy. Delete the released copy from Object Storage when it has no active references and remove any obsolete deployment from rollback circulation. Keep the source and permission record in the private archive.

## Always-on hosting

The live Render service is `artsouthwest-web` in Ohio. The [Blueprint](render.yaml) records its Node runtime, build and health check settings. A build pulls the catalog revision pinned in `catalog-release.txt`. The server starts after verifying the Neon schema and reading the published catalog. The service uses the 512 MB compute plan at $7 per month. On Hobby, the third custom domain adds $0.25 per month before usage charges. [Render pricing](https://render.com/pricing) · [Custom domain pricing](https://render.com/docs/custom-domains).

For a replacement deployment, use the following sequence.

1. Provision the Node web service from the intake repository's `main` branch and use the compute and runtime settings in the Blueprint.
2. Set the existing production `DATABASE_URL`, `AWS_ENDPOINT_URL_S3`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `REVIEWER_PASSWORD` and `MAIL_QUEUE_KEY` in Render’s secret settings. Use the current deployed reviewer password and encryption key so the change of host preserves the staff workflow. Leave `MAIL_DISABLED=1` until a verified sender is configured.
3. Verify the staged service is healthy at `/healthz`. Snapshot the three live DNS records. Attach the custom domains to the replacement service and switch each existing CNAME to the new Render hostname with Cloudflare proxying off. Verify TLS and a response from the new origin before switching the next host. Restore the saved record if a check fails. The first cutover kept a private DNS snapshot and the prior Mac tunnel available for rollback. [Render Cloudflare instructions](https://render.com/docs/configure-cloudflare-dns).
4. Recheck each domain over TLS. On the catalog, confirm the first HTML response contains the visible sections. On intake and review, confirm origin checks, uploads, approved content, private image access and one-time links. Use fictional test records and clean them up afterward.
5. When adding email, configure `SMTP_URL`, `MAIL_FROM` and `REPLY_TO`, then set `MAIL_DISABLED=0` and test delivery. Add named staff access before sharing the desk broadly.

GitHub holds the source and GitHub Pages serves the design prototype. The live app uses Node for image processing, sessions, review and the mail worker. A static-only deployment would cover browsing pages. [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits).

For the itinerary, keep the optional `ITINERARY_OPENAI_API_KEY` on the server and set a project budget at the provider. The app validates proposed stop IDs against its own list and applies request limits. The route builder keeps offering suggested itineraries without model access. Test the model, unavailable stop flow and choices with the interaction designer before representing it as live AI.

SQLite backups and retention scripts apply to the local SQLite source. For hosted Neon, check the plan’s restore window, schedule secured database exports, and back up the private object bucket separately before real intake volume increases. Test a restore of a record and its media together.
