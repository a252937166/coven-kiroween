# Requirements Document

## Overview

Use this M0 input with the [Coven guarantees](../../steering/guarantees.md) steering file.

Break Glass lets a requester retrieve one sealed credential after enough eligible approvers agree on the same petition. A petition identifies one requester, one immutable seal version, and one retrieval deadline. Its release package contains the item ciphertext and a complete quorum set of approval envelopes encrypted to the petition's requester key. The retrieval deadline controls what the service returns. A requester who retains the release package and its private key can still decrypt the package after the deadline. A disclosed static credential remains usable while the downstream system accepts it.

## Requirements

### BG-01 Quorum and retrieval

**User story.** As a credential owner, I want the service to release the credential only after a quorum approves the same request, so an engineer cannot accumulate shares across partially approved petitions.

1. **BG-01.1** While a petition has fewer than its configured threshold of distinct eligible approvals, the service SHALL withhold all approval envelopes and item ciphertext for that petition from the requester through every requester-facing interface, including direct downloads. Approval status may be shown without release material.
2. **BG-01.2** When the bound requester authenticates and retrieves from an active petition with enough distinct eligible approvals for that petition and its current seal version, and server time is before the deadline, the service SHALL return only that version's item ciphertext and a complete quorum set of encrypted approval envelopes together in one protected response. The service SHALL evaluate these conditions in the same release decision.
3. **BG-01.3** If the caller is not the requester bound to the petition, the petition is denied or invalidated, or server time is at or after the deadline, then the service SHALL reject retrieval without returning any release material, including when the caller uses a previously issued link. An expired petition SHALL remain closed to approvals and retrieval.
4. **BG-01.4** When a requester opens two petitions for the same seal version with a threshold of two and obtains one approval from a different approver on each, the service SHALL return zero approval envelopes and no item ciphertext for either petition. Repeating either approval SHALL leave that petition below quorum.

### BG-02 Seal version isolation

**User story.** As a credential owner, I want each reseal to use fresh key material, so someone who retrieved an earlier version cannot decrypt its replacement.

1. **BG-02.1** When an item is sealed or resealed, the system SHALL assign the new seal an immutable version identifier. The browser SHALL generate a fresh, independent item key and a fresh set of shares for that version.
2. **BG-02.2** When the service creates a petition, it SHALL bind the petition to the item's current seal version and a fixed expiry for the lifetime of that petition.
3. **BG-02.3** When the service activates a new seal version, it SHALL invalidate outstanding petitions and retrieval links for the superseded version in the same activation. Approvals for the previous version SHALL contribute zero approvals to petitions for the new version.
4. **BG-02.4** When a requester retains an earlier version's release package, shares, or reconstructed key, the new version SHALL remain undecryptable using that material.

### BG-03 Authenticated identity and petition binding

**User story.** As an approver, I want my approval tied to the authenticated requester and the exact item they requested, so it cannot be redirected or replayed under another petition.

1. **BG-03.1** When an authenticated requester opens a petition, the service SHALL accept only a well-formed ephemeral public key for the supported key exchange and bind that key immutably to the petition and to the requester identity established by the authenticated session. The client SHALL present the fingerprint as a label for the bound key. The service supplies the identity-to-key binding.
2. **BG-03.2** When the service enrolls an approver, it SHALL bind the validated approver key to that authenticated identity. When the service receives an approval, it SHALL verify the caller's identity and eligibility for the petition's seal version and count that identity at most once within the petition.
3. **BG-03.3** When an approver encrypts a share for release, the client SHALL encrypt it to the petition's bound requester key and authenticate the petition ID, item ID, immutable seal version, requester identity and requester key fingerprint, and approver identity as associated data.
4. **BG-03.4** If an approval envelope is presented under a different petition, item, seal version, requester, requester key, or approver identity, then the receiving client SHALL reject it without using the share to reconstruct a key.

## Acceptance gates

Define these gates in M0. Run AG-01 when the Last Light recovery flow exists and AG-02 against the intended submission revision.

1. **AG-01 Printed Last Light card.** For a fictional Last Light vault, generate and print a share card in the browser and export the bundle. With the service offline, read the QR payload or transcribe the word code from the actual printed card, supply the remaining required shares, and recover the expected sample item with the offline tool. Inspect service requests, telemetry, and logs from card generation and printing for raw shares and their printable encodings, including the QR payload and word code. The gate passes when recovery succeeds and none of those values appear in the inspected data.
2. **AG-02 Committed Kiro artifacts.** From a clean checkout of the submission commit, verify that `.kiro/` is at the repository root and that all required files, including this spec, the guarantees steering file, and the artifacts cited as evidence of Kiro use, are present and tracked in that commit. Evaluate ignore rules even for already tracked files. The gate passes when `.kiro/`, its subdirectories, and all required files are unignored. Record the commit and the check result.
