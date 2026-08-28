# Football Card Archive v5

This version is tailored to your current Google Sheet layout.

## Expected sheet structure

- Column A = first name
- Column B = last name
- Column C = year
- Column D = rookie card? (`Y` or `N`)
- Column E = brand
- Column F = type
- Column G = set number
- Column H = quantity owned
- Column O = notes

The site now combines first and last name into the player title and shows `RC` when the rookie column is `Y`.

## Notes

- The site is hardcoded to Google Sheet gid `1796597612`.
- Team and Grade filters are hidden because the current sheet does not use those fields.
- Collection Value and Total Cost automatically hide if the sheet does not have those columns.
- `card-images.json` is where internet-sourced card images can be attached without editing the sheet.

## Example card image mapping

The file includes one seeded example for:

De'Von Achane 2023 Phoenix Base 130

based on the Sports Card Investor page:
https://www.sportscardinvestor.com/cards/de-von-achane-football/2023-phoenix-base-130


## v6 changes

- Player names now use spreadsheet-style fill-down behavior.
- If Column A (first name) or Column B (last name) is blank, the site uses the most recent nonblank value above it.
- This means all cards beneath a player heading remain assigned to that player until a new name appears.
- Example behavior supplied for verification:
  - Row 15 inherits Davante Adams
  - Row 37 inherits Troy Aikman
  - Row 74 inherits Josh Allen
- The inherited names are also used for image matching and search.


## v7 changes

- Added automatic image lookup for cards.
- The site now attempts to fetch card images from Sports Card Investor using the card's player, year, brand, type, and number.
- Image lookup is lazy-loaded, so only cards near the viewport attempt a fetch.
- Successful image matches are cached in the browser's local storage, so repeat visits should load faster.
- Manual overrides in `card-images.json` still take priority.
- Added a new Netlify function: `netlify/functions/card-image.mjs`.


## v8 changes

- The site now uses the known spreadsheet column positions as the source of truth:
  - A first name
  - B last name
  - C year
  - D rookie Y/N
  - E brand
  - F type
  - G card number
  - H quantity
  - O notes
- This fixes card-number lookup and prevents quantity from being mistaken for a card number.
- Sports Card Investor URL generation now preserves apostrophes as word separators, so `De'Von` becomes `de-von`.
- Added alternate player slug and brand variants for better lookup coverage.
- Added more normal browser request headers to the image lookup function.


## v9 changes

- Sports Card Investor remains the primary image source.
- Image lookups are now queued one at a time instead of firing many simultaneous requests.
- Adds a 1.4-second delay between lookups to reduce source throttling.
- Rate-limited requests are retried with a cooldown.
- Failed matches are temporarily cached so the same missing card is not hammered repeatedly.
- Added common set-name normalization, including `Donruss Optics` -> `Optic` / `Donruss Optic`.
- Column O notes are now included in image matching and can help identify named parallels.
- If the direct Sports Card Investor URL pattern fails, the server performs a web search restricted to Sports Card Investor and verifies the resulting card page before using its image.


## v10 changes

- Replaced direct Sports Card Investor scraping with the Serper Google Images API.
- Image searches now run in parallel (up to 10 at once), so visible cards can populate together.
- Sports Card Investor is still the preferred result source when it appears.
- Other card-specific sources such as COMC and SportsCardsPro are scored as fallbacks.
- Exact player, year, brand, number, type, rookie status, and notes are used to rank results.
- Weak/ambiguous results are rejected rather than displaying a likely wrong card.
- Google-cached thumbnails are used for the grid because they are more reliable to embed than arbitrary seller hotlinks.
- Successful responses are cacheable for 30 days.

### Required Netlify setup

Create a Serper account at https://serper.dev and copy your API key.

In Netlify:
1. Open the football-card-catalog site.
2. Go to Site configuration.
3. Open Environment variables.
4. Add a variable named `SERPER_API_KEY`.
5. Paste your Serper API key as the value.
6. Save.
7. Go to Deploys and trigger a new deploy.

Do not put the API key directly into app.js or commit it to GitHub.


## v11 — image pipeline rewrite

