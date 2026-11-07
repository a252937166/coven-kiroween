---
inclusion: always
---

# Coven guarantees

Apply these guarantees to the design, acceptance tests, UI copy, README, and demo. Use the [M0 EARS requirements](../specs/05-petition-lifecycle-and-binding/requirements.md) for the Break Glass protocol and acceptance criteria. This input carries forward the [Coven v4.1 proposal](../../PROPOSAL.md) and adds the M0 decisions from its follow-up review.

## Cryptographic access and online policy

- Encrypt each item in the browser under its own key. Last Light splits the vault key that wraps those item keys. Break Glass splits only the key for one sealed version of one credential. A Break Glass release must expose only that version of that item to its requester.
- Anyone with the required number of distinct valid shares and the matching ciphertext can recover what that key protects offline at any time. Coven trusts that quorum. The service controls when it starts and completes an online handover, whom it notifies, and what it serves and records.
- In Last Light, a missed check-in starts a grace period. A check-in before release cancels the pending handover. A missed check-in is a signal that can start recovery, and it does not establish that the owner has died. Earliest release dates are online policy and recipient names are routing labels. Trustees who recover the vault key can open the entire vault.
- Plaintext privacy assumes unmodified client code and authenticated key exchange. For the MVP, trust the authenticated service to bind account identities and public keys, authorize approvals, and enforce release policy. The service handles encrypted payloads and workflow metadata. Keep plaintext, private keys, symmetric keys, and raw shares on the client. A compromised web origin, browser extension, or build can expose them. Use pinned dependencies, strict content security policy, subresource integrity where applicable, and reproducible builds to reduce client integrity risks. The offline tool provides a separate path for recovery.

## Break Glass release

- At petition creation, bind the authenticated requester, the validated ephemeral public key supplied by that requester, the sealed item version, and the expiry. Keep those bindings immutable. Authenticate each approver, check their eligibility for that version, and count them once. The key fingerprint identifies the key recorded on the petition. The authenticated account and service binding establish who requested it.
- Bind every approval envelope to the petition ID, item ID, sealed version, requester identity, requester key fingerprint, and approver identity as authenticated associated data. Before quorum, return no approval envelopes or protected item ciphertext to the requester. After quorum, serve the complete release payload together only to the bound requester while the petition is active, its sealed version is current, and the server clock is strictly before expiry.
- Generate a fresh independent item key and a new share set on every reseal. When the new version becomes active, invalidate outstanding petitions and links for the old version. Previously released keys and shares must never unlock a replacement version.
- Expiry stops future retrieval from the service. Material already downloaded can remain usable. A copied static credential stays valid until it is rotated in the system that issued it. Record rotation as a follow-up and describe the retrieval window accurately in all user-facing material.

## Printed artifacts and records

- Generate Last Light share cards in the browser. Treat the printed QR and word code as sensitive recovery shares. Keep raw shares and printable encodings out of service requests, telemetry, and logs. The executor binder contains no shares, keys, or ciphertext.
- A retained receipt verifies the chain prefix it witnessed. The verifier reports a matching prefix, an altered witnessed prefix, or truncation. Locate changed entries only by comparing against a retained record snapshot.

## Acceptance evidence

Define these checks in M0. Execute them when the recovery flow and the submission revision are available.

- Recover a fictional Last Light item offline using a QR or word code read from an actual printed share card and enough other valid shares. Verify that card generation and printing expose no raw share or printable encoding in service requests or logs.
- From a clean checkout of the submission revision, verify that all required files under the root `.kiro/` are present and tracked. Verify that ignore rules exclude neither `.kiro/` nor any of its subdirectories or required files. Report the revision and check result as evidence. [Kiroween Official Rules](https://kiroween.devpost.com/rules)
