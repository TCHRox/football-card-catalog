# v36 — Selected graded prices and collection valuation

Deploy all supplied files to your existing Netlify site, including the new manual-grade-index function. No new environment variables or subscriptions are needed.

In My graded prices, select one grade and enter its price. Save graded prices persists the selection and shows that grade beside the ungraded price on the main card. Apply selected grade to collection value saves the form and uses the selected price instead of the ungraded price in the total. Use ungraded in total saves the form and restores ungraded valuation while retaining the grade display selection. No grade displayed clears the selection and restores ungraded valuation. Once a graded override is active, subsequent saved changes to its selected grade/price update the total too.

Prices are per copy: the selected value is multiplied by the Sheet quantity for that catalog entry. This is an estimate override, not a claim that the physical cards are graded. The main total is labeled Collection Value. Value sorting continues to use ungraded prices. Existing graded prices remain intact; old records default to no selection and ungraded valuation. Selections and apply settings persist in the same server-side record as the prices. The collection total reports Unavailable if grade selections fail to load, instead of silently showing an incomplete total; Refresh Sheet retries.

Card Match is now collapsed by default; click its heading to reveal candidates and the ID form.

Validation: 23 existing tests passed. Simulated UI tests passed for selected-grade display, quantity-aware totals, reset, reload, failed-save isolation and collapsed Card Match. Live Netlify persistence and visual browser verification were not available during this update.

# v35 — Stop one missing card from blocking market sync

Deploy the supplied files to your existing Netlify site, then click Sync Market once. No key changes are needed. Existing prices, manual confirmations, graded prices and images remain in their existing stores.

Structured API 404 lookup responses now flag that card for review and continue to the next card. The affected card is deferred for 30 days unless its mapping changes. Existing prices for unchanged mappings are retained. Cards flagged for review appear in Unconfirmed even if they had an earlier ID. Five consecutive missing lookups pause the batch as a possible broader provider issue. Authentication errors, rate limits, connection failures and unreadable responses still pause the batch.

The obsolete cooldown with the exact earlier HTTP 404 message is ignored by the launcher, scheduled trigger and worker so the deployment can recover immediately. Retry timestamps in launcher errors include an explicit UTC timezone to avoid server/browser timezone ambiguity.

23 tests passed, including continued progress past a 404, recovery from an old cooldown and distinguishing structured lookup errors from unreadable HTTP errors. The production fix still requires this deployment; no credentials were changed.

# v34 — Card notes and clearer value label

Column O notes now display below the card model in the grid and popup. Grid notes occupy the existing description space and truncate to one line with an ellipsis; hover to see the full note, or open the popup for its full text. Blank notes show nothing. Grid column sizes and image dimensions are unchanged. The summary label is now Ungraded Collection Value; its calculation is unchanged.

Deploy the supplied files to your existing Netlify site. No Sheet edits or new environment variables are needed. All v33 features remain included.

# v33 — Confirm card matches in the browser

Deploy all supplied files to the existing Netlify site. No new environment variables are needed.

Open a card and use Confirm this card (or Card match on already matched cards). Candidate IDs are clickable SportsCardsPro searches using the candidate set/title. Enter the numeric product ID, click Save card ID, and enter the existing catalog admin password. Saving requires a successful Netlify response.

IDs are stored persistently in Netlify Blobs, independent of the weekly worker's pricing state. They survive redeploys on the same site and take precedence over Sheet ID/URL fields. The Sheet is not modified. New corrections are prioritized when the next batch starts (normally immediately after the current batch, with the ten-minute schedule as a fallback). A currently running batch may finish first. An old price is hidden while a different saved ID awaits verification. Saved means the mapping was stored, not that SportsCardsPro has verified that ID yet. Correct a mistaken ID using the same field.

Unconfirmed shows entries without an API match or browser-saved ID, including entries awaiting their first match. Successfully saved IDs leave this tab immediately. Cards with a confirmed ID but no available price do not count as unconfirmed.

The confirmation form is independent of pricing refreshes, so polling does not erase an ID being typed. As with other saved card data, changing identifying Sheet fields creates a different card identity.

Validation: 21 automated tests and simulated popup/filter/save interactions passed. Live Netlify saving still requires verification after deployment. Candidate searches may show multiple variants; inspect the exact card before saving.

# v32 — Light archive, watchlist and manual graded prices

Deploy all supplied files through the same Netlify build. Keep your existing Netlify site: pricing history, custom images and sync progress remain in their existing stores. No new environment variables or subscriptions are required.

