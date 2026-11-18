# Sources and connectors

## Built-in sources

Every source below is read through an official API, open-data file or feed where the publisher offers one, and through the publisher's public pages only where it does not. UK sources start switched on; everything else starts off, because several are very large. Switch on the ones that matter to you under Admin, Sources.

### United Kingdom

| Source | Key | How it is read | Default | Checked every | Gap between requests |
| --- | --- | --- | --- | --- | --- |
| Find a Tender | `find-a-tender` | Official OCDS API | On | 3 hours | 11 s |
| Contracts Finder | `contracts-finder` | Official OCDS API | On | 3 hours | 1 s |
| Public Contracts Scotland | `public-contracts-scotland` | Official OCDS API | On | 6 hours | 2 s |
| Sell2Wales | `sell2wales` | Official OCDS API | Off (see below) | 6 hours | 2 s |
| Find a Grant (GOV.UK) | `find-a-grant` | Public listing pages | On | 12 hours | 2 s |
| Innovate UK competitions | `innovate-uk` | Public listing pages | On (see below) | 12 hours | 2 s |
| UKRI Funding Finder | `ukri` | Public listing pages | On | 12 hours | 2 s |

### European Union, centrally and by country

| Source | Key | What it covers | How it is read | Checked every |
| --- | --- | --- | --- | --- |
| TED | `ted` | Every above-threshold public contract in the EU/EEA | Official search API | 6 hours |
| EU Funding & Tenders: grants | `eu-funding` | Horizon Europe, Digital Europe, EIC, LIFE, CEF and the rest, plus third-party ("cascade") funding calls | The portal's public search API | 12 hours |
| EU Funding & Tenders: tenders | `eu-tenders` | Tenders run by the Commission, EU agencies and EU delegations worldwide | The portal's public search API | 12 hours |
| BOAMP (France) | `boamp` | French national and European notices | Official open-data API | 6 hours |
| service.bund.de (Germany) | `service-bund` | Federal, state and municipal tenders | Official RSS feed | 6 hours |
| TenderNed (Netherlands) | `tenderned` | All Dutch public tenders | Official public API | 6 hours |
| Plataforma de Contratación (Spain) | `placsp` | Spain's national procurement platform | Official Atom feed | 6 hours |

### North America

| Source | Key | What it covers | How it is read | Checked every |
| --- | --- | --- | --- | --- |
| SAM.gov | `sam-gov` | US federal contract opportunities, every agency | Public search, or the official API with a key | 12 hours |
| Grants.gov | `grants-gov` | US federal grants, every agency | Official search API | 12 hours |
| CanadaBuys | `canadabuys` | Government of Canada and Crown corporation tenders | Official open-data file | 12 hours |

### Asia-Pacific, Africa and multilateral

