# How to install the portfolio traffic tracking

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

The updated tracker also records:

- active reading time while the page is visible and the browser is focused;
- the deepest percentage scrolled on each page;
- desktop, mobile, or tablet device type; and
- résumé, email, and GitHub link clicks.

This is an anonymous browser session, not proof of a person's identity. A
different browser, private window, device, or cleared browser storage creates a
different session.

## How the data is stored

The data stays grouped around the same session ID:

- `visits` keeps one main row per session, including its page history and device
  type.
- `session_page_metrics` keeps one summary row for each page viewed during that
  session. New reading-time updates are added to its active-seconds total, and
  only the deepest scroll percentage is kept.
- `session_actions` keeps one summary row for each kind of tracked click during
  the session. Repeated clicks increase a counter instead of creating a new row
  every time.

The admin page combines these tables back into one displayed row per visitor
session. It does not show engagement updates as separate visits.

## The files and where they go

| Local file | Where its contents go |
| --- | --- |
| `worker/migration-session-grouping.sql` | Original session migration; do not run it again if session grouping already works |
| `worker/migration-engagement-metrics.sql` | Run once in D1 to add reading, scrolling, device, and click storage |
| `worker/index.js` | Replace the current code in your Cloudflare Worker |
| `js/analytics.js` | Keep this file in your GitHub Pages website repository |

Complete the following steps in order.

## Step 1: Update the D1 database

This adds the new engagement tables and device column. It does not delete or
change your existing traffic records.

1. Sign in to the [Cloudflare dashboard](https://dash.cloudflare.com/).
2. Open **Storage & Databases**, then **D1 SQL Database**.
3. Select the database used by your `overseer` Worker.
4. Open the **Console** tab.
5. On your computer, open `worker/migration-engagement-metrics.sql`.
6. Copy everything in that file.
7. Paste it into the D1 Console.
8. Select **Execute**.
9. Wait for Cloudflare to report that the commands succeeded.

Run `migration-engagement-metrics.sql` **only once**. Running it again will
produce errors such as
`duplicate column name`, because the columns already exist. If you see that
message on your first attempt, stop instead of repeatedly running the SQL; the
migration may already have been applied.

You already ran `migration-session-grouping.sql` when session grouping was set
up. Do not run that older migration again.

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

Do not paste either SQL migration into the Worker editor. The Worker editor
receives only the contents of `worker/index.js`.

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
track. It is already present on the main pages and several project-detail pages.

## Step 4: Test the result

1. Open your portfolio home page in a private/incognito browser window.
2. Stay on it for at least 20 seconds and scroll partway down.
3. Open the projects page from the same window.
4. Click one of the résumé, email, or GitHub links. You can close the destination
   after it opens.
5. Open
   [https://overseer.matthewzhou05.workers.dev/admin](https://overseer.matthewzhou05.workers.dev/admin).
6. Select **Refresh**.

You should see one new row with:

- **Views** equal to `2`;
- the home page and projects page listed under **Pages**;
- an **Active time** value;
- a desktop, mobile, or tablet **Device** value;
- reading time and scroll depth beside the page; and
- the click under **Tracked clicks**;
- an earlier **First seen** time; and
- a later **Last seen** time.

Refreshing or revisiting a page within 30 minutes should increase **Views** on
the same row. After a gap of at least 30 minutes, a new page view should create a
new row.

Old records will still appear. Because they were created before session
tracking existed, each old record appears as a one-view session.

## Step 5: Receive a daily email without owning a domain

Cloudflare's built-in email sender requires a custom domain. Because this site
does not have one, the Worker uses [Resend](https://resend.com/) instead. Resend
allows its test sender, `onboarding@resend.dev`, to email the address belonging
to your own Resend account. It cannot email other people without a custom
domain, which is fine for this private report.

The email is scheduled for approximately **11:59 p.m. Eastern Time every day**.
It summarizes the visitor sessions that started that day, total page views,
active reading time, scroll depth, tracked clicks, device types, popular pages,
and visitor locations.

### A. Create the Resend account and API key

1. Go to [Resend](https://resend.com/) and create an account using the email
   address where you want to receive the daily report.
2. Verify that email address if Resend asks you to do so.
3. In the Resend dashboard, open **API Keys**.
4. Select **Create API Key**.
5. Name it `portfolio-daily-report` and give it sending access.
6. Create the key and copy it immediately. It begins with `re_` and Resend may
   show it only once.

Do not paste this API key into `worker/index.js`, `js/analytics.js`, GitHub, or
any public file.

### B. Save the email settings privately in Cloudflare

1. In Cloudflare, open **Workers & Pages** and select `overseer`.
2. Open **Settings**, then find **Variables and Secrets**.
3. Add a secret named exactly `RESEND_API_KEY`.
4. Paste the `re_...` API key as its value and save it.
5. Add another secret named exactly `REPORT_TO`.
6. Use the same email address you used to create the Resend account as its
   value, then save it.

Both names are uppercase and must be entered exactly as shown.

### C. Deploy the Worker code again

The daily-report code is included in `worker/index.js`. Repeat Step 2 above:
copy all of `worker/index.js`, replace the existing `overseer` Worker code, and
select **Deploy**.

No additional D1 SQL is needed for the email report.

### D. Add the daily schedules

Cloudflare schedules use UTC instead of Eastern Time. Add both schedules below
so the report continues to arrive at 11:59 p.m. when daylight-saving time
changes. The Worker checks Eastern Time and ignores whichever schedule is not
11:59 p.m.

1. Open the `overseer` Worker in Cloudflare.
2. Go to **Settings**, **Triggers**, then **Cron Triggers**.
3. Add this Cron Trigger:

   ```text
   59 3 * * *
   ```

4. Add a second Cron Trigger:

   ```text
   59 4 * * *
   ```

5. Save both triggers. Cloudflare says new schedules can take up to 15 minutes
   to become active.

The first report should arrive close to 11:59 p.m. Eastern Time. It will still
send when the site had no visitors, showing zero sessions and zero page views.

If Resend reports that the recipient is not allowed, make sure `REPORT_TO` is
exactly the email address attached to your Resend account. The no-domain sender
cannot send to a different address.

## If something goes wrong

### The website still creates a separate row for every page

- Make sure the updated `js/analytics.js` is live on GitHub Pages, not only on
  your computer.
- In your browser, reload the site while bypassing its cache. On Windows, try
  `Ctrl+F5`.
- Confirm the Worker code was deployed, not merely saved in the editor.

### The Worker reports a missing column

The D1 migration was not completed. Return to Step 1 and run
`migration-engagement-metrics.sql` in the correct database. If the error names
an older session column such as `session_id`, the original
`migration-session-grouping.sql` was not completed.

### D1 says "Requests without any query are not supported"

This can happen if the SQL was pasted as one line beginning with a `--` comment.
The current migration file contains only SQL commands, so copy it again, paste
it into the empty box at the bottom of the D1 Console, and select **Execute**.

### The Worker reports that `DB` is undefined

The D1 binding is missing or has a different name. Follow **Check the database
connection** above and make sure the binding is named `DB`.

### The scheduled report does not arrive

- Check your spam or junk folder.
- Confirm both `RESEND_API_KEY` and `REPORT_TO` exist under the Worker's
  **Variables and Secrets**.
- Confirm both Cron Triggers from Step 5 are present.
- Confirm the updated Worker code was deployed after Step 5.
- In Resend, open **Emails** or **Logs** to see whether the send succeeded or
  produced an error.

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
