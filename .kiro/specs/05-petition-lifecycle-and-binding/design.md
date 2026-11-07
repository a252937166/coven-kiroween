# Design Document

## Overview

This design covers the Break Glass petition: how the service creates it, counts approvals on it, releases one sealed item version through it, and closes it. It also defines how M0 specifies the two acceptance gates, AG-01 and AG-02.

Inputs:

- [Requirements](requirements.md) (BG-01 to BG-03, AG-01, AG-02). Every decision below cites the IDs it serves.
- [Coven guarantees](../../steering/guarantees.md). Where the [proposal](../../../PROPOSAL.md) is narrower than the requirements, this design follows the requirements. See "Differences from the proposal" at the end.

The design rests on one rule from the guarantees. Cryptography decides who *can* decrypt. The service decides what it *serves*. A requester who keeps a release package and the ephemeral private key can still decrypt after expiry, and a copied static credential stays valid until it is rotated. The design never claims otherwise.

### Terms

| Term | Meaning in this spec |
|---|---|
| Item | One sealed credential. |
| Seal version | One immutable sealing of an item: its own item key, ciphertext, header and share set. Identified by `seal_version_id`. |
| Current version | The seal version the item points to now. Only one per item. |
| Petition | One requester's request for the current version of one item, with a fixed expiry. |
| Requester key | The ephemeral P-256 public key the requester's browser generates for one petition. |
| Fingerprint | SHA-256 of the requester key's uncompressed point encoding. A label for the key, not proof of identity (BG-03.1). |
| Approver share blob | One approver's share for one seal version, encrypted to that approver's enrolled long-term key at sealing time. Not release material: only that approver's private key opens it. |
| Approval envelope | One approver's share for the petition's seal version, encrypted to the requester key with bound associated data. |
| Release package | The seal version's item ciphertext and header plus a quorum set of approval envelopes, served in one response. |
| Release material | Item ciphertext, item header and approval envelopes. Anything else (IDs, counts, names, public keys, fingerprints) is status. |
| Expiry | `expires_at`, the requirements' "deadline". Fixed at creation. Retrieval is allowed only while server time is strictly before it. |

### Guarantee labels used for tracing

Two guarantee obligations have no BG ID. The owner's requirements file is not edited to add one. Tasks trace to these labels instead:

| Label | Source | Obligation |
|---|---|---|
| GR-ROT | guarantees.md, Break Glass release, paragraph 4 | Record rotation as a follow-up after release; describe the retrieval window accurately in all user-facing copy. |
| GR-LOG | guarantees.md, Cryptographic access paragraph 4 and Printed artifacts paragraph 1 | Keep plaintext, private keys, symmetric keys, raw shares and printable encodings out of service requests, telemetry and logs. |

## Architecture

```
 Requester browser            Service (FastAPI)                   Approver browser
 ─────────────────            ─────────────────                   ────────────────
 generate ephemeral ──POST──▶ validate key, bind requester,
 P-256 key pair     /petitions  current version, expiry
 (non-extractable)            │
                              │ GET /petitions/{id}  (status only) ▶ compute fingerprint locally
                              │ GET /petitions/{id}/approver-share ▶ eligible approver only:
                              │                                     own share blob for the version
                              │                                   decrypt own share,
                              │                                   encrypt to requester key
                              │ ◀──POST /approvals────────────── with bound AAD
                              │ authenticate, check eligibility,
                              │ count once, store opaque envelope
 GET /release ───────────────▶│ one release decision (one transaction)
 ◀── release package ─────────│ or rejection with no material
 verify AAD, distinct
 approvers, combine k shares,
 check header, decrypt item
```

Placement follows the proposal's layout:

| Part | Location | Holds |
|---|---|---|
| AAD encoding, approval envelope seal/open | `core-ts/src/envelope.ts` | AES-256-GCM with associated data |
| Ephemeral key generation, validation, fingerprint, ECDH and HKDF | `core-ts/src/keys.ts` | WebCrypto P-256 |
| Share split and combine for item-level sharing | `core-ts/src/shares.ts` | `shamir-secret-sharing`, pinned |
| Petition state machine, approval counting, release decision | `service/coven_service/petitions.py` | Workflow metadata and opaque ciphertext only |
| Seal version activation | `service/coven_service/petitions.py` | Version records, invalidation |
| Event records | spec 07 (`service/coven_service/records.py`) | Hash-chain entries for each transition |
| Break Glass screens | spec 11 (`apps/break-glass/`) | Uses the interfaces defined here |

