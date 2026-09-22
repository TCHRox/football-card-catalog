# Football Card Catalog v31

SportsCardsPro Collector integration for ungraded prices. Based on the representative's confirmation that your private catalog can use the $6/month Collector API.

## Deploy

1. Unzip this package. In your existing site source, replace the entire `netlify/functions` folder with the supplied folder, then replace the remaining supplied files. Removing the old Functions folder prevents the obsolete pricing workers from continuing to run.
2. Keep `SPORTSCARDSPRO_API_TOKEN` and `CARD_CATALOG_ADMIN_PASSWORD` as secret Netlify variables accessible to Functions. Check that the Production context contains the correct token; your screenshot shows four separate context values.
3. Keep `SERPER_API_KEY` if you want automatic image search. After deploying v31, delete `CARDSIGHTAI_API_KEY` and `PARSE_API_KEY`; this version does not use them.
4. Deploy through your existing Git-connected Netlify build (commit and push the replacement files) or a Netlify CLI deployment that builds Functions. Static-file-only drag-and-drop is insufficient. Dependencies are in package.json; Netlify configuration is included.
5. Open the deployed catalog, click **Sync Market**, and enter your catalog admin password. Watch the status for configuration errors or matching progress. The live token can only be verified after deployment.

## Automatic updates

A scheduled function checks for new or due cards every ten minutes. Prices are cached for seven days, so opening a card never makes a paid pricing request. Work is split into resumable batches with at least 1.2 seconds between API requests. Initial matching of thousands of cards can take several hours or overnight. It continues with the browser closed, subject to your Netlify account limits and scheduled/background Functions availability.

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