| Source | Key | What it covers | How it is read | Checked every |
| --- | --- | --- | --- | --- |
| Japanese Government Procurement (JETRO) | `jetro-japan` | National ministries and agencies, prefectures and designated cities (the government's designated single point of access) | Public data files | 12 hours |
| GETS (New Zealand) | `gets-nz` | NZ government agencies, councils and Crown entities | Public listing pages | 12 hours |
| GeBIZ (Singapore) | `gebiz` | Singapore government | Public listing page (newest only, see below) | 3 hours |
| eTenders (South Africa) | `etenders-za` | National, provincial and municipal tenders | Official OCDS API | 12 hours |
| ESA tenders (esa-star) | `esa-star` | European Space Agency intended and issued tenders | Public portal interface | 12 hours |
| World Bank procurement notices | `world-bank` | Bank-financed projects in every borrowing country, including much of South and South East Asia | Official API | 12 hours |

### Named bodies

A watch follows one organisation across the portals it publishes on, and keeps only its notices.

| Source | Key | Reads |
| --- | --- | --- |
| Watch: Network Rail | `watch-network-rail` | Find a Tender and Contracts Finder, where Network Rail publishes under the Procurement Act 2023 |
| Watch: NASA | `watch-nasa` | Grants.gov (agency NASA) and SAM.gov |
| Watch: US Department of Transportation | `watch-us-dot` | Grants.gov (DOT and its operating administrations: FHWA, FTA, FAA, FRA, NHTSA, MARAD, PHMSA, FMCSA) and SAM.gov |

ESA has its own source above. To follow another body on a portal that has a keyword or buyer setting (SAM.gov, Grants.gov, TED, BOAMP, EU Funding & Tenders), switch that source on and fill in its setting.

The administrator can switch each source on or off, change how often it runs, run it now, and see its recent runs and errors on the Admin page.

**TED** and the other large sources are off by default. Switch them on and, ideally, narrow them with their settings, for example TED's "Extra query filter" `classification-cpv IN (71000000 42000000) AND buyer-country IN (IRL NLD DEU)`.

**Sell2Wales** is off because its API still answers every request with an HTTP 500 server error (checked again November 2026, for every notice type and month). Since the Procurement Act 2023 took effect, Welsh contracting authorities publish their covered notices on Find a Tender, which is on by default, so little is lost. The weekly live check says when Sell2Wales works again.

**Innovate UK.** Its robots.txt address redirects to a sign-in service on a different host, which fails with a server error. The robots.txt standard says a server error means "assume everything is disallowed", which is what Bid Finder did until November 2026. A redirect to someone else's failing sign-in page is not the site stating a crawling policy, though, so for this one source Bid Finder now treats that specific failure as "no robots.txt" and reads the public competition listing slowly (one page every 2 seconds, twice a day). If Innovate UK ever serves a real robots.txt, Bid Finder obeys it. Switch the source off if you would rather not read it. Existing installations keep whatever setting the administrator chose.

**SAM.gov** works without any account: it uses the public search service behind SAM.gov's own search page. If you add a SAM.gov API key (Account Details, then Public API Key) under Admin, Credentials and attach it to the source, it uses the official Get Opportunities API instead, which also supports a NAICS filter. The "Keyword" setting narrows the public search; an agency's full name, in quotes, finds that agency's notices.

**GeBIZ** pages its listing with form postbacks rather than links, so Bid Finder reads the first listing page each run (every 3 hours) and builds up the full picture as opportunities are published, rather than reading the whole back catalogue at once.

**Spain (PLACSP)** publishes changes as a chain of feed files, newest first. Each run reads back to the previous run, so tenders published before you switched the source on appear only when they are next updated.

### Portals looked at and not added (November 2026)

| Portal | Why not |
| --- | --- |
| AusTender (Australia) | Its pages and feeds refuse automated requests (HTTP 403). Its OCDS API covers awarded contracts only, not open tenders |
| China Government Procurement Network (ccgp.gov.cn) | Refuses automated requests and rate-limits after the first page |
| India CPPP / GeM | Needs JavaScript and CAPTCHAs; no public feed |
| Asian Development Bank, UN Global Marketplace | Refuse automated requests (HTTP 403). World Bank notices cover many of the same countries |
| NASA NSPIRES | Loads its list with scripts and has no feed. NASA's solicitations also appear on Grants.gov and SAM.gov, which the NASA watch reads |
| Japan's own procurement portal (p-portal.go.jp) | Japanese only; JETRO's English database covers the same notices |
| Malaysia, Indonesia, Philippines, Thailand national portals | Login, CAPTCHA or Javascript-only listings; World Bank notices cover donor-funded work there |

If you have an account on one of these, the "A portal behind a login" option below may work where the portal uses an ordinary sign-in form.

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

## How the connectors are verified

Each connector has tests against recorded responses (`test/fixtures/`), which run on every change.

They are also checked against the live services. `npm run check:sources` (or `node scripts/check-sources.js find-a-tender ted`) fetches one page from each built-in source, saves nothing, and fails if a source errors or returns opportunities with missing titles, bad links, unreadable dates or impossible values. GitHub Actions runs it every Monday, on demand from the Actions tab, and on any pull request that changes a connector, so a portal changing its API is noticed within a week. Without a `SAM_API_KEY` repository secret, SAM.gov is checked through its public search.

The first live run (November 2026) found:

| Source | Live result |
| --- | --- |
| Find a Tender | Working: every notice had a deadline and CPV codes, most a value |
| Contracts Finder | Working |
| Public Contracts Scotland | Working, after a fix: the site sends its certificate without the intermediate that links it to a trusted root. Bid Finder now completes such chains the way browsers do (see below) |
| TED | Working |
| Find a Grant, UKRI | Working |
| Sell2Wales | Their API fails for every request; switched off |
| Innovate UK | Refused by robots.txt as described above; switched back on once the redirect case was understood (see above) |
| SAM.gov | Checked through public search from the second run onwards |

**Incomplete certificate chains.** Some servers leave out the intermediate certificate. Browsers download it from the address in the server's certificate; Node does not, and refuses to connect. Bid Finder does what browsers do, and accepts the downloaded certificate only if it really issued the server's certificate and is itself signed by a root that Node already trusts. It logs the first time it does this for a site.
