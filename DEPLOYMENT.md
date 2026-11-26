# ArtSouthwest deployment

| Website | Live address |
|---|---|
| Public catalog and Taos day planner | [artsouthwest.com](https://artsouthwest.com/) |
| Artist invitation, intake and revisions | [artist.artsouthwest.com](https://artist.artsouthwest.com/?campaign=taos-artists) |
| Password-protected staff desk | [curator.artsouthwest.com](https://curator.artsouthwest.com/) |

The named Cloudflare tunnel forwards the three hostnames to the private Node origin at port 4280. Host-based route checks protect the artist and staff APIs. Artist and staff session cookies belong to their own hosts. The campaign address on the former apex redirects to the new invitation. An existing artist who opens the old form URL in the original browser can transfer a valid session once with a short-lived private link. The live service uses Neon Postgres and private Object Storage.

## Verify a submission

1. Submit a fictional artist profile, portrait and three available works through a test origin linked to a Neon test branch. Save the receipt reference.
2. Open the staff desk, sign in, choose **Submissions**, and search by reference. The desk shows which storage backend it is using and counts stored photos.
3. Open the submission. Confirm the profile, availability, prices, portrait, artwork previews and permissions. Click a preview to inspect it at a larger size.
4. To approve a real submission, confirm editorial and image clearance, record the reason and choose **Publish**. The catalog gets the approved artist and artworks from `GET /api/catalog` on its next read. Sold works and withdrawals come down through the artist’s update flow.
5. For a database check, open the correct project and branch in [Neon Console](https://console.neon.tech/). Open **Tables** under **Postgres database**. Inspect `applications` for the saved record and `assets` for the photo records. `publications` contains approved catalog snapshots. Use the staff desk to see photos. The original bytes and display previews live in the private `uploads` bucket in **Object Storage**.

Keep the reviewer password in a password manager. The current desk uses the private reviewer password in the runtime directory. Add individual staff identities before expanding access to the team. Use the review desk for routine work and restrict raw Neon Console access to operators.

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

Build `production-dist` in [the website repository](https://github.com/Suede0619/sw-arts-website). The apex serves this directory and the approved API. The old `/discover/` path redirects to the catalog home.

## Hosting, access and email

The tunnel depends on the Mac’s availability. Move the origin to managed Node hosting for independence from the Mac. Set up named staff access before sharing the desk broadly and test transactional email using the verified sender. Set the exact public origin, upstream proxy hops, reviewer identity and secret, callback owner, stable mail encryption key, and the Postgres and Object Storage credentials in the host’s secret settings. Point the existing domain to the chosen host after its HTTPS endpoint and data persistence pass verification.

The existing [Render Blueprint](render.yaml) is a SQLite deployment template. Review the host’s displayed charges and configure a Neon-backed service before using it for this release. [Render custom domains](https://render.com/docs/custom-domains).

For the itinerary, keep the optional `ITINERARY_OPENAI_API_KEY` on the server and set a project budget at the provider. The app validates proposed stop IDs against its own list and applies request limits. The route builder keeps offering suggested itineraries without model access. Test the model, unavailable stop flow and choices with the interaction designer before representing it as live AI.

SQLite backups and retention scripts apply to the local SQLite source. For hosted Neon, check the plan’s restore window, schedule secured database exports, and back up the private object bucket separately before real intake volume increases. Test a restore of a record and its media together.
