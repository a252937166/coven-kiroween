# Kiroween 2026 — Project Proposal (v4.1, 2026-11-06)

Supersedes `PROPOSAL-v4-coven.md`. This revision resolves the recheck in `REVIEW-2026-11-06-recheck.md` and keeps every resolution from `REVIEW-2026-11-04-CHECK.md`. Section 11 maps both reviews to the sections that resolve them. Rules, the real submission form and the 2025 winners are documented in `RESEARCH.md`.

Status on 2026-11-06: the design is settled; no repository exists yet. The schedule in section 7 starts today.

## 1. Recommendation (unchanged)

**Enter Skeleton Crew with "Coven": a lean, reusable foundation for multi-party handover and offline recovery, demonstrated by two distinct applications, Last Light and Break Glass.**

- **The foundation:** browser-side encryption of items; keys split into shares that keyholders hold digitally or on printed cards; an online handover workflow driven by one of two lifecycles (a lapsed check-in with a grace period, or a request with approvals); an asynchronous recovery in which any k of n keyholders submit shares and a key is rebuilt in a browser that is entitled to it; a verifiable record of events with a stated trust reference; and an exported bundle that a small offline tool can open with enough valid shares.
- **Last Light (personal, lapse-triggered):** letters, keys and wishes for the people you choose, handed over when your check-ins stop and your trustees gather.
- **Break Glass (team, request-triggered):** emergency credentials for a small team, released one item at a time to a requester for a time-limited retrieval window when enough approvers agree, with reasons, records and rotation tracking.

The template ships its own Kiro configuration (steering, hooks, custom agents, spec templates, a workflow and a custom power), so a developer who clones it inherits a safe way to build the next handover app. Positioning rests on usable handover, recoverability and developer reuse, not on claims that nothing comparable exists.

## 2. What the product guarantees, and what it does not

This section is the contract that specs, copy, README and video must all follow.

**Two layers.**

1. **Cryptographic access.** Items are encrypted in the browser. Keys are split into shares with threshold k. Anyone holding the exported bundle plus any k valid shares for a key can rebuild that key and read what it protects, anywhere, at any time, with or without the service. This is deliberate: it is how a vault outlives the company. It also means the quorum is trusted; mathematics does not stop k keyholders from acting early.
2. **Workflow policy.** The online service decides when it *initiates* a handover, whom it notifies, what it shows and what it records. Lifecycle conditions (lapse plus grace period plus quorum; or approvals inside a request window) are enforced by the service, not by cryptography.

**Trusted-client assumption.** Plaintext stays private only if the client code is the code we published and the key exchange is authenticated. A compromised web origin, a malicious browser extension or a tampered build can replace the code that handles keys; this is true of every browser-based encryption product. Mitigations: pinned dependencies, a strict content security policy, subresource integrity for served scripts, reproducible open-source builds, and the offline tool as an independent path. The threat model states this plainly rather than claiming the server "can never" read plaintext in the abstract.

**Plain-language promise used everywhere:** "Your keyholders can open what they hold shares for whenever enough of them agree. Coven's job is to make the right moment obvious, orderly and recorded, not to make the wrong moment impossible."

**Consequences adopted.**

- Missed check-ins start a handover process; they are a signal, not proof of death. Any check-in before release cancels the pending handover.
- Date-based release is an online policy only. Cryptographically enforced date release is deferred; timelock encryption is roadmap research, not a promise.
- Recipient names on Last Light items are routing labels; per-recipient cryptographic isolation is an extension, not a first-release claim.
- Break Glass never releases a whole vault. Each credential has its own key, and approvals release exactly one item to exactly one petition (section 4.2).
- The threat model states what a quorum can do with the bundle and shares, what a single keyholder can do (nothing), and what the service operator can do (deny or delay service, alter unsigned records, serve modified client code if the origin is compromised; never read plaintext from stored ciphertext alone).

## 3. The foundation

### 3.1 Layout, lean enough to be clear