The service never receives plaintext, private keys, item keys or raw shares. It stores public keys, approver share blobs encrypted to approvers, encrypted approval envelopes and encrypted item ciphertext.

## Components and Interfaces

### 1. Seal versions (BG-02.1, BG-02.3, BG-02.4)

Sealing and resealing happen in the administrator's browser:

1. The browser generates a fresh random 256-bit item key with `crypto.getRandomValues`. It never derives the key from a previous version.
2. It encrypts the credential and an authenticated header under that key. The header's associated data includes `item_id` and `seal_version_id`, so a header from one version fails under another.
3. It splits the item key into a new share set for the version's approvers with threshold k, and encrypts each share to that approver's enrolled long-term public key, producing one approver share blob per approver.
4. It uploads the ciphertext, header, approver share blobs, approver list and threshold.

The browser chooses `seal_version_id` as a random UUIDv4 before encryption, because the header binds to it. The service rejects a version ID it has seen before for any item.

`activate_seal_version(item_id, seal_version_id)` runs in one transaction:

1. Insert the version record. Its fields never change after insert.
2. Set `item.current_seal_version_id` to the new version.
3. Move every petition on the superseded version from `Open`, `Approved` or `Released` to `Invalidated`.
4. Append one record event per invalidated petition.

Approvals belong to a petition, and a petition belongs to one version. So approvals for an old version can never count toward a petition on the new version (BG-02.3). Retrieval links carry no authority of their own (see section 5), so invalidating the petition invalidates every link to it.

### 2. Petition creation (BG-02.2, BG-03.1)

`POST /petitions` with `{item_id, reason, requested_window_seconds, requester_public_key}`.

The service:

1. Takes the requester identity from the authenticated session only. A requester ID in the body is rejected with 422 (the schema forbids extra fields).
2. Validates `requester_public_key`: exactly 65 bytes, uncompressed P-256 point (`0x04 || X || Y`), on the curve, not the identity point. Python `cryptography`'s `EllipticCurvePublicKey.from_encoded_point` performs the curve check. Anything else returns 422 and creates nothing.
3. Reads `item.current_seal_version_id` inside the same transaction.
4. Sets `expires_at = now + min(requested_window_seconds, MAX_WINDOW_SECONDS)` from the server clock. `MAX_WINDOW_SECONDS = 3600` (decision D3). `requested_window_seconds` must be at least 60.
5. Stores `fingerprint = SHA-256(requester_public_key)`.
6. Inserts the petition in state `Open`.

`petition_id`, `requester_id`, `item_id`, `seal_version_id`, `requester_public_key`, `fingerprint` and `expires_at` are write-once. The repository layer exposes no update path for them, and a database trigger rejects updates to those columns.

The requester's browser:

- Generates the key pair with `crypto.subtle.generateKey({name: "ECDH", namedCurve: "P-256"}, false, ["deriveBits"])`. The private key is non-extractable.
- Stores the `CryptoKey` in IndexedDB keyed by `petition_id`, and deletes it after a successful local decryption or once the petition is terminal. The petition opened from a petition link keeps its key until the service itself answers 410 to a retrieval, so a reused link is refused by the service, not hidden by the client (run 4).
- Shows the fingerprint it computed itself as the key label.

### 3. Approval (BG-03.2, BG-03.3, BG-01.4)

**Enrollment.** When an approver enrolls, the service binds the approver's validated long-term public key to the authenticated account (BG-03.2). Seal versions encrypt shares to that bound key.

**Two read paths, split by role.** Earlier drafts had the approver read its own encrypted share from `GET /petitions/{id}`, which section 5 also defines as status only. The two paths are now separate:

| Endpoint | Caller | Returns | Never returns |
|---|---|---|---|
| `GET /petitions/{id}` | Bound requester, or an approver eligible for the petition's seal version | Status: IDs, reason, state, threshold, distinct approval count, approver display names, expiry, requester identity, requester public key, fingerprint | Item ciphertext, item header, approval envelopes, approver share blobs |
| `GET /petitions/{id}/approver-share` | An approver eligible for the petition's seal version | The caller's own approver share blob for that version, plus the status fields | Item ciphertext, item header, approval envelopes, other approvers' blobs |

`/approver-share` returns 404 to any caller who is not eligible for that version, including the requester when the requester is not an approver. It returns 409 unless the petition is `Open`, the version is current and server time is before expiry, so approvers cannot fetch shares for a closed petition. The share blob is encrypted to the approver's own long-term key; it is not an approval envelope and not item ciphertext, so returning it to an approver does not touch BG-01.1. When a requester is also an eligible approver (decision D1), the requester receives only their own blob, which they already hold as a keyholder.

**Approver client.** It calls `GET /petitions/{id}/approver-share`. It then:

1. Validates the requester public key and computes the fingerprint itself. It does not trust a fingerprint string from the server. It shows the fingerprint and the reason to the approver.
2. Decrypts its share blob with its long-term private key.
3. Builds the associated data (section 4) and seals the share to the requester key.
4. Posts `{envelope}` to `POST /petitions/{id}/approvals`.

**Service check.** `POST /petitions/{id}/approvals` runs in one transaction that locks the petition row:

| Check | Failure |
|---|---|
| Caller is authenticated | 401 |
| Caller is in the approver set of the petition's `seal_version_id` | 403 |
| Petition state is `Open` | 409 |
| `petition.seal_version_id == item.current_seal_version_id` | 409 |
| Server time `< expires_at` | 409, and the petition moves to `Expired` |
| No approval from this identity exists on this petition | 200, idempotent, count unchanged |
| Envelope is well formed: version byte, 65-byte ephemeral key, 12-byte nonce, ciphertext length in range | 422 |

The unique key `(petition_id, approver_id)` enforces once-per-identity counting even under concurrent requests. When the distinct count reaches the threshold, the petition moves to `Approved` in the same transaction, and later approvals return 409. The stored envelope set is therefore exactly k envelopes.

The service cannot verify that an envelope decrypts correctly, because it holds no key. The requester client detects a bad envelope (section 6).

**Deny.** `POST /petitions/{id}/deny` by any approver eligible for the version, or by the item's administrator, moves `Open` or `Approved` to `Denied` (decision D2).

**BG-01.4 by construction.** Approvals are stored per petition and never pooled across petitions for the same version. A requester with two petitions and one different approval on each has two petitions in `Open`. Neither one returns material. A repeated approval on either is idempotent and leaves it below quorum.

### 4. Associated data and envelope format (BG-03.3, BG-03.4)

Associated data is a canonical byte string:

```
aad = utf8("coven/v1/approval") || 0x00
      || lp(petition_id) || lp(item_id) || lp(seal_version_id)
      || lp(requester_id) || fingerprint (32 raw bytes)
      || lp(approver_id)
lp(s) = uint16_be(len(utf8(s))) || utf8(s)
```

Length prefixes keep two different field tuples from encoding to the same bytes.

Envelope, version 1:

```
0x01 || approver_ephemeral_public_key (65) || nonce (12) || AES-256-GCM ciphertext+tag
```

Key derivation: ECDH(approver ephemeral private, requester public) gives a shared secret. HKDF-SHA-256 with salt = fingerprint and info = `"coven/v1/approval-key"` gives a 256-bit AES key. The share plaintext is the raw share bytes from `shares.ts`.

The approver's ephemeral key is discarded after sealing. The approver's identity is bound through the AAD and through the service's authentication of the upload. For the MVP the trust in who sent an envelope rests on the authenticated service, as the guarantees state. Approver signatures are not part of M0.

Approver share blobs (section 1) use the same construction with a different domain: AAD `utf8("coven/v1/approver-share") || 0x00 || lp(item_id) || lp(seal_version_id) || lp(approver_id)`, salt = SHA-256 of the approver's long-term public key, info `"coven/v1/approver-share-key"`.