The previous automated image pipeline had a major diagnostic flaw: the single
De'Von Achane Phoenix image was hardcoded in `card-images.json`, so seeing it
did not prove Serper or the Netlify image function was working.

v11 changes the image architecture:

- Adds a visible image-provider status beside the normal Live status.
- The site explicitly checks whether the Netlify Function can see `SERPER_API_KEY`.
- Missing API keys and provider errors are shown in the website instead of only in DevTools.
- Replaces one-function-call-per-card with batches of up to 8 cards.
- Runs up to two batches at once.
- Seeds the first 16 cards immediately instead of relying solely on IntersectionObserver.
- Uses the original result image first and Google's thumbnail as an automatic fallback.
- Uses an exact search first; a broader second search only runs when needed.
- Rejects low-confidence matches instead of showing likely-wrong cards.
- Adds `netlify/functions/card-images-batch.mjs`.

### Critical Netlify check

Netlify's current documentation says a variable used by a serverless function
must be available to the Functions scope when scope controls are available.
Environment-variable changes also require a new deploy to take effect.

Make sure:

- Key name is exactly `SERPER_API_KEY`
- The value is your Serper API key
- Scope includes `Functions` if Netlify shows scope controls
- Production context has the value
- You trigger a fresh deploy after saving the variable

After v11 loads, the site itself will say either:

- `Images connected`
- or a specific reason the image service is offline.


## v12 — Serper free-tier compatibility

The v11 diagnostic exposed the exact upstream error:

`Query pattern not allowed for free accounts`

The API key and Netlify Function connection were working. The search request
format was not compatible with Serper's free account.

v12 fixes that:

- Removes quotation marks and exact-match syntax from Serper queries.
- Removes `#` and other search-operator punctuation from the query text.
- Uses ordinary natural-language searches such as:
  `De Von Achane 2023 Phoenix Base 130 rookie football card`
- Requests 10 image results instead of 20.
- Keeps Sports Card Investor / COMC / SportsCardsPro preference in our own
  result-ranking code rather than using restrictive search operators.
- The status now says `Images checking` when the API key is merely detected.
- `Images connected` is shown only after an actual Serper search succeeds.
- A provider failure blocks further batches and remains visibly red rather
  than being overwritten by another batch.

No Netlify environment-variable changes are needed if `SERPER_API_KEY` is
already present and visible to Functions. Upload v12 and redeploy.


## v13 — ordered loading + stronger missed-card fallback

- Resets the browser image cache so cards marked unmatched by v12 get retried.
- Queues the first 48 catalog rows before IntersectionObserver can prioritize
  cards lower on the page.
- Keeps visible-card loading afterward, so scrolling still discovers images.
- Fixes the Serper result count to 10.
- Adds source-focused, free-tier-safe fallback searches:
  - `<card identity> SportsCardsPro`
  - `<card identity> Sports Card Investor`
- Trusted card-database results get a slightly more forgiving confidence
  threshold when player/year/set/card-number identity is otherwise strong.
- Temporary misses are retried after 6 hours instead of 12.
- The image status now reports how many cards remain queued.

This should improve cards such as Israel Abanikanda 2023 Prizm #379 and
Davante Adams 2014 Topps Chrome #114, which have canonical database pages but
were skipped by the generic v12 image query.


## v14 — permanent custom images + pagination

### Pagination
- Catalog now defaults to 250 entries per page.
- Page-size menu: 50, 100, 250, 500, or 1,000.
- Page-number controls appear above and below the grid.
- Search/filter/sort changes return to page 1.
- Automated image searches are focused on the current page rather than all 6,324 rows.

### Permanent custom images
v14 uses Netlify Blobs for persistent user-uploaded images.

A custom image:
- overrides the automatically found image;
- persists through future site deploys;
- appears on other computers and phones;
- can be replaced later;
- can be removed to return to the automatic image.

The card detail window now has **Use my image / Replace my image**.

Supported ways to add an image:
- Choose Image
- drag and drop
- copy an image and press Ctrl+V while the custom-image editor is open

The browser automatically resizes/compresses the image before upload.

### Required one-time Netlify setup

Add one environment variable to the existing Netlify site:

`CARD_CATALOG_ADMIN_PASSWORD`

Set the value to a password only you know.

Recommended:
1. Netlify -> Site configuration -> Environment variables.
2. Add `CARD_CATALOG_ADMIN_PASSWORD`.
3. Choose a strong password as the value.
4. If Netlify shows scopes, make sure Functions can access it.
5. Save.
6. Trigger a new deploy.

The password is never committed to GitHub. The browser keeps it only for the
current tab/session after you enter it.

### New dependency

`@netlify/blobs` is included in package.json. Netlify installs it during the
site build. Netlify Blobs provides site-wide persistent storage that survives
deployments.


## v15 — card ID preservation + custom-photo cleanup

- Removed the `My Photo` badge from custom images.
- Switched the Google Sheet reader from the `gviz` CSV endpoint to Google's
  standard CSV export endpoint.
- This is important for Column G because it contains mixed values: purely
  numeric IDs as well as alphanumeric IDs such as `MBC-47`, `RC-12`, etc.
- Google's Visualization endpoint can infer a mostly-numeric column as numeric
  and return text entries as blank. Standard CSV export preserves the displayed
  card ID text.
- Column G continues to be treated as a string everywhere in the site, so
  letters, hyphens, leading text, and other characters are part of the card ID.


## v16 — market-focused card detail window

The card detail modal has been redesigned as a market dashboard.

### New detail layout
- Large card image and compact identity information on the left.
- Current ungraded estimate at the top.
- Recent sold-price line chart.
- Current values across common grades.
- Up to eight recent sold listings with dates, titles, prices, and links.
- SportsCardsPro source link and attribution.
- Custom-image controls remain available but are visually secondary.

### Market source
v16 uses public SportsCardsPro card pages as the market-data source.

When a card is opened:
1. The site looks for a matching SportsCardsPro football-card page.
2. It reads the current price guide.
3. It reads recent completed-sale listings.
4. The recent sales are used to draw the chart directly in the browser.

The existing `SERPER_API_KEY` is reused only to locate the correct
SportsCardsPro page when a direct source page is not already known.

Market results are cached at the Netlify/CDN level for roughly six hours so
opening the same card repeatedly does not continuously request the source site.

Some obscure cards, parallels, or differently named sets may not match
automatically. In those cases the detail modal remains usable and clearly says
that no reliable market match was found.


## v17 — market data source changed to The Card API

SportsCardsPro's public pages return HTTP 403 to Netlify server-side requests,
so v17 no longer attempts to scrape SportsCardsPro.

The market dashboard now uses The Card API's developer endpoint for actual
completed sales.

### One-time setup

1. Get a free API key from https://www.thecardapi.com/
2. In Netlify -> Site configuration -> Environment variables, add:

   `THE_CARD_API_KEY`

3. Paste the key as the value.
4. If Netlify shows scopes, make sure Functions can access it.
5. Trigger a new deploy.

Do not put the API key into GitHub or app.js.

### What v17 derives from completed sales

- Recent sold-price chart
- Recent median ungraded value when raw sales exist
- Median values by grader/grade from available matched sales
- Recent listing date, title, sale price, platform and listing URL
- Exact coverage window reported by the API

The free The Card API plan currently provides a 3-day lookback and 5,000
sales records per day. Paid plans automatically expand the lookback without
requiring code changes.

Because some older/obscure cards may have no sale during a short window,
the modal can legitimately show "No reliable recent sales found." This is
different from the SportsCardsPro HTTP 403 failure.


## v18 — SportsCardsPro market data through Parse

The Card API has been removed from the market dashboard.

v18 uses Parse's managed SportsCardsPro API:

- Marketplace API:
  https://parse.bot/marketplace/6808cd1c-6144-442b-b0db-17727c37d562/sportscardspro-com-api
- Scraper ID:
  `5e67e7a5-866b-4073-8d41-881feb8b574b`

### Market dashboard

- Current ungraded SportsCardsPro estimate
- Full available grade price guide
- Monthly historical price trend
- 1Y / 5Y / All chart controls
- Up to 30 recent completed ungraded sales when available
- Direct SportsCardsPro source page

