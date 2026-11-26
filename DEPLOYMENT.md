# ArtSouthwest intake deployment

[The live artist invitation](https://artsouthwest.com/?campaign=taos-artists) reaches the Node origin on the Mac through a named Cloudflare tunnel. The connector forwards the apex to port 4098. The staff desk runs separately on the Mac at [http://127.0.0.1:4099/review](http://127.0.0.1:4099/review). The public origin returns 404 for staff routes.

## Verify a submission

1. Submit a fictional artist profile, portrait and three available works through a test origin linked to a Neon test branch. Save the receipt reference.
2. Open the staff desk, sign in, choose **Submissions**, and search by reference. The desk shows which storage backend it is using and counts stored photos.
3. Open the submission. Confirm the profile, availability, prices, portrait, artwork previews and permissions. Click a preview to inspect it at a larger size.
4. To approve a real submission, confirm editorial and image clearance, record the reason and choose **Publish**. The catalog gets the approved artist and artworks from `GET /api/catalog` on its next read. Sold works and withdrawals come down through the artist’s update flow.
5. For a database check, open the correct project and branch in [Neon Console](https://console.neon.tech/). Open **Tables** under **Postgres database**. Inspect `applications` for the saved record and `assets` for the photo records. `publications` contains approved catalog snapshots. Use the staff desk to see photos. The original bytes and display previews live in the private `uploads` bucket in **Object Storage**.

Keep the reviewer password in a password manager. The current tunnel setup uses the private password file in the running data directory. Staff access from another computer requires an identity-gated hostname or a private network connection. Use the review desk for routine work and restrict raw Neon Console access to operators.

## Move the live SQLite records to Neon

1. Keep the current tunnel connector and its DNS records. Verify the backup path and target branch. Confirm you can open the current staff desk and the public HTTPS form. Record the current origin command and process ID for recovery.
2. Apply the Postgres schema with `npm run migrate:postgres` using the direct database connection. Rehearse against a separate Neon branch with fictional data. Verify the private bucket, consent, publication and withdrawal.
3. Arrange a short read/write maintenance window. Stop the current origin and make a fresh private SQLite snapshot with `DATA_DIR=./data/callback-intake npm run backup -- backups/pre-neon-cutover`. Run `npm run import:sqlite -- backups/pre-neon-cutover` to check the snapshot and every referenced file locally.
4. Confirm you are using the expected Neon branch and server credentials. With the old origin stopped, run `DATA_DIR=./data/callback-intake npm run import:sqlite -- backups/pre-neon-cutover --apply`. The script retains record, session and asset IDs. It verifies both stored images for every asset and stops on conflicting rows or image bytes. The source stays intact. If the source uses a configured queue key, give the import and runtime that same key privately.
5. Start the new origin with `PUBLIC_URL=https://artsouthwest.com npm run start:tunnel`. It requires Neon by default. It keeps port 4099 on loopback and disables email links until SMTP is configured. Existing artist cookies and referenced images remain usable when their sessions are still valid.
6. Verify HTTPS, the saved reference and its images, callback queue, anonymous access restrictions, and a new test draft against the live service. Smoke-test before reopening invitations. If verification fails before accepting new Neon writes, stop the new origin and restart the recorded SQLite origin. If Neon has received new writes, pause writes and reconcile those records before rolling back.

The same origin can serve the catalog at `/discover/`. Build `production-dist` in [the website repository](https://github.com/Suede0619/sw-arts-website) and set `CATALOG_DIR` to that built directory. The catalog reads from the same approved API. Launch the catalog on the primary domain after editorial review and update the campaign CTA before moving the invitation from the root.

## Hosting, access and email

The tunnel depends on the Mac’s availability. Before the wider campaign, run the origin on a managed Node host, put the staff desk behind identity-based access, and test transactional email using the verified sender. Set the exact public origin, upstream proxy hops, reviewer identity and secret, callback owner, stable mail encryption key, and the Postgres and Object Storage credentials in the host’s secret settings. Point the existing domain to the chosen host after its HTTPS endpoint and data persistence pass verification.

The existing [Render Blueprint](render.yaml) is a SQLite deployment template. Review the host’s displayed charges and configure a Neon-backed service before using it for this release. [Render custom domains](https://render.com/docs/custom-domains).

For the itinerary, keep the optional `ITINERARY_OPENAI_API_KEY` on the server and set a project budget at the provider. The app validates proposed stop IDs against its own list and applies request limits. The route builder keeps offering suggested itineraries without model access. Test the model, unavailable stop flow and choices with the interaction designer before representing it as live AI.

SQLite backups and retention scripts apply to the local SQLite source. For hosted Neon, check the plan’s restore window, schedule secured database exports, and back up the private object bucket separately before real intake volume increases. Test a restore of a record and its media together.