### 5. Release decision (BG-01.1, BG-01.2, BG-01.3)

There is exactly one requester-facing path to release material: `GET /petitions/{id}/release`. No other endpoint returns item ciphertext, the item header or approval envelopes to a requester, and none of them is placed at a static or blob URL. A "retrieval link" is the petition's page URL, `/#petition=<petition_id>` on the Break Glass origin. It carries only the opaque petition ID, in the URL fragment, which browsers do not send in requests. It carries no token, so it grants nothing beyond what the authenticated session already allows.

`release_decision(petition_id, caller, now)` runs in one transaction with row locks on the petition and the item. It returns the package only when every condition holds in that one evaluation:

1. `caller == petition.requester_id`.
2. `petition.state` is `Approved` or `Released`.
3. `petition.seal_version_id == item.current_seal_version_id`.
4. The count of distinct approvals from identities eligible for that version is at least the version's threshold.
5. `now < petition.expires_at`, using the server clock read inside the transaction.

On success the response contains `{seal_version_id, item_header, item_ciphertext, envelopes: [{approver_id, envelope}] × k}` with `Cache-Control: no-store`. The first success moves `Approved` to `Released` and sets the item's `rotation_state` to `rotation_required` (GR-ROT). Retrieval stays allowed in `Released` until expiry, so a dropped connection does not end the incident (decision D5).

On failure the response contains no release material:

| Condition | Response |
|---|---|
| Caller is not the bound requester | 404, the same body as an unknown petition |
| Below quorum (`Open`) | 409 with status only |
| `Denied` or `Invalidated` | 410 with state |
| `now >= expires_at` | 410; the petition moves to `Expired` if it was not already |

Expiry is evaluated at decision time. A background sweep may also mark petitions `Expired`, but correctness never depends on it.

### 6. Requester client verification (BG-03.4, BG-02.4)

Before it combines anything, the requester's browser:

1. Rebuilds the AAD from its own local petition record (petition ID, item ID, seal version ID, its own identity, the fingerprint of its own stored key) plus the `approver_id` attached to each envelope. It does not take those values from the response body.
2. Rejects the package if two envelopes name the same `approver_id`, or if there are fewer than k envelopes.
3. Opens each envelope. A GCM failure rejects that envelope, and its share is never passed to `combine`.
4. Rejects duplicate share indices.
5. Combines k shares, then decrypts the version header with the rebuilt key. The item is decrypted only if the header check passes.

Old material fails against a new version (BG-02.4) for three reasons. The new item key is independent. The new header's associated data names the new `seal_version_id`. Old envelopes bind the old version ID in their AAD.

### 7. Petition lifecycle

```
            approvals reach k
   Open ───────────────────────▶ Approved ──first release──▶ Released
    │  \                           │  \                        │  \
    │   \ now >= expires_at        │   \                       │   \
    │    ▼                         │    ▼                      │    ▼
    │   Expired ◀──────────────────┘   Expired ◀───────────────┘   Expired
    │
    ├─ deny ─────────▶ Denied        (also from Approved)
    └─ reseal ───────▶ Invalidated   (also from Approved and Released)
```

`Expired`, `Denied` and `Invalidated` are terminal. No transition leaves them, and a new release needs a new petition (BG-01.3). Every transition appends a record event (spec 07). Event payloads carry IDs, state names, counts and the fingerprint, never envelopes or ciphertext.

### 8. Rotation follow-up and user-facing copy (GR-ROT)

After the first release the item shows `rotation_required` until a teammate confirms rotation with `POST /items/{id}/rotation-confirmed`, which sets `rotation_state = rotated` and records an event. Confirming rotation does not reseal; an administrator reseals separately if the stored credential changed.

Approved copy for the release screen, used verbatim in the app, README and video:

> This link stops working at {expires_at}. Anything you already copied or downloaded stays usable after that. The credential stays valid until you rotate it in the system that issued it.

The UI never says the window "revokes", "expires the credential" or "destroys" anything.

### 9. Logging and telemetry (GR-LOG)

