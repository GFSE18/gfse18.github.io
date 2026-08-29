# How to add session-based traffic tracking

This guide assumes your current setup is:

- Your website is hosted by GitHub Pages at `https://gfse18.github.io`.
- Your traffic Worker is named `overseer` and is available at
  `https://overseer.matthewzhou05.workers.dev`.
- The Worker already has a D1 database connected with the binding name `DB`.

You do **not** run the files in this `worker` folder on your computer. They are
copies of the code that you will paste into the Cloudflare dashboard.

## What this change does

The visitor's browser creates a random session ID. It continues using that ID
while the visitor moves between your tracked pages. If the visitor goes 30
minutes without opening another tracked page, the next page starts a new
session.

D1 then keeps one row for the session instead of adding one row for every page
view. That row shows:

- when the session started;
- when it was last active;
- the number of page views; and
- which pages were viewed.

This is an anonymous browser session, not proof of a person's identity. A
different browser, private window, device, or cleared browser storage creates a
different session.

## The three files and where they go

| Local file | Where its contents go |
| --- | --- |
| `worker/migration-session-grouping.sql` | Run once in your Cloudflare D1 database console |
| `worker/index.js` | Replace the current code in your Cloudflare Worker |
| `js/analytics.js` | Keep this file in your GitHub Pages website repository |

Complete the following steps in order.

## Step 1: Update the D1 database

This adds the new session columns. It does not delete your existing traffic
records.

1. Sign in to the [Cloudflare dashboard](https://dash.cloudflare.com/).
2. Open **Storage & Databases**, then **D1 SQL Database**.
3. Select the database used by your `overseer` Worker.
4. Open the **Console** tab.
5. On your computer, open `worker/migration-session-grouping.sql`.
6. Copy everything in that file.
7. Paste it into the D1 Console.
8. Select **Execute**.
9. Wait for Cloudflare to report that the commands succeeded.

Run this SQL file **only once**. Running it again will produce errors such as
`duplicate column name`, because the columns already exist. If you see that
message on your first attempt, stop instead of repeatedly running the SQL; the
migration may already have been applied.

Cloudflare automatically keeps D1 recovery history through Time Travel, so you
can restore the database if a database change goes wrong.

## Step 2: Replace the Worker code

1. In the Cloudflare dashboard, open **Workers & Pages**.
2. Select your `overseer` Worker.
3. Open its code editor. Depending on the dashboard wording, this may be called
   **Edit code**, **Quick edit**, or **Edit Worker**.
4. On your computer, open `worker/index.js`.
5. Copy everything in that file.
6. In Cloudflare's editor, select all of the old Worker code and replace it with
   the copied code.
7. Select **Deploy**.
8. Wait until Cloudflare says the deployment succeeded.

Do not paste `migration-session-grouping.sql` into the Worker editor. The Worker
editor receives only the contents of `worker/index.js`.

### Check the database connection

Replacing the code should not remove your existing database connection, but it
is worth checking:

1. Open the Worker's **Settings**.
2. Find **Bindings**.
3. Confirm there is a D1 database binding named exactly `DB`.
4. Confirm it points to the database you updated in Step 1.

The capitalization matters: the code expects `DB`, not `db`.

## Step 3: Publish the website tracking file

The file `js/analytics.js` in this website folder has already been updated. It
creates the session ID and sends it to the Worker.

Publish the website to GitHub Pages the same way you normally publish changes.
For example, commit and push the updated `js/analytics.js` file to the GitHub
branch used by GitHub Pages.

If you edit the GitHub repository through the GitHub website instead:

1. Open `js/analytics.js` in your GitHub repository.
2. Choose the pencil/edit button.
3. Replace its contents with the contents of the local `js/analytics.js` file.
4. Commit the change.
5. Wait a few minutes for GitHub Pages to publish it.

Only pages containing this line send traffic information:

```html
<script src="/js/analytics.js"></script>
```

Place that line immediately before `</body>` on any additional page you want to
track. Your home page and projects page already contain it.

## Step 4: Test the result

1. Open your portfolio home page in a private/incognito browser window.
2. Open the projects page from the same window.
3. Open
   [https://overseer.matthewzhou05.workers.dev/admin](https://overseer.matthewzhou05.workers.dev/admin).
4. Select **Refresh**.

You should see one new row with:

- **Views** equal to `2`;
- the home page and projects page listed under **Pages**;
- an earlier **First seen** time; and
- a later **Last seen** time.

Refreshing or revisiting a page within 30 minutes should increase **Views** on
the same row. After a gap of at least 30 minutes, a new page view should create a
new row.

Old records will still appear. Because they were created before session
tracking existed, each old record appears as a one-view session.

## If something goes wrong

### The website still creates a separate row for every page

- Make sure the updated `js/analytics.js` is live on GitHub Pages, not only on
  your computer.
- In your browser, reload the site while bypassing its cache. On Windows, try
  `Ctrl+F5`.
- Confirm the Worker code was deployed, not merely saved in the editor.

### The Worker reports a missing column

The D1 migration was not completed. Return to Step 1 and run
`migration-session-grouping.sql` in the correct database.

### D1 says "Requests without any query are not supported"

This can happen if the SQL was pasted as one line beginning with a `--` comment.
The current migration file contains only SQL commands, so copy it again, paste
it into the empty box at the bottom of the D1 Console, and select **Execute**.

### The Worker reports that `DB` is undefined

The D1 binding is missing or has a different name. Follow **Check the database
connection** above and make sure the binding is named `DB`.

### You need to undo the Worker change

Cloudflare keeps Worker versions. Open the Worker's **Deployments** page and
roll back to the previous version. The extra D1 columns can remain in place;
the old Worker will simply ignore them.

## Important privacy warning

Your current `/admin` and `/admin-data` pages are not password protected. Anyone
who knows or guesses those addresses can see stored IP addresses and location
information. This session change does not fix that existing issue. Protect the
admin routes with Cloudflare Access before treating this as a production-ready
analytics system.
