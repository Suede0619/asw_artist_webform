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
| Weekly roundup | Publish an issue with links to the same approved calendar entries and one featured artist where an approved artist is linked to an issue selection. Include a separate newsletter opt-in. |
| Advertise | Collect advertiser, contact, issue date, headline, short copy, destination, image, alt text and permissions. Give the submitter a private status link. After approval, the status page opens Stripe Checkout for the reserved issue. |

## Daily curation and approval

The worker runs once per day in America/Denver and checks configured official venue and tourism feeds. It considers the rolling window and the next day entering it. Eligible inputs come from approved JSON feeds and structured event markup. The model ranks bounded candidates for local arts relevance using supplied facts. It may not supply dates, prices, access claims, images, permissions or links. Source fetches report failures individually. Validate event types, venue, canonical URL and dates. Expiration comes from the event date, even during a source outage. Repeat observations reuse the source identity and changes queue a revision. Keep prior approved details available until the editor approves the revision or withdraws the entry. An editor can approve, decline or withdraw. Images serve as private previews until rights and the public revision clear.

## Weekly issue and Mailchimp

The issue covers Thursday through Wednesday in America/Denver. The worker builds it from the approved calendar, with city sections and a short artist feature from an approved profile when calendar coverage supports it. The editor reviews the proposed selection, links, images and subject. Approval applies to an exact snapshot. Changes to the selected content invalidate approval before sending. If the issue is ready, send Thursday morning. Approval after the send time can release that day’s issue. An issue outside its send day requires a new issue.

Generate a readable 600px-wide HTML email with inline styles, wordmark, text headlines, descriptive alt text, public HTTPS image URLs, branded footer, permission reminder and unsubscribe merge tag. Generate a matching plain-text version. Add campaign tags to first-party links. Use Mailchimp reports for deliveries, bounces, clicks and opens. Treat opens as directional because privacy features can prefetch tracking images. Define conversions separately as consented site actions and successful ad payments. Sender authentication, an approved mailing address and inbox tests are release requirements. The public event intake and artist contact list confer no newsletter consent.

Create one Mailchimp campaign per issue. Persist the campaign ID, use a stable campaign title to find it after an uncertain create response, and check its remote status before retrying a send. The app records delivery status and retrieves aggregate reports through the Marketing API. Approve the sender domain and audience in Mailchimp before enabling automated sends.

## Sponsorship

Start with one labeled sponsor per issue. Display the price before purchase. Reserve the slot for the approved creative, and use a server-created Stripe Checkout session. Treat signed Stripe confirmation and complete payment as the payment record. Match the quote, issue and creative revision before marking the slot paid. Return visits show the actual payment state. Payment failure leaves room to retry before the reservation expires. Withdrawing a paid ad prevents publication and starts an operator refund review. Sponsorship never changes calendar selection.

## Delivery and verification

1. Ship the calendar data model, server-rendered visitor pages, public submission form, private photos, editorial review and date-window behavior to a staging branch.
2. Connect configured sources and run a daily rehearsal with verified fixtures and a model budget. Verify duplicate, changed, expired and canceled cases.
3. Generate and preview the roundup in the curator desk. Test approval, rendering with images off, duplicate safeguards and an internal Mailchimp campaign before enabling real sends.
4. Verify ad intake, slot assignment and checkout in Stripe test mode, including failed and duplicate webhooks. Enable sponsored production issues only when price, publisher terms and payment credentials are approved.

The production domain and API share the existing Render service. The intake repository owns migrations, background jobs, forms and staff review. The catalog repository owns public rendering. Keep both local development branches based on main, with no production migrations or external sends during implementation. Deploy first against an isolated database and mail and checkout test settings.

[Mailchimp Marketing API](https://mailchimp.com/developer/marketing/api/)
[Email HTML guidance](https://mailchimp.com/help/about-html-email/)
[Campaign footer requirements](https://mailchimp.com/help/about-campaign-footers/)
[Stripe Checkout fulfillment](https://docs.stripe.com/checkout/fulfillment)
