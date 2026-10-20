# Publishing and updates

How a new CertScanner version reaches users through the Chrome Web Store, the one-time setup, and the release pipeline in `.github/workflows/`. Facts checked on 2026-10-19 (sources at the end); re-check the dashboard steps when you do them, Google renames them often.

## How updates reach users

- **Store installs update by themselves.** Chrome checks for updates at startup and every few hours, downloads the new version and installs it once the extension is idle. An open side panel keeps CertScanner busy, so the update can wait until the panel closes or Chrome restarts.
- **Every upload needs a higher `version`** (1 to 4 numbers, each 0 to 65535). `npm version` raises it in `package.json` and `src/manifest.json` together; `npm run check` refuses a mismatch.
- **Each version is reviewed** before it goes live: usually within a few days, sometimes weeks. Broad host access and new permissions make reviews slower.
- **New permissions:** an update that adds a required permission with a warning disables the extension until each user accepts it. Optional permissions (`optional_permissions`, `optional_host_permissions`, asked when the user clicks) never do. Keep new access optional.
- **Unpacked installs** (the `extension/` folder, "Load unpacked") never update and have a different extension ID than the Store version. Their settings and history don't move over: those users remove the unpacked copy and install from the Store.

## One-time setup

1. **Developer account.** Register at the Chrome Web Store Developer Dashboard (one-time US$5 fee) and turn on 2-Step Verification for the Google account; publishing requires it.
2. **Store listing and privacy answers.** Write the single purpose, description, permission justifications and data-use answers from [`PRIVACY.md`](PRIVACY.md): the cert number goes to the grader's page (and to PSA with the user's PSA key), the card name and number go to PokemonPriceTracker with the user's key, links open eBay and PriceCharting searches on a click. Use PRIVACY.md's GitHub address as the privacy policy URL. Since 2026-08-01 every data flow must be disclosed and strictly necessary. Required images: 128×128 icon, at least one 1280×800 screenshot, a 440×280 promo tile.
3. **First upload by hand.** The API cannot create a new item. Run `npm run package` on a clean, committed tree, upload `certscanner-<version>.zip` in the dashboard, fill in the listing, privacy and distribution tabs, and submit. Note the **extension ID** (item ID) and your **publisher ID** (dashboard → Account).
4. **Google Cloud OAuth client** for the Chrome Web Store API:
   1. Create a project at console.cloud.google.com and enable **Chrome Web Store API**.
   2. OAuth consent screen: type External, add yourself, and set the publishing status to **In production**. In "Testing" the refresh token expires after 7 days.
   3. Credentials → Create OAuth client ID → **Desktop app**. Keep the client ID and secret.
   4. Get a refresh token: `npx chrome-webstore-upload-keys` (asks for the client ID and secret and signs you in).
5. **GitHub settings** (repository → Settings):
   - Environments → New environment **`chrome-web-store`**. Add yourself under *Required reviewers*, so every Store upload waits for your approval.
   - In that environment, add the secrets **`CWS_CLIENT_ID`**, **`CWS_CLIENT_SECRET`** and **`CWS_REFRESH_TOKEN`**.
   - Secrets and variables → Actions → Variables: **`CWS_PUBLISHER_ID`**, **`CWS_EXTENSION_ID`**, and optionally **`CWS_PUBLISH_TYPE`**: `DEFAULT_PUBLISH` (live as soon as it is approved, the default) or `STAGED_PUBLISH` (after approval you press Publish in the dashboard within 30 days).

Until step 5 is done the release workflow still builds, tests and creates the GitHub Release; the Store step reports "not configured" and succeeds.

## Each release

```sh
git switch main && git pull           # clean tree
npm version patch                     # or minor / major: bumps package.json + src/manifest.json, commits, tags vX.Y.Z
git push --follow-tags
```

The tag starts **Release** (`.github/workflows/release.yml`):

1. checks that the tag, `src/manifest.json` and `package.json` agree;
2. runs the unit tests, the release check (`npm run package`) and the browser tests;
3. attaches `certscanner-<version>.zip` and its sha256 to a GitHub Release with generated notes;
4. after your approval of the `chrome-web-store` environment, uploads the ZIP with the Chrome Web Store API v2 (`scripts/cws-publish.mjs`) and submits it for review.

Every push to `main` runs **CI** (unit tests and the release check). The browser tests run on pull requests, in each release, and on demand (Actions → CI → Run workflow).

Also run `npm run build:extension` and commit `extension/` while unpacked users remain.

## When something goes wrong

| Situation | What to do |
|---|---|
| A submission is still in review | The Store accepts no new package until it is done. Wait, or cancel it in the dashboard (at most 6 cancels a day), then re-run the failed job. |
| "Upload FAILED" | Usually a version that is not higher than the last upload. Make a new version with `npm version patch`. |
| `invalid_grant` from Google | The refresh token expired or was revoked (consent screen still in "Testing", or password change). Make a new one (setup step 4.4) and replace `CWS_REFRESH_TOKEN`. |
| Rejected in review | The dashboard says why. Fix it, make a new version, push the tag. |
| A bad version is live | Dashboard → the item → **Rollback**: the previous version goes live again under a new, higher version number within about a minute, without review, and reaches users through normal updates. Then fix the problem and release a version above the rollback's number. |
| Browser tests fail only in CI | Download the `e2e-output` artifact of the run. OCR timing is slower on shared runners; re-run once before treating it as a real failure. |

Percentage rollouts through the API only exist for items with more than 10,000 weekly users.

## Sources (checked 2026-10-19)

- Chrome Web Store API v2: discovery document `https://chromewebstore.googleapis.com/$discovery/rest?version=v2` (revision 20261014: `upload`, `publish` with `DEFAULT_PUBLISH`/`STAGED_PUBLISH`, `fetchStatus`, `cancelSubmission`, `setPublishedDeployPercentage`); <https://developer.chrome.com/blog/cws-api-v2>; v1.1 end of support: <https://developer.chrome.com/docs/webstore/api/v1>
- Using the API, OAuth client: <https://developer.chrome.com/docs/webstore/using-api>; refresh-token expiry in "Testing": <https://developers.google.com/identity/protocols/oauth2>; <https://github.com/fregante/chrome-webstore-upload-keys>
- Update lifecycle (idle, every few hours): <https://developer.chrome.com/docs/extensions/develop/concepts/extensions-update-lifecycle>
- Permission warnings on update: <https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings>
- Version format: <https://developer.chrome.com/docs/extensions/reference/manifest/version>
- Review process and 2026 changes: <https://developer.chrome.com/docs/webstore/review-process>, <https://developer.chrome.com/blog/cws-review-updates-2026>, <https://developer.chrome.com/blog/cws-policy-updates-2026>
- Publishing, deferred publish (30 days), cancel review, rollback: <https://developer.chrome.com/docs/webstore/publish>, <https://developer.chrome.com/docs/webstore/cancel-review>, <https://developer.chrome.com/docs/webstore/rollback>
- Registration and images: <https://developer.chrome.com/docs/webstore/register>, <https://developer.chrome.com/docs/webstore/images>
