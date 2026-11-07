# Coven

Coven is a foundation for handing over secrets when enough of the right people agree. Two local demo apps are built on it:

- **Last Light** (personal): a vault handed to trustees after the owner stops checking in and a quorum of trustees acts together.
- **Break Glass** (team): one emergency credential released to one requester after a quorum of approvers agrees on that same petition.

All people, credentials and letters in the demos are fictional.

## What Coven guarantees, and what it does not

Your keyholders can open what they hold shares for whenever enough of them agree. Coven makes the right moment obvious, orderly and recorded. It does not make the wrong moment impossible.

- Items are encrypted in the browser, each under its own key. Keys are split with Shamir sharing (`shamir-secret-sharing` 0.0.4, audited by Cure53 and Zellic; the Coven protocol as a whole is not independently audited).
- Anyone with k valid shares and the exported bundle can recover offline at any time. The online service only decides when it starts and completes a handover, whom it notifies, and what it serves and records.
- Last Light: a missed check-in starts a grace period. It is a signal, not proof of death. Any check-in before release cancels the handover. Earliest release dates are online policy only. "Deliver to" names are routing labels. Trustees who rebuild the vault key can open the whole vault.
- Break Glass: a release exposes only one seal version of one item to its requester. The retrieval link stops working at its expiry. Anything already copied or downloaded stays usable after that. The credential stays valid until it is rotated in the system that issued it, so a release always records "rotation required".
- Plaintext privacy assumes unmodified client code and authenticated key exchange. The MVP trusts the authenticated service to bind identities to public keys and to enforce release policy. A compromised web origin, browser extension or build can expose keys. The offline tool is a separate recovery path.

The full contract is [`.kiro/steering/guarantees.md`](.kiro/steering/guarantees.md).

## Layout

| Path | What it is |
|---|---|
| `core-ts/` | One TypeScript crypto core used by the browsers and the Node offline tool: envelopes, keys, shares and card encodings, vault helpers, bundle, records, release verification |
| `core-ts/bin/recover.js` | Offline recovery tool |
| `service/` | Python FastAPI service: petitions, Last Light lifecycle, records and receipts, demo mail, demo clock. Stores ciphertext and workflow metadata only |
| `ui-kit/` | Shared client flows, key storage (IndexedDB) and React components |
| `apps/last-light/`, `apps/break-glass/` | The two apps (Vite + React) |
| `e2e/` | Playwright tests that drive both apps |
| `.kiro/` | Kiro steering and specs |

## Run the demos locally

Needs Node 22.6 or newer, Python 3.12 and [uv](https://docs.astral.sh/uv/).

```sh
npm install
npm run setup:service     # creates service/.venv from service/requirements.txt
npm run build             # builds both apps
```

Then start three processes, each in its own terminal:

```sh
npm run service           # API on http://127.0.0.1:8787
npm run last-light        # http://127.0.0.1:5173
npm run break-glass       # http://127.0.0.1:5174
```

Everything binds to 127.0.0.1. The apps proxy `/api` to the service and are served with a strict content security policy.

**Break Glass walkthrough.** Click "Set up demo". Switch to Robin and open a petition. Switch to Sage and approve; a second approval from Sage does not count, and Robin still cannot retrieve. Switch to Rowan and approve. Switch back to Robin and retrieve: only that item opens, in the browser. The item now shows "rotation required". Use "+30 min" on the demo clock to see an unretrieved petition expire. As Quinn, reseal an item to see open petitions on the old version invalidated.

**Last Light walkthrough.** As Mara, click "Set up demo". Switch to a trustee and "Show my card", then "Print card". Back as Mara, advance the demo clock to Flicker and Vigil and check in to cancel. Advance to Handover (+30 days twice). As Ada, open a recovery and use the stored share. As Bram, type the word code from his card. As Cleo, use the stored share. As Ada, rebuild the vault key: the letters open and the dated letter stays held online. Download the bundle.

**Offline recovery.** Stop the service, then:

```sh
node core-ts/bin/recover.js last-light-bundle-XXXX.json
# paste three share codes (QR text or word code), one per line, then an empty line
node core-ts/bin/recover.js verify last-light-bundle-XXXX.json --receipt <length>:<head>
```

"Reset demo" deletes all demo data and this browser's demo keys. One browser plays every persona; that is a demo simplification.

## Tests

```sh
npm test                  # core-ts (node:test + fast-check), service (pytest + Hypothesis), API end-to-end, scanner and AG-02 fixtures
npm run typecheck
npx playwright install chromium && npm run e2e   # browser tests for both apps
```

## License

MIT. See [LICENSE](LICENSE).