Historical chart depth is not capped at 90 days. It uses however many monthly
data points SportsCardsPro has indexed for that card.

### Parse credit conservation

The Netlify Function uses Netlify Blobs as a persistent cache:

- the SportsCardsPro card match is cached for about 180 days;
- market data is cached for 12 hours;
- `get_price_history` is only called if `get_card` did not already include
  recent-sale records.

This reduces repeated Parse credit usage substantially.

### Required environment variable

Create a Parse account and generate an API key, then add this Netlify variable:

`PARSE_API_KEY`

Make sure Functions can access it, then redeploy.

### v18 environment variable cleanup

Keep:

- `SERPER_API_KEY` — automatic card image search
- `CARD_CATALOG_ADMIN_PASSWORD` — permanent custom-image uploads
- `PARSE_API_KEY` — SportsCardsPro market dashboard

Remove:

- `THE_CARD_API_KEY` — v18 no longer uses The Card API


## v19 — faster market loading, broader matching, clickable sales

### Faster first load
v18 could require:
1. Parse `search_cards`
2. Parse `get_card`
3. Parse `get_price_history`

before the modal was fully populated.

v19 changes discovery order:

1. Reuse a SportsCardsPro URL already found by the site's image search, when available.
2. Otherwise use the existing fast Serper API to locate the SportsCardsPro card page.
3. Use Parse `search_cards` only as a fallback.
4. Fetch `get_card` for chart and grade values.
5. Load `get_price_history` asynchronously afterward.

The chart and grade guide therefore no longer wait for the recent-sales request.

### Better matching
Parse search now has a second broader pass when the exact set wording fails.
The validation remains strict on player, year, and card number so the site does
not silently attach a different card.

When no exact match passes validation, the modal can show the closest
SportsCardsPro candidate to help identify a Sheet-data issue.

Example discovered during v19 work:
- 1989 Score Troy Aikman is #270.
- SportsCardsPro's Troy Aikman #358 is a 1998 Ultra card.
So a Sheet entry of `1989 / Score / Troy Aikman / 358` should *not* be
automatically matched.

### Clickable recent sales
The current Parse SportsCardsPro contract documents sale date, title, price,
and marketplace, but not the original listing URL.

v19:
- uses a direct sale URL automatically if Parse provides one now or adds it later;
- otherwise makes the whole sale row clickable and opens an eBay completed-listing
  search using the exact sale title (or a web search for non-eBay marketplaces).

### No new environment variables
Keep:
- `SERPER_API_KEY`
- `CARD_CATALOG_ADMIN_PASSWORD`
- `PARSE_API_KEY`

`THE_CARD_API_KEY` remains unused and can stay deleted.


## v20 — 1W / 1M price-history tabs

- Added chart ranges:
  - 1W
  - 1M
  - 1Y
  - 5Y
  - All
- 1Y is now the default.
- 1W and 1M use actual dated recent completed-sale records because the
  SportsCardsPro long-term trend is monthly and is not granular enough for
  week/month views.
- 1Y, 5Y, and All continue using SportsCardsPro's historical ungraded
  market-trend series.
- If recent sales are still loading, the 1W/1M chart area shows a loading
  state and updates automatically when the sales request completes.

## eBay data-source decision

v20 keeps SportsCardsPro via Parse for recent-sales data rather than directly
scraping eBay. eBay's public Browse API is designed around purchasable/current
inventory. eBay's sales-history Marketplace Insights API is restricted and is
not open to new users, so there is not a straightforward supported eBay sold
comps API we can switch this project to.

Directly scraping the eBay sold-results web page would be more brittle than the
current managed source and would add another site-specific anti-bot/parser
dependency.


## v21 — price history by grade

The time-range tabs have been removed.

Price History now always displays the most recent one year of available
SportsCardsPro trend data.

The tabs now switch the grade/condition being graphed. Examples include:

- Ungraded
- Grade 7
- Grade 8
- Grade 9
- Grade 9.5
- PSA 10
- SGC 10
- CGC 10
- BGS 10

Only grades for which SportsCardsPro actually returns at least two historical
trend points are shown. This prevents empty or meaningless grade tabs.

