# Sources and connectors

## Built-in sources

| Source | Key | How it is read | Default | Checked every | Gap between requests |
| --- | --- | --- | --- | --- | --- |
| Find a Tender (UK) | `find-a-tender` | Official OCDS API | On | 3 hours | 11 s |
| Contracts Finder (UK) | `contracts-finder` | Official OCDS API | On | 3 hours | 1 s |
| Public Contracts Scotland | `public-contracts-scotland` | Official OCDS API | On | 6 hours | 2 s |
| Sell2Wales | `sell2wales` | Official OCDS API | On | 6 hours | 2 s |
| TED (EU tenders) | `ted` | Official search API | Off | 6 hours | 2 s |
| SAM.gov (US federal) | `sam-gov` | Official API, needs a key | Off | 24 hours | 2 s |
| Find a Grant (GOV.UK) | `find-a-grant` | Public listing pages | On | 12 hours | 2 s |
| Innovate UK competitions | `innovate-uk` | Public listing pages | On | 12 hours | 2 s |
| UKRI Funding Finder | `ukri` | Public listing pages | On | 12 hours | 2 s |

The administrator can switch each one on or off, change how often it runs, run it now, and see its recent runs and errors on the Admin page.

**TED** is off by default because it is large. Switch it on and, ideally, narrow it with the "Extra query filter" setting, for example `classification-cpv IN (71000000 42000000) AND buyer-country IN (IRL NLD DEU)`.

**SAM.gov** needs a free API key from your SAM.gov account (Account Details, then Public API Key). Add it under Admin, Credentials as an API key, attach it to the SAM.gov source and switch the source on. Personal keys allow only a few requests a day, so it runs once a day and takes at most five pages.

## How politely sources are fetched

Bid Finder is meant to be a good citizen, so every outbound request goes through one client (`src/http/client.js`) that:

- identifies itself with a `BidFinder/<version>` User-Agent containing your site's address, so an operator can get in touch;
- spaces requests to each host by the gap shown above, and runs sources one after another, never in parallel;
- retries failures with increasing waits and obeys `Retry-After`;
- asks for only what changed since the last successful run where the API supports it.

**robots.txt.** Listing-page scrapers and every source you add yourself obey the site's robots.txt, including its crawl delay. If robots.txt disallows a page, the run fails with a message saying so and nothing is fetched. Documented official APIs are called as their publishers intend and are not subject to robots.txt, which governs crawling of web pages.

**Terms of use.** The official APIs above are published for this purpose under open licences (the UK ones under the Open Government Licence). For a private portal, you are using your own account under that portal's terms, so check that they allow automated access before adding it. Bid Finder never tries to get round a login, a CAPTCHA or a block.

## Adding your own sources

Admin, then "Add a source". No code is needed.

### A feed

Many portals publish RSS or Atom. Give the feed's address. Closing dates and values are picked out of the text where the feed has no field for them. If the feed needs a key, attach a credential (below).

### A listing page

For a portal with no feed, give the address of the page that lists opportunities and a CSS selector that matches each one. Optional selectors pick out the title, link, closing date, buyer, summary, value and the next-page link. "Test" fetches the first page and shows what was found without saving anything.

### A portal behind a login

Fill in the sign-in page address on a listing-page source and attach a username and password credential. Bid Finder loads the sign-in form, fills it in (including any hidden anti-forgery fields), keeps the session cookie and then reads the listing pages. This works for ordinary form logins. It does not work for portals that require single sign-on, a one-time code or a CAPTCHA.

### Credentials

Admin, then Credentials. Three kinds:

- **Login**: a username and password for a form login.
- **API key**: sent the way the source expects (SAM.gov, or a feed's query string).
- **Header**: a header name and value, for example `Authorization: Bearer ...`, sent with each request.

Secrets are encrypted with AES-256-GCM using `BIDFINDER_SECRET_KEY` before they reach the database, are never shown again after saving, and are stripped from error messages.

Addresses that resolve to private or local networks are refused for sources you add, including after redirects, so a source cannot be pointed at something inside your own network.

## One notice on several portals

A Scottish tender often appears on Public Contracts Scotland, Find a Tender and TED. Notices with the same normalised title, buyer and closing day are treated as one: the first copy seen is shown, and its page lists the others under "Also published on".

## Writing a connector

A connector is a module exporting one object:

```js
export const myPortal = {
  key: 'my-portal',            // unique, used in URLs and the CLI
  name: 'My Portal',
  type: 'tender',              // or 'grant'
  access: 'Official API',      // shown to the administrator
  homepage: 'https://portal.example',
  intervalMinutes: 360,
  minDelayMs: 2000,
  respectRobots: false,        // true for anything that reads web pages
  enabledByDefault: true,
  settings: [],                // optional fields the administrator can fill in
  async fetch({ get, request, since, maxPages, config, credential }) {
    // Use the get/request you are given: they throttle, retry and identify us.
    // Return an array of opportunities.
  },
};
```

Each opportunity has `external_id`, `title`, `summary`, `url`, `funder` (the buyer), `location`, `country` (two letters), `cpv_codes`, `notice_type`, `award_min`, `award_max`, `currency`, `opens_at`, `closes_at`, `published_at` (ISO dates) and `eligibility`.

Add it to the list in `src/connectors/index.js`, and add a test that feeds a recorded response to it; see `test/platform.test.js` and `test/fixtures/`. If the portal publishes OCDS, `src/connectors/ocds.js` already does the mapping.

## How the connectors were verified

The connectors are tested against recorded and hand-built fixtures in the format each API documents. The API connectors for Find a Tender, Public Contracts Scotland, Sell2Wales, TED and SAM.gov were written from the publishers' documentation and have not yet been run against the live services from a development machine with access to them. Run `bidfinder ingest <key>` after installing and check the Admin page; an API that has drifted from its documentation shows up there as a clear error for that one source, and does not affect the others.
