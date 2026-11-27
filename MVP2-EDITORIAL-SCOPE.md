# MVP2 calendar, weekly roundup and sponsorship

## Executive summary

ArtSouthwest uses one set of approved exhibition, opening and event records for the website and weekly email. A daily worker discovers candidate listings, verifies source fields, ranks the candidates and queues material for staff approval. A public contributor form adds submissions to that same queue. The live calendar shows seven New Mexico calendar days and retains stable links for expired, moved and canceled events.

ArtSouthwest generates the weekly issue and sends it through the Mailchimp Marketing API after approval. Mailchimp owns opt-in, unsubscribe, suppression and delivery reporting. An advertiser later submits creative through a parallel form. The reviewer approves the creative and the system offers Stripe Checkout for the available slot. A paid slot can appear only in a separately approved issue.

## Visitor experience

| Surface | Scope |
|---|---|
| City homepage and navigation | What’s on links to the selected city. Feature one current exhibition or upcoming opening when approved material is available. |
| Calendar | Show today through six more local days. Separate timed openings and events from exhibitions on view. Use the existing grid, end each card with its venue and date, and serve essential content in the first HTML response. |
| Details | Show local dates, venue, optional price or admission, source and related exhibition or opening. Retain the URL after expiration and show schedule changes or cancellations explicitly. |
| Submit an event | Collect city, listing type, title, venue, dates, timed opening hours if applicable, summary, source URL, contact email and an image with alt text and permission. Require a JPEG, PNG or WebP with at least 1,080 pixels on the longest edge. Acknowledge receipt and route the submission to the editorial queue. |
| Weekly roundup | Publish an issue with links to the approved calendar entries and one story drawn from a published artist profile. Prefer an artist linked to an issue selection, then rotate through eligible profiles. Include a separate newsletter opt-in. |
| Advertise | Collect advertiser, contact, issue date, headline, short copy, destination, image, alt text and permissions. Give the submitter a private status link. After approval, the status page opens Stripe Checkout for the reserved issue. |

## Daily curation and approval

The daily worker starts at 5 a.m. Mountain Time. It considers the rolling window and the next day entering it. The first source registry covers Harwood events, Harwood exhibitions and SITE SANTA FE exhibitions. The team can add verified venue or tourism feeds. The model ranks and summarizes candidates using supplied facts. The venue remains the source for dates, prices, access and images. Source fetches report failures individually. Expiration comes from the event date, including during source outages. Repeat observations reuse the source identity and changes queue a revision. The previous approved version stays available until staff approves a revision or withdraws it. Images stay private through review.

## Weekly issue and Mailchimp

The issue covers Thursday through Wednesday in America/Denver. The worker prepares it at 7 a.m. Thursday with up to four approved listings per city and a short feature when the catalog has an eligible artist. The editor reviews the proposed selection, links, images and subject. Approval applies to an exact snapshot. Changes to the selected content invalidate approval before sending. Approved issues are eligible from 9 a.m. through the end of Thursday. The sent issue appears in the web archive.

Generate a 600px-wide HTML email with inline styles, wordmark, text headlines, descriptive alt text, public HTTPS images, footer and unsubscribe link. Generate a plain-text version. Add campaign parameters to event, artist and sponsor links. The desk shows Mailchimp’s sent, click, open, bounce and unsubscribe counts. Privacy features can prefetch open-tracking images. Successful sponsor payments appear in the desk. A later analytics step can connect tagged links to consented site actions such as inquiries. Collect newsletter consent through the Mailchimp signup form.

Create one Mailchimp campaign per issue. Persist the campaign ID and the approved issue digest before sending. Keep that snapshot fixed while Mailchimp reports that delivery is in progress. Reconcile interrupted sends, including after the issue date, and publish the archive when Mailchimp confirms the campaign was sent. The desk retrieves aggregate reports through the Marketing API. Approve the sender domain and audience in Mailchimp before enabling automated sends.

## Sponsorship

Start with one labeled sponsor per issue. Display the price before purchase. Reserve the slot for the approved creative, and use a server-created Stripe Checkout session. Match the quote, issue and creative revision against a signed event or an authenticated Stripe checkout lookup before marking the slot paid. The worker checks expired reservations and closes outstanding checkout sessions for withdrawn ads. A withdrawn or missed paid placement goes to refund review. Calendar selection stays editorial.

## Delivery and verification

1. Ship the calendar data model, server-rendered visitor pages, public submission form, private photos, editorial review and date-window behavior to a staging branch.
2. Connect configured sources and run a daily rehearsal with verified fixtures and a model budget. Verify duplicate, changed, expired and canceled cases.
3. Generate and preview the roundup in the curator desk. Test approval, rendering with images off, duplicate safeguards and an internal Mailchimp campaign before enabling real sends.
4. Verify ad intake, slot assignment and checkout in Stripe test mode, including failed and duplicate webhooks. Enable sponsored production issues only when price, publisher terms and payment credentials are approved.

The intake repository owns migrations, uploads, review, jobs and provider integrations. The catalog repository renders the public views and submission forms. Both use the existing Node service on Render. Git branch `mvp2/editorial-calendar` starts from each repository’s `main`. The feature flags let staging test the workflows while the live app continues serving artist intake and the catalog.

## Staging configuration and launch

1. Use a separate Render environment, Neon branch and private test bucket. Pin the catalog branch revision in `CATALOG_REF`. Set `ARTIST_ORIGIN`, `CURATOR_ORIGIN` and `CATALOG_ORIGIN` to the three staging hostnames. Apply the three versioned migrations with `npm run migrate:postgres`.
2. Set `EDITORIAL_ENABLED=1` and leave `EDITORIAL_JOBS` and `EDITORIAL_MAIL_SEND` off while validating visitor and curator views. Use fictional submissions and check that unpublished photos require curator sign-in. In Neon, inspect `editorial_records`, `editorial_issues`, `editorial_slots` and `editorial_jobs`.
3. Enable `EDITORIAL_JOBS` and supply `EDITORIAL_OPENAI_API_KEY` for model ranking and summaries. The configured official feeds also work with source order during a model outage. The curator desk records how many items it found and whether a source needs attention.
4. Set the Mailchimp audience, signup form, sending identity, postal address and API key. Keep the audience separate from the artist invitation list. Use `artsouthwest1@gmail.com` for replies. For a branded campaign From address, verify and authenticate an ArtSouthwest domain and route replies to the Gmail inbox. Mailchimp can rewrite a Gmail From address and continue forwarding replies to Gmail. Test both email formats against an internal test audience in Apple Mail and common webmail clients. Enable `EDITORIAL_MAIL_SEND` for the intended audience after that check. [Mailchimp guidance for Gmail and other free addresses](https://mailchimp.com/help/limitations-of-free-email-addresses/)
5. Set the sponsor price in cents and connect Stripe test keys and a webhook at `/api/editorial/stripe/webhook`. Test the paid and expired cases. Approve the price and fulfillment terms before using live Stripe keys. The approval screen shows the reservation and payment state, including any withdrawal that requires a refund review.

[Mailchimp Marketing API](https://mailchimp.com/developer/marketing/api/)
[Email HTML guidance](https://mailchimp.com/help/about-html-email/)
[Campaign footer requirements](https://mailchimp.com/help/about-campaign-footers/)
[Stripe Checkout fulfillment](https://docs.stripe.com/checkout/fulfillment)