Request bodies for `/approvals` and response bodies for `/release` and `/approver-share` are excluded from access logs, error reports and tracing. The logging middleware has an allowlist of loggable fields per route. A test asserts that envelope bytes, share blobs and ciphertext never reach captured logs.

## Data Models

```
SealVersion   seal_version_id PK, item_id FK, threshold k, approver_ids[],
              header, ciphertext, approver_share_blobs{approver_id → blob},
              created_at, activated_at                        (immutable after insert)
Item          item_id PK, admin_id, current_seal_version_id FK,
              rotation_state ∈ {none, rotation_required, rotated}
Petition      petition_id PK, item_id, seal_version_id, requester_id,
              requester_public_key (65 B), fingerprint (32 B), reason,
              created_at, expires_at                          (write-once)
              state ∈ {Open, Approved, Released, Expired, Denied, Invalidated}
              first_released_at?, closed_at?
Approval      (petition_id, approver_id) PK, envelope blob, created_at
EnrolledKey   account_id PK, long_term_public_key, enrolled_at
```

## Error Handling

- Every rejection path returns before any release material is read from storage, so an exception cannot leak a partly built package.
- Invalid public keys and malformed envelopes return 422 with a reason code and no echo of the submitted bytes.
- Concurrency: the unique approval key and the row locks mean racing approvals count once, and a release racing a reseal sees either the old version (and is invalidated in the same commit) or a consistent state.
- Clock: only the server clock decides expiry. Client clocks only format countdowns. Demo mode may offset the server clock forward through a clearly labelled control; it never moves time backward.

## Testing Strategy

| Check | Kind | Proves |
|---|---|---|
| T-01 Withhold below quorum | Hypothesis stateful test over petitions and approvals; every requester call returns no envelope or ciphertext while below k | BG-01.1 |
| T-02 Endpoint inventory | Route and response scan: only `/release` returns release fields; `/petitions/{id}` and `/approver-share` never do; `/approver-share` returns only the caller's blob | BG-01.1 |
| T-03 Single release decision | Property test over (caller, state, version current, count, now vs expiry); release iff all five hold; boundary `now == expires_at` rejects | BG-01.2, BG-01.3 |
| T-04 Expired stays closed | After expiry, approvals and retrieval fail and no transition reopens the petition | BG-01.3 |
| T-05 Old link | A saved petition URL used by the requester after expiry, denial or invalidation, and by another user, returns no material | BG-01.3 |
| T-06 Split approvals | Two petitions, k = 2, one different approver each, repeat approvals: zero envelopes, no ciphertext | BG-01.4 |
| T-07 Fresh version | Two seals of one item have different keys and share sets; old key, old shares and old envelopes fail the new header | BG-02.1, BG-02.4 |
| T-08 Immutable binding | Update attempts on write-once petition columns fail at the repository and database layers | BG-02.2, BG-03.1 |
| T-09 Activation invalidates | Reseal moves all old-version petitions to `Invalidated` in one commit; old approvals count zero on new petitions | BG-02.3 |
| T-10 Key validation | Wrong length, compressed, off-curve, identity point and wrong-curve keys are rejected; requester ID comes from the session | BG-03.1 |
| T-11 Eligibility and once-per-identity | Ineligible callers rejected from `/approvals` and `/approver-share`; concurrent duplicate approvals count once | BG-03.2 |
| T-12 AAD binding | fast-check: an envelope opens only under its exact six-field AAD; changing any one field fails | BG-03.3, BG-03.4 |
| T-13 Client rejection | Requester client refuses swapped, duplicated or foreign envelopes and never calls `combine` with their shares | BG-03.4 |
| T-14 No material in logs | Captured logs during approval, approver-share and release contain no envelope, blob or ciphertext bytes | GR-LOG |
| T-15 Rotation follow-up | First release sets `rotation_required`; confirmation sets `rotated`; release screen copy matches section 8 | GR-ROT |
| AG-01 Printed card | Manual gate, definition in `docs/acceptance/AG-01-printed-card.md` | AG-01 |
| AG-02 Committed `.kiro/` | Script on a clean clone, definition in `docs/acceptance/AG-02-committed-kiro.md` | AG-02 |

