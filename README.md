# Football Card Archive

A static Netlify website that reads your football-card catalog directly from Google Sheets.

## Google Sheet already configured

Sheet ID:

`1ZelpNWlXQHIzmDCVSDv1TMYEuh-eua6SKUtsESqlmeI`

The Netlify Function is hardcoded to `gid=1796597612`, which is the combined catalog tab.

## 1. Make the Sheet readable by the site

In Google Sheets:

1. Click **Share**.
2. Under **General access**, choose **Anyone with the link**.
3. Set permission to **Viewer**.
4. Click **Done**.

This does not let visitors edit your Sheet. It only allows the site to read the catalog.

## 2. Check the correct sheet tab / GID

Open the tab that contains the cards and look at the Google Sheets URL.

At the end you should see something like:

`#gid=123456789`

Open:

`netlify/functions/cards.mjs`

Change:

`const SHEET_GID = "1796597612";`

to the number from your URL if necessary.

## 3. Recommended column names

The site automatically recognizes many variations, so you do NOT need every column.

Recommended:

- Player
- Year
- Set
- Card #
- Parallel
- Team
- Grade
- Grader
- Quantity
- Purchase Price
- Market Value
- Last Sale
- 30-Day Avg
- Image URL
- Serial #
- Notes

If your existing headers are different, the card detail view still shows every field. You can add additional aliases in `app.js`.

## 4. Deploy with Netlify Drop — easiest test

1. Unzip the project folder.
2. Go to Netlify.
3. Create a new site / choose **Deploy manually**.
4. Drag the entire `football-card-catalog` folder into Netlify.

Important: the site uses a Netlify Function. If Netlify Drop does not deploy the function in your account/workflow, use the GitHub method below. GitHub deployment is the recommended permanent setup.

## 5. Deploy with GitHub — recommended

1. Create a new GitHub repository, for example `football-card-catalog`.
2. Upload every file and folder in this project.
3. In Netlify choose **Add new project** → **Import an existing project** → **GitHub**.
4. Select the repository.
5. Build command: leave blank.
6. Publish directory: `.`
7. Deploy.

Netlify reads `netlify.toml`, including the Functions directory.

## 6. Updating the collection

You do NOT need to touch GitHub when adding cards.

Edit your Google Sheet and add/change rows.

The next time the site is loaded or **Refresh Sheet** is pressed, it requests fresh data from Google Sheets.

## 7. Images

If a row has an `Image URL`, the website displays it.

If there is no image URL:
- a placeholder is shown;
- the card detail view includes a **Find card image** button using the card's year/set/player/card number/parallel.

For the cleanest long-term setup, use stable image URLs you own/control or a dedicated image-hosting service. Avoid hotlinking an eBay seller's listing image because it can disappear.

## 8. eBay prices

Each card detail page includes a **Recent eBay sales** button that opens a sold/completed search for that exact card.

The website also recognizes these spreadsheet columns:
- Market Value
- Last Sale
- 30-Day Avg

Automatic sold-price ingestion is deliberately not included yet because eBay does not provide unrestricted recent-sold data through its normal public API. A third-party pricing API can be plugged into this project later without redesigning the catalog.

## Troubleshooting

### "Google returned a sign-in page"
Set Sheet General access to **Anyone with the link → Viewer**.

### Site loads the wrong tab
Change `SHEET_GID` in `netlify/functions/cards.mjs`.

### Player/year/team filters are blank
Your headers use wording the site did not recognize. Add the exact header as an alias in the `ALIASES` object in `app.js`.

### Image doesn't display
Make sure the Image URL:
- begins with `https://`
- points directly to an image or a host that allows embedding.

## File structure

```
football-card-catalog/
├─ index.html
├─ style.css
├─ app.js
├─ netlify.toml
├─ README.md
└─ netlify/
   └─ functions/
      └─ cards.mjs
```