- Light storefront layout inspired by the supplied reference; filters in a sidebar, responsive mobile layout, existing Sheet/image/pricing/pagination controls retained.
- Heart buttons add cards to Watchlist. Watchlist persists in this browser on this site; it does not sync between devices and clearing browser data removes it.
- In each popup, enter Grade 7, 8, 9, 9.5 and PSA 10 estimates, then Save graded prices. Your catalog admin password is required. These USD values save in a separate Netlify Blobs store and survive reloads, browser changes and redeploys on the same Netlify site. Weekly updates never overwrite them. Blank fields clear an estimate. Values are manual estimates, not SportsCardsPro graded data, and do not change the ungraded collection total.
- Saved card metadata uses the same normalized identity as market prices (player, year, set, card number, type, rookie and notes). Reordering or adding Sheet rows does not move saved values to another card; changing identity fields creates a different identity. Keep the original identity if you want to retain its saved values.
- Recent sales use compact date/title/price rows within a scrollable panel. Actual listing URLs are used when returned; otherwise a clearly labeled Search sold listings link opens eBay search, not an asserted exact match.
- Manual values are never marked saved unless the server confirms success. A storage error leaves the form available to retry.

Validation: existing pricing tests, manual-price validation/authentication checks and UI integration checks. Production persistence requires deployment to Netlify; no production credentials were available during development.

Previous setup details follow.

# v31.1 — Recent sales restored

Recent sales are available inside each card popup with **Load recent sales**. Restore/keep `PARSE_API_KEY` as a secret available to production Functions. `SERPER_API_KEY` helps discover cards. Requests use your existing Parse service and its credits, separately from SportsCardsPro. Provider access was not live-tested. Deploy the supplied files through your existing Netlify build. SportsCardsPro weekly pricing and saved history are unchanged.

# Football Card Catalog v31

SportsCardsPro Collector integration for ungraded prices. Based on the representative's confirmation that your private catalog can use the $6/month Collector API.

## Deploy

1. Unzip this package. In your existing site source, replace the entire `netlify/functions` folder with the supplied folder, then replace the remaining supplied files. Removing the old Functions folder prevents the obsolete pricing workers from continuing to run.
2. Keep `SPORTSCARDSPRO_API_TOKEN` and `CARD_CATALOG_ADMIN_PASSWORD` as secret Netlify variables accessible to Functions. Check that the Production context contains the correct token; your screenshot shows four separate context values.
3. Keep `SERPER_API_KEY` if you want automatic image search. After deploying v31, delete `CARDSIGHTAI_API_KEY`. Keep `PARSE_API_KEY` for recent sales.
4. Deploy through your existing Git-connected Netlify build (commit and push the replacement files) or a Netlify CLI deployment that builds Functions. Static-file-only drag-and-drop is insufficient. Dependencies are in package.json; Netlify configuration is included.
5. Open the deployed catalog, click **Sync Market**, and enter your catalog admin password. Watch the status for configuration errors or matching progress. The live token can only be verified after deployment.

## Automatic updates

A scheduled function checks for new or due cards every ten minutes as a safety net. A manual Sync Market now chains resumable background batches automatically until the due queue is drained, while keeping at least 1.2 seconds between SportsCardsPro requests. Prices remain cached for seven days, so opening a card never makes a paid pricing request. Large initial matching runs can still take hours because of the provider rate limit, but no repeated button clicks are required.

Existing prices survive temporary API failures. Authentication/configuration errors pause retries for six hours; other failures pause for fifteen minutes. The status reports when to retry. Netlify usage is separate from the $6 SportsCardsPro subscription; this package does not guarantee zero hosting charges.

## Match corrections in Google Sheets

Keep the current column layout. Append optional columns named exactly `SportsCardsPro ID` and `SportsCardsPro URL` after your existing columns. The ID is the provider's numeric product ID, not the card number. A confirmed ID is the most reliable match and overrides automatic matching. A SportsCardsPro card-page URL helps search but does not guarantee an exact match.

Ambiguous cards display a review message and candidate IDs in their details. Confirm the correct year, set, player, number and parallel on SportsCardsPro, enter the ID in the Sheet, then click Sync Market. Do not guess variants. Multiple copies share a stored price; collection totals account for quantity.

## What changed

- Replaced CardSight/Parse pricing with the SportsCardsPro API.
- Ungraded estimates only; no unsupported graded estimates or sales-history claims.
- Saved provider IDs, dates, source links and weekly price snapshots.
- Charts build from collected snapshots; old historical prices are not backfilled.
- New price storage starts empty. Previous provider estimates are not presented as SportsCardsPro values.
- Existing images and catalog controls retained.

Your representative's permission describes a private catalog. Retain your site's existing private access configuration. The catalog admin password protects editing/sync actions; it is not a visitor login or protection for viewing the catalog/pricing endpoint.

## Validation

Unit tests cover price conversion, strict matching, variants, weekly caching, resumable batches, API throttling, failure preservation and concurrent-worker locking. A mocked DOM integration checked Sheet loading, quantity totals, price/review dialogs, charts and the sync button. No live API token or production Netlify deployment was available for testing.

API reference: https://www.sportscardspro.com/api-documentation