Python tests use Hypothesis, including `RuleBasedStateMachine` for the lifecycle. TypeScript tests use fast-check. Property tests are evidence about specified behavior, not proof of system security.

### Acceptance gate design

Both gates are defined in M0. Neither can pass in M0, and that is expected.

| Gate | Defined in M0 | Runnable before the dependency | Depends on |
|---|---|---|---|
| AG-01 | Procedure and capture scanner | Scanner self-test on fictional data; a rehearsal using a screen-displayed card instead of paper | A physical printer and a human reading the actual printed card; the Last Light recovery flow (M2) |
| AG-02 | Script, required-files manifest, ignore fixture tests | Running the script on any local commit | The final submission commit on the public repository (M5) |

**AG-01** runs when the Last Light recovery flow exists (M2):

1. Seed a fictional vault (3 of 5) in demo mode. Start a capture of all service requests (proxy HAR), service logs and telemetry.
2. Generate and print one share card from the browser. Export the bundle.
3. Before stopping the capture, copy the card's QR payload and word code from the browser's local view into a local file outside the repo, for scanning only.
4. Stop the service. Scan the QR from the paper with a phone or webcam reader, or type the word code from the paper. Supply two more valid shares and run `node recover.js bundle.json --share ...`.
5. Run the scanner over the capture. It searches for the raw share bytes (hex and base64), the `coven1:` QR payload, and the word code (with and without separators, any case).
6. Pass when the expected sample item is recovered and the scanner finds no match. Delete the local file from step 3.

A rehearsal from a screen is useful but is not a pass: the gate requires the code to come from paper.

**AG-02** runs against the submission commit with `scripts/check-kiro-tracked.sh`:

1. `git clone` the repository into a scratch directory and check out the commit.
2. Confirm `.kiro/` exists at the repository root.
3. For each path in `.kiro/required-files.txt`, confirm it exists and `git ls-files --error-unmatch` succeeds.
4. Run `git check-ignore --no-index -v` on `.kiro/`, each subdirectory and each required file. `--no-index` makes the check apply to already tracked files. Any match fails.
5. Print the commit SHA and PASS or FAIL with the failing paths.

A pass on a local commit is a rehearsal. The recorded evidence must name the submission commit.

## Differences from the proposal

These follow the requirements and should be copied back into `PROPOSAL.md` section 3.3 by the owner:

1. AAD has six fields. The proposal lists three (petition ID, item ID, fingerprint). BG-03.3 adds seal version, requester identity and approver identity.
2. Petitions have an `Invalidated` state for reseal (BG-02.3). The proposal lists five states.
3. The proposal says "window". This spec uses a fixed `expires_at` with strict `now < expires_at`, capped at one hour.

## Decisions

These replace the draft's open questions. Each uses the draft default where it fits the guarantees.

| ID | Question | Decision | Why it fits the guarantees |
|---|---|---|---|
| D1 | May a requester who is an eligible approver approve their own petition? | Yes. Their identity counts once, like any approver. | Guarantees require authentication, eligibility and once-only counting; all hold. The quorum is trusted either way. The status view labels a self-approval. |
| D2 | Who may deny? | Any approver eligible for the version, or the item's administrator. Denial is terminal. | Denial withholds material; it never releases any. |
| D3 | Maximum window | `MAX_WINDOW_SECONDS = 3600`, minimum 60, default request 900. | Shorter online retrieval only narrows what the service serves. |
| D4 | Rotation follow-up and copy | Traced to guarantee label GR-ROT (section 8); no new BG ID, because the owner's requirements file is not edited. | Implements the guarantee directly. |
| D5 | Repeat retrieval | Allowed in `Released` until expiry, only to the bound requester. | BG-01.2 conditions are rechecked on every call. |
| D6 | AG-02 precondition | Local Git is initialised in M0 with `.kiro/` tracked and unignored. The gate itself still needs the submission commit. | Matches the acceptance-evidence guarantee. |
| D7 | Approver share read path | Separate `GET /petitions/{id}/approver-share` for eligible approvers; `GET /petitions/{id}` is status only. | Keeps requester and status paths free of release material (BG-01.1). |