```
coven/
  core-ts/                TypeScript library used by the browser client AND the offline CLI
    envelope.ts           AES-256-GCM via WebCrypto (Node: webcrypto); per-item keys; associated data = vault id,
                          item id, format version; vault header check
    keys.ts               keyholder key pairs (ECDH P-256), passphrase wrapping (PBKDF2 via WebCrypto),
                          ephemeral session keys for recoveries and petitions
    shares.ts             Shamir via the audited shamir-secret-sharing library (GF(2^8)); vault-level and
                          item-level sharing; encodings: QR payload "coven1:..." and a word code with checksum
    bundle.ts             export/import of the versioned bundle "coven/v1"; receipt verification
    recover-cli.ts        the offline tool: node recover.js bundle.json --share ... --share ...
  service/                Python, FastAPI: lifecycle state machines, petitions and approvals, notifications and
                          demo mail viewer, scheduling, records and receipts, binder PDF generation
  ui-kit/                 shared React components and theme tokens; browser-local share-card printing
  apps/
    last-light/           application one (separate folder, deployable)
    break-glass/          application two (separate folder, deployable)
  scaffold/               "coven new <app>" copies the app template and wires its spec
  docs/                   architecture, threat model, format spec, how to add an app (Markdown in-repo)
  .kiro/                  shipped Kiro configuration (section 6)
```

One cryptographic implementation, used in two environments (browser and Node). The Python service never touches shares, item keys or plaintext. Privy's library works in GF(2^8) and PyCryptodome's Shamir in GF(2^128) on 16-byte secrets, so a Python implementation could never read the same shares; the offline CLI is therefore Node-based and built from `core-ts`.

Cryptography rules: no homegrown primitives. Envelopes use WebCrypto AES-256-GCM with associated data. Shares use Privy's `shamir-secret-sharing`, which has published audits by Cure53 (April 2023) and Zellic (2023); the pinned version and audit links are recorded in `docs/threat-model.md` without implying that the whole Coven protocol has been audited. Because the library does not verify a reconstructed secret, every protected key has an authenticated header envelope; decryption of that header must succeed before any item is decrypted, so wrong, duplicate, malformed or foreign-bundle shares fail safely.

### 3.2 Vocabulary