Ungraded is the default whenever an ungraded/raw trend exists. If a particular
card has no ungraded trend, the first available grade series is used instead.

The Values by Grade section remains below the chart as the current price-guide
snapshot, while the tabs above the chart show how each available grade's value
has changed over the last year.


## v22 — v21 market chart hotfix

- Fixed a leftover `allTrend` variable reference from the old time-range chart.
- Market value fallback now explicitly uses the ungraded/raw historical series,
  regardless of which grade-history tab is selected.
- Grade-history tabs from v21 are otherwise unchanged.


## v23 — market trend change + catalog market values

### One-year percentage change

The selected Price History grade now displays its one-year percentage change:

- green upward arrow for gains;
- red downward arrow for losses;
- neutral arrow for essentially flat movement.

The percentage is calculated from the first and last SportsCardsPro trend
points inside the most recent one-year window.

The Values by Grade cards also display the one-year percentage when historical
trend data exists for that grade.

### Market values on catalog cards

Each catalog tile now has compact rows for:

- Raw / Ungraded
- Grade 9
- PSA 10

SportsCardsPro's `search_cards` response supplies these exact three summary
prices, so PSA 10 is shown rather than an ambiguous generic "Grade 10."

### API-credit-conscious loading

Current grid prices are populated in the background using `search_cards`,
grouped by player + year. One search can therefore populate multiple cards.

To respect Parse's free-tier request limit:

- at most one new player/year search is made every 20 seconds;
- search results are cached in Netlify Blobs for 24 hours;
- resolved card summaries are stored persistently and shared across devices;
- the queue pauses while a card detail modal is open, leaving rate-limit room
  for the more important detail request.

Percentage changes require full historical trend data, which comes from the
more expensive `get_card` call. v23 deliberately does NOT call `get_card` for
all 6,324 cards in the background.

Instead:
- current Raw / Grade 9 / PSA 10 values can populate through the cheaper
  background search;
- once a card's detail market dashboard has been loaded, its one-year changes
  are saved into the shared grid summary and appear on that card tile too.

This avoids consuming thousands of Parse credits solely to calculate arrows.

### No new environment variables

Keep:

- `SERPER_API_KEY`
- `CARD_CATALOG_ADMIN_PASSWORD`
- `PARSE_API_KEY`

No additional API setup is required for v23.


## v24 — persistent CardSight collection pricing

v24 changes market values from browser-time lookups into a persistent,
collection-wide pricing database.

### What is new

- All matched catalog rows can have stored market values.
- Market values are saved in Netlify Blobs and are shared across every device.
- The catalog displays:
  - Raw / ungraded
  - PSA 9
  - PSA 10
- One-year percentage changes are stored when enough sales history exists.
- `Value: High → Low` and `Value: Low → High` sort the ENTIRE filtered
  collection by the stored raw market value before pagination.
- Collection Value uses Raw market value × quantity for every valued card.
- New **Sync Market** button starts a background sync.
- A market status indicator shows matched, valued, and unresolved counts.
- New Sheet rows are discovered and matched on later syncs automatically.

### CardSight matching

Initial matching is persistent. The function groups unmatched rows by
player + year and queries the CardSight catalog once for the group where
possible. Each Sheet row is then validated against:

- player
- year
- exact card number
- brand / release / set
- parallel name from Notes when applicable

Ambiguous parallels are deliberately left unresolved instead of assigning the
wrong value.

### Pricing refresh

CardSight's bulk pricing endpoint accepts up to 100 card IDs per call.

The sync:
1. loads existing permanent CardSight matches;
2. matches only new/unresolved collection rows;
3. sends matched canonical card IDs to bulk pricing in groups of 100;
4. computes current values from recent completed pricing records;
5. saves values and one-year changes into Netlify Blobs.

Raw values use the median of the most recent 90 days of records when possible,
falling back to the available one-year window.

### Automatic schedule

A scheduled Netlify Function runs once per day, but the default refresh
interval is **7 days**.

The daily scheduler checks the most recent successful refresh and only starts
CardSight when the stored market data is at least seven days old.

