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