- **Item key:** each item is encrypted under its own key (envelope encryption).
- **Vault key:** wraps the item keys of a vault. Rebuilding it opens the whole vault.
- **Keyholders:** the n people holding shares; **quorum:** any k of them. Each keyholder has a long-term key pair; the private key is wrapped by a passphrase and stored as ciphertext so it works on any device.
- **Two sharing modes on the same primitives.** *Vault-level:* the vault key is split; used by Last Light, where the whole vault is handed over and shares may be printed. *Item-level:* each item key is split separately among approvers; used by Break Glass, where only one approved item may ever be released. Same split, same combine, same encodings, same encrypt-to-ephemeral-key hand-off.
- **Shares:** digital (encrypted to a keyholder's long-term key) or printed (a card carrying the share as a QR payload and a word code).
- **Lifecycle:** what starts a handover online. *Lantern:* periodic check-ins; a lapse opens a grace period (the vigil); its end triggers the handover. *Petition:* a request for one item with a reason and a window; approvals inside the window trigger release.
- **Recovery:** the asynchronous quorum step. Keyholders submit shares encrypted to the ephemeral public key of the browser entitled to rebuild the key (the recovering trustee in Last Light; the requester in Break Glass); the service relays ciphertext only.
- **Record:** the append-only hash chain of events plus the receipts keyholders retain (section 3.4).
- **Bundle:** an exported archive (envelopes, headers, format version, record snapshot) that the offline CLI opens with k shares.

### 3.3 Release policy and petition binding

Items carry three fixed fields: *deliver to* (labels), *earliest release date* (policy, optional) and *lifecycle* (the app's). There is no general rule language.

- **Lantern:** Lit, Flicker, Vigil, Released. Time moves forward only. A check-in in Lit, Flicker or Vigil returns to Lit and cancels any pending handover. Released requires lapse, elapsed vigil and quorum.
- **Petition:** Open, Approved, Released, Expired, Denied. Each approver counts once. Released requires quorum inside the window. Expired and Denied are terminal; a new release needs a new petition.
- **Binding:** a petition names one item, one requester and the requester's ephemeral public key. Every approval envelope carries, as associated data, the petition id, the item id and the fingerprint of that public key. An approval for petition A cannot be replayed for petition B, cannot be redirected to another requester, and cannot unlock another item.

### 3.4 Records and their verification boundary

The service keeps an append-only hash chain of events. A hash chain alone only proves internal consistency, so Coven defines the trusted reference: a **receipt** is the chain length and head hash at a moment in time. Receipts are printed on share cards at issuance, included in handover and release notifications, and downloadable at any time.

What a verifier can conclude from a receipt (length N, head hash H) and the current chain, and nothing more:

- **Consistent:** the first N entries hash to H.
- **Witnessed prefix altered:** the first N entries no longer hash to H. One or more entries up to position N were changed, removed or reordered; the verifier cannot say which from the receipt alone.
- **Truncated:** the chain is shorter than N.

Entry-level localization is possible only when the verifier holds a prior full copy; the offline tool keeps the record snapshot from the bundle for that purpose and reports a diff against it. A complete rewrite is not detectable without a receipt or copy retained outside the service. Documentation separates corruption detection from resistance to a compromised operator. Server signatures are a possible later addition that adds operator accountability, not protection against the operator. Offline recoveries produce a local record file; they do not appear in the online chain unless uploaded.

### 3.5 Printed artifacts

| Artifact | Content | Where it is generated |
|---|---|---|
| Share card | One sensitive recovery share (QR and word code), the vault name, the keyholder's name, the receipt at issuance, and a visible "contains a recovery share, store like a key" notice | In the browser only; printed from a local view or a client-side PDF; never sent to the service or logs |
| Executor binder | Who the keyholders are, what to do first, how recovery works, where the bundle is kept; no share, key or ciphertext | Service-generated PDF, checked by a test that scans text, embedded objects, images and metadata for share patterns |

The "no secrets" invariant applies to the binder only.

### 3.6 Invariants, written as EARS requirements and checked by tests

TypeScript (fast-check, written by Kiro) on `core-ts`:
1. For either sharing mode, any k distinct valid shares rebuild the key and pass its header check; any k−1 shares plus one wrong, duplicate, malformed or foreign share fail the header check and nothing is decrypted.
2. Encrypt then decrypt is identity; any bit flip in ciphertext or associated data fails authentication.
3. Share encodings round-trip; the checksum detects any single-symbol error in the word code.
4. Bundles exported in the browser open in the Node CLI with valid shares; CLI-created fixtures open in the browser (cross-environment compatibility of one implementation).
5. An approval envelope bound to one petition fails authentication under any other petition id, item id or requester key fingerprint.

Python (Kiro property-based testing with Hypothesis) on `service`:
6. Lantern and Petition transitions as specified in 3.3, including cancel-on-check-in and once-per-approver counting.
7. After a petition's window ends, the service refuses to serve its approval envelopes and item ciphertext, and refuses to reopen it.
8. The next check-in is never in the past, respects the cadence, and keeps wall-clock time across daylight-saving changes.
9. Receipt verification returns exactly one of consistent, witnessed prefix altered, or truncated, as defined in 3.4; the chain is strictly ordered.
10. The binder contains no share, key or ciphertext material.

Property tests are presented as evidence about specified behavior, not as proof of system security.

## 4. The two applications

### 4.1 Last Light (personal, Lantern, vault-level shares)

Create a vault, choose trustees (for example 3 of 5), print their share cards from your own browser, seal letters and hand-over notes with recipient labels and optional earliest dates, and keep the lantern lit with a check-in every 30, 60 or 90 days. A missed check-in flickers the lantern and starts the vigil (default 14 days); any check-in relights it and cancels the pending handover. When the vigil ends, trustees are notified; one trustee opens a recovery, the others submit shares encrypted to that trustee's ephemeral key, and the vault key is rebuilt in that browser; items are shown by their labels and dates; every step is recorded and receipts are sent. The executor binder tells the family what to do without containing a secret. Demo mode ships a fictional family, a clearly labelled clock control that accelerates waiting only (share processing, state transitions, decryption and verification execute for real), and an in-app mail viewer so judges never depend on real email.

### 4.2 Break Glass (team, Petition, item-level shares)

**Sealing.** An administrator seals each emergency credential (a root password, recovery codes, a signing key) as its own item. The item key is split among the approvers (for example 2 of 4) and each share is encrypted to that approver's long-term key. The service stores only ciphertext.

**Petition.** During an incident, an engineer opens a petition for one named item with a reason and a requested window. The requester's browser generates an ephemeral key pair for this petition; the public key is stored with the petition and shown to approvers as a fingerprint.

**Approval.** Each approver's client decrypts its share for that item and re-encrypts it to the requester's petition key, with the petition id, item id and key fingerprint as associated data. Duplicate approvals by the same approver do not count.

**Release.** At quorum, inside the window, the requester's browser combines the approver shares, rebuilds only that item's key, checks the item header, and decrypts the item. Nobody reconstructs the vault key, and no other item can be opened: the requester never receives shares for anything but the approved item, and an approval cannot be redirected (invariant 5).

**Expiry and rotation.** The retrieval window is time-limited: when it ends, the service refuses to serve the approval envelopes and the item ciphertext (invariant 7), the requester's ephemeral private key is discarded, and a new release needs a new petition. The post-release state is "rotation required" until a teammate confirms rotation. The product says plainly that a copied static secret stays valid until rotated; nothing implies that closing a page revokes anything. Drills (a quarterly check that each approver still holds working shares) are optional and can be removed without breaking the request, approval, release and record flow. Dynamic, self-expiring credentials are out of scope unless a downstream service's expiry is implemented and demonstrated.

### 4.3 Why the two are distinct, and the optional third

Different trigger (lapse versus request), audience (family versus team), pace (months versus minutes), sharing mode (vault-level with printed cards versus item-level digital shares) and screens, on one maintained core. A classroom time capsule (open on a date with any 3 of 5 keyholders) is kept in `docs/extending.md` as a worked extension example. It is not a third complete application, it is not generated live in the video, and it does not claim role constraints that ordinary k-of-n sharing cannot enforce.

## 5. Scope for this submission

| Keep | Deferred |
|---|---|
| Browser encryption, per-item keys, one versioned share format | A second, independent cryptographic implementation |
| Asynchronous multi-party recovery in both sharing modes | A live ceremony room |
| Last Light check-in, vigil, cancel-on-check-in, handover | Cryptographically enforced date release; per-recipient isolation |
| Break Glass petition, bound approvals, single-item release, retrieval window, rotation tracking | Automatic expiry of static credentials; dynamic secret leases |
| Records with receipts and the three-outcome verifier | "Tamper-proof" claims; server signatures |
| Exported bundle and the Node offline recovery tool | A third complete application |
| Shared UI kit, readable template, `coven new`, in-repo docs | A general rule language; a separate documentation site |
| A small set of real Kiro integrations with evidence | The Crew app and scheduled Web automation |

Neither application's main flow may be stubbed to protect an optional feature. Anything cut is also removed from the pitch and the video.

### Product acceptance scenarios

1. **Last Light:** create a fictional vault, distribute shares, seal a letter, advance the demo clock, show a vigil check-in cancelling the handover, then run a separate valid recovery with a quorum.
2. **Break Glass:** open a petition for one item, show that insufficient and duplicate approvals cannot complete it, obtain the required approvals, retrieve that item inside the window, confirm no other item is readable, record the rotation follow-up.
3. **Expiry:** let a petition's window end and show that the issued retrieval link fails and the online flow refuses a new release from it.
4. **Recovery:** export a bundle, disconnect from the service, recover with the offline tool and enough valid shares; show wrong and duplicate shares being rejected; verify the record against a receipt and against the bundle's snapshot.
5. **Reuse:** point at the shared core used by both apps and make one small, documented configuration or extension change.

## 6. Kiro plan: the template ships its own Kiro configuration

```
.kiro/
  steering/   product.md  tech.md  structure.md
              guarantees.md               always: the contract from section 2, verbatim
              crypto-rules.md             fileMatch: core-ts/**  (WebCrypto only, AAD on every envelope, header check before items,
                                          per-item keys, no shares or keys to the service)
              lifecycle-invariants.md     fileMatch: service/lifecycle/**, service/petitions/**
              records-boundary.md         fileMatch: service/records/**, core-ts/bundle.ts
              ui-kit-usage.md             fileMatch: apps/**/*.tsx, ui-kit/**
              release-checklist.md        manual -> /release-checklist
              demo-evidence.md            manual -> /demo-evidence
  specs/      01-format-and-envelope/ 02-keys-shares-and-cards/ 03-bundle-and-offline-recovery/
              04-lantern-lifecycle/ 05-petition-lifecycle-and-binding/ 06-recovery-flow/ 07-records-and-receipts/
              08-notify-and-mailviewer/ 09-binder-pdf/ 10-app-last-light/ 11-app-break-glass/
              12-scaffolder/ bugfix-*/   _templates/new-app-requirements.md
  hooks/      protected-files.json   PreToolUse, matcher: the "write" tool category; the command reads tool_input from
                                     stdin and blocks paths matching .env*, *.pem, secrets/**, fixtures/real/**;
                                     tested against every write route the project allows
              core-ts-quality.json   PostFileSave core-ts/**: typecheck, lint, fast-check suite for the module
              service-quality.json   PostFileSave service/**: ruff, mypy, pytest for the module
              new-app-threat.json    FileCreate apps/*/app.py: agent drafts a STRIDE entry in docs/threat-model/
              task-log.json          PostTaskExecution: docs/KIRO_LOG.md and CHANGELOG.md
              security-on-stop.json  Stop, confirm: bandit, semgrep, the acceptance smoke suite
  agents/     app-scaffolder.md  threat-modeler.md  crypto-reviewer.json  privacy-reviewer.json  release-manager.json
              (every agent lists "file://.kiro/steering/**/*.md" in resources; custom agents do not load steering by default)
  skills/     recovery-fixtures/  demo-evidence/  kiroween-writeup/
  workflows/  new-app-pipeline.json  feature-pipeline.json (threat-model and crypto-review stages, fix loop capped at 3)
  powers/     coven-power/   record-inspector MCP server (verify a chain against a receipt from the IDE) plus fixture skills
  settings/   mcp.json (record-inspector, Playwright MCP, GitHub MCP; Context7 via power)
```

Surfaces: everything runs locally. **IDE** (local sessions) for specs, Analyze Requirements, Python property-based testing (IDE-only) and hooks. **CLI v3** (local sessions) for batch work, plus headless runs in GitHub Actions for the acceptance suite and release notes. Cloud sessions and Kiro Web are not required: the rules accept "IDE, CLI, Web, and/or Kiro Crew", and the judging criteria reward depth and variety of Kiro use, not any particular surface. They need a Pro or higher plan and add nothing the local surfaces cannot do here, so they are optional extras, not a dependency. The Break Glass drill runs from a cron job on your VPS. **Crew** is deferred.

Powers from the registry: Specification Hardening Engine (apply to specs 05, 06, 08, 10, 11; commit the `[SECURITY]` diff), Supabase or Neon, Netlify or Amplify, Design System Power, Context7, Snyk or Aikido, Build a Power for `coven-power`. Memory on from day one.

Evidence rules for `KIRO_USAGE.md`: one heading per product the form names (IDE, CLI, Web, Crew; custom agents; hooks; specs; steering; MCP; PBT; powers), describing only what was actually used, each with a pointer to a committed artifact and at least one chain from requirement to Kiro contribution to code change to verified behavior. Bugs reported are bugs actually found; any seeded failure used for demonstration is labelled as such.

## 7. Schedule, 2026-11-06 to 2026-12-04

Order follows the reviews: guarantees and format first, then core and offline recovery, then both application flows, then developer experience, Kiro evidence and submission materials. The two-day slip from v4 is absorbed by the polish milestone.

| Dates | Milestone | Deliverables | Cut if behind |
|---|---|---|---|
| Nov 6 to 8 | M0 Contract | Section 2 as `guarantees.md`, threat model v1 with the trusted-client assumption, `coven/v1` format spec covering both sharing modes and petition binding, specs 01 to 03 and 05, repo with MIT license, baseline hooks, CI | none |
| Nov 9 to 14 | M1 Core and recovery | `core-ts` envelope, keys, shares (both modes), encodings, bundle, header checks, Node offline tool, fast-check suite, browser-to-CLI fixtures; Python lifecycles, petitions, scheduler and records with property tests; API skeleton. Devpost Build Session Nov 11 | none; this is the product |
| Nov 15 to 20 | M2 Last Light | Asynchronous recovery flow, notifications and mail viewer, UI kit, browser-local share cards, Last Light with demo mode, acceptance scenarios 1 and 4 | optional earliest-date field |
| Nov 21 to 26 | M3 Break Glass and template | Break Glass with bound approvals, single-item release, retrieval window and rotation tracking, acceptance scenarios 2 and 3, binder PDF with its no-secrets test, `coven new`, `app-scaffolder` agent, `docs/` pages, hardening pass, acceptance scenario 5 | drills; `coven new` becomes a documented copy procedure |
| Nov 27 to 29 | M4 Polish and evidence | Both apps deployed and polished, accessibility pass, `KIRO_USAGE.md`, blog draft, social post | the cron drill job |
| Nov 30 to Dec 3 | M5 Ship | Video, README, clean-environment install of both apps, demo reset verified, submit Dec 3 | nothing |

Deadline: Friday, December 4, 2026, 2:00 PM Pacific, which is 5:00 PM Eastern, 22:00 UTC and 06:00 on December 5 in UTC+8. Both applications stay free and available through January 29, 2027, 1:00 PM Pacific (4:00 PM Eastern). After the deadline, nothing linked changes until winners are announced; keep building in a fork.

Credits: the 4,000 hackathon credits are claimed; redeem by Dec 4, they expire Dec 31. Budget about 120 credits a day and keep a paid plan as the fallback.

## 8. Demo video storyboard, 2 minutes 50 seconds, public on YouTube

| Time | Beat |
|---|---|
| 0:00 | Who needs this: a family that cannot open a phone; a three-person team locked out at 3 a.m. "Coven is a foundation for handing over secrets when enough of the right people agree, and here are two apps built on it." |
| 0:15 | One diagram: envelope, keys, shares, lifecycle, recovery, records, bundle. The two-layer promise in one sentence. |
| 0:30 | Last Light: seal a letter, print a share card from the browser, hold it to the camera; demo clock (labelled) runs to flicker and vigil; a check-in cancels the handover; the clock runs again; three trustees submit shares; the letter opens; the record and receipts. |
| 1:20 | Break Glass: a petition for one credential with a reason; one approval is not enough and a repeat approval does not count; the second approver completes it; the requester's browser rebuilds only that item's key; the other items stay sealed; retrieval window; rotation-required state. |
| 1:55 | Offline recovery: export the bundle, stop the service, run the Node tool with two shares (fails), then three (opens); a wrong share is rejected; the record checks out against a receipt. |
| 2:20 | Shared code: the same `core-ts` imported by both apps; one documented extension change. One real Kiro example: an EARS requirement, the property test it produced, the code change, the verified behavior. |
| 2:45 | Close on the repo tree. Name, URL, one sentence. |

Product footage recorded with Playwright for repeatable takes. Any acceleration, edit or seeded test is labelled. Nothing in the video implies that a window revokes a copied static credential or that the server "cannot" be compromised.

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Two applications double the surface | Thin apps over one core; one UI kit; Break Glass has four screens; drills optional |
| "Lean enough to be clear" versus creep | Five `core-ts` modules, one service package, in-repo docs, no plugin system, no rule language |
| Credibility of security claims | Audited library pinned and cited; one implementation; header checks; per-item keys; petition binding; threat model with the trusted-client assumption; section 2 language everywhere; "not independently audited as a whole" |
| Property-based testing in Kiro is IDE-only and documented for Python | Python owns lifecycles, petitions, scheduling, records and the binder test; TypeScript crypto uses fast-check written by Kiro plus cross-environment fixtures; the write-up says which is which |
| Cloud sessions and Web need a paid plan | Not required; the plan uses local IDE and CLI sessions, and the drill runs from cron on the VPS |
| Email deliverability for judges | Demo mail viewer; judges never depend on real inboxes |
| Judges cannot gather real approvers or trustees | Demo roles let one judge play every keyholder; demo reset restores fictional data |
| Design variance | Spent once in the UI kit; Design System power; accessibility review |
| Two days already lost to design iteration | Schedule restarted on Nov 6; polish milestone shortened, not the core |

## 10. Checklists

This week:
- Credits: claimed. Redeem by Dec 4; they expire Dec 31.
- Devpost draft (project 1281550, "Coven"): pitch, description and tags saved; the remaining fields need the real repo, demo URLs and video. Not submitted.
- Confirm model availability in your region. Cloud sessions and Web are optional; local IDE and CLI sessions satisfy the rules.
- Create the GitHub repo inside the submission period with an MIT license visible in the About section; `apps/last-light` and `apps/break-glass` as the two required folders.
- Decide your answer to "Were you registered for the Kiroween 2025 hackathon?"
- Join `#kiroween-hackathon` on Discord; register for the Nov 11 Build Session.

Submission (Dec 3), matching the form fields:
- Project name, elevator pitch, thumbnail; About in Markdown; Built-with tags; Try-it-out links for the repo and both apps; images at 3:2; YouTube video under three minutes, set to Public; all materials in English.
- Country of residence; the two attestations; Category: Skeleton Crew; only applicable bonus entries.
- Public GitHub URL with license and `/.kiro` at root; demo URL (Last Light) with Break Glass's URL and all demo-role logins in the private instructions field.
- "Explain how your project meets the main technology requirement": the headings of `KIRO_USAGE.md`, one line per product actually used.
- Disclosure of pre-existing code: libraries only (name the Shamir library and its version).
- Submitter type, AWS employee question, survey questions, agreement to the rules.
- Clean-environment install of both apps from the README; demo reset verified; claims in app, README, video and form match; then freeze everything until winners are announced.

## 11. Resolution map for both reviews

| Review item | Resolution |
|---|---|
| Nov 4, D1 Separate workflow timing from cryptographic access | Section 2 (two layers, promise, deferred date release, labels not isolation); 3.3 cancel-on-check-in; threat model in M0 |
| Nov 4, D2 Define what expires in Break Glass | 4.2 retrieval window, once-per-approver, terminal expiry, rotation-required, no revocation implied; invariant 7 |
| Nov 4, D3 Incompatible cross-language sharing | 3.1 one TypeScript implementation for browser and Node; versioned format; header checks; invariant 4 |
| Nov 4, D4 Share cards versus binder | 3.5 browser-local cards with a notice; service binder with a no-secrets test (invariant 10) |
| Nov 4, D5 Ledger verification boundary | 3.4 receipts as the trusted reference; operator-compromise distinction; offline records not auto-merged |
| Nov 4, scope, acceptance scenarios, hook semantics, cloud fallback, agent steering, real evidence, public video, availability | Sections 5, 6, 7, 8, 10 |
| Nov 6, verify browser-to-CLI fixtures | Invariant 4; M1 deliverable "browser-to-CLI fixtures"; acceptance scenario 4 |
| Nov 6, keep the offline-bypass distinction consistent | Section 2 promise reused in `guarantees.md`, README and video (sections 6 and 8) |
| Nov 6, who reconstructs the vault key; requester receives only the approved item; bind approvals and recipient key to the petition; test link failure after expiry | 3.2 two sharing modes and per-item keys; 3.3 binding; 4.2 full flow; invariants 5 and 7; acceptance scenarios 2 and 3 |
| Nov 6, verify both printed outputs | M2 and M3 deliverables; invariant 10; acceptance scenario 4 handles cards in recovery |
| Nov 6, narrow the ledger verifier output | 3.4 three outcomes only; entry-level diff only with a retained copy; invariant 9 |
| Nov 6, trusted client and authenticated key exchange wording | Section 2 trusted-client assumption; threat model in M0; video rule in section 8 |
| Nov 6, clean install, judge access, license, `.kiro/`, English, public video, ET deadline and availability | Sections 7 and 10 |