Optional Netlify variable:

`CARDSIGHT_REFRESH_DAYS`

- omit it -> weekly (7 days)
- `7` -> weekly
- `1` -> daily

This lets the frequency change without another code release.

### Required new Netlify variable

`CARDSIGHTAI_API_KEY`

Get the free key from CardSight AI and make it available to Netlify Functions.

### Variables to keep

- `SERPER_API_KEY` — automatic image lookup
- `CARD_CATALOG_ADMIN_PASSWORD` — permanent image changes and manual market sync
- `PARSE_API_KEY` — current SportsCardsPro detail-window history
- `CARDSIGHTAI_API_KEY` — collection-wide persistent values

`THE_CARD_API_KEY` remains unused and can stay deleted.

### Free-plan call considerations

CardSight currently includes 750 calls/month on the free tier.

Once every Sheet row is matched, a full pricing refresh requires roughly one
bulk call per 100 unique canonical card IDs. 6,324 catalog rows therefore have
a theoretical maximum of about 64 bulk pricing calls per refresh, and usually
fewer when multiple entries are variants of the same canonical card.

Weekly recurring pricing should therefore fit comfortably within 750 calls.

The initial one-time matching stage also consumes API calls. v24 groups rows by
player + year so one catalog call can match multiple cards, and caps new match
searches at 600 during one background run. If the collection has more unique
player/year groups than the free allowance can cover in the first month, the
sync will preserve all progress and can resume later. A one-month CardSight Pro
upgrade is the fastest option if the initial mapping exhausts the free quota.


## v25 — CardSight sync diagnostics and rate-limit fix

v24's sync UI could hide failures and its progress wording was misleading.

### What was wrong in v24

- `Sync Market` reused the admin password stored in sessionStorage by the custom
  image editor, so it often did not visibly ask for a password.
- The background function's authorization/API failures were not visible to the
  browser because background functions return immediately.
- Every card without a successful match was displayed as "unresolved," even if
  its player/year group had not been processed yet.
- CardSight Free allows 4 requests/second. v24 waited between outer player
  groups, but one group could perform several pagination requests back-to-back,
  creating a rate-limit burst.

### v25 changes

- Manual **Sync Market always asks for the catalog admin password**.
- New regular `cardsight-sync-start` function:
  - validates the admin password;
  - verifies `CARDSIGHTAI_API_KEY` against CardSight before starting;
  - writes a visible queued status;
  - then launches the background job.
- Every CardSight HTTP request is globally throttled to at least 350ms apart.
- HTTP 429 responses retry automatically with backoff.
- The page now has a real progress bar.
- Matching shows:
  - player/year groups processed;
  - matched rows;
  - genuinely unmatched rows;
  - pending rows;
  - valued rows;
  - CardSight API calls used during this run.
- Pricing shows:
  - canonical card IDs priced / total;
  - catalog rows valued;
  - API calls used.
- Errors remain red and visible instead of reverting to "Market ready."
- Existing v24 unresolved rows are retried because v25 uses a new matcher
  version.
- When CardSight's catalog card already provides Raw / PSA 9 / PSA 10 prices,
  v25 stores those immediately during matching. Values can therefore appear
  before the final bulk-pricing phase completes.

### Existing setup remains valid

No new Netlify variables are required.

Keep:

- `CARDSIGHTAI_API_KEY`
- `SERPER_API_KEY`
- `PARSE_API_KEY`
- `CARD_CATALOG_ADMIN_PASSWORD`

`THE_CARD_API_KEY` remains unused.

## v27 — charcoal containers + lion shield header mark

- Replaced the circular `FC` brand mark in the upper-left header with the supplied orange/charcoal lion shield artwork.
- Kept the existing favicon from v26.
- Standardized the site's container surfaces to a neutral dark charcoal/steel-gray palette instead of the remaining blue/navy or mixed translucent panels.
- Cards, stats, controls, status pills, modal panels, market panels, inputs, buttons, pagination controls, sales rows, and nested detail containers now use coordinated dark gray surfaces.
- Orange remains the primary accent color.
- Click-anywhere card behavior from v26 is unchanged.
