# Judge deployment verification, November 19, 2026

[Last Light](https://lastlight.axiqo.xyz/) and [Break Glass](https://breakglass.axiqo.xyz/) were tested from outside the server over HTTPS. Both return the expected application page and matching JavaScript and CSS. Both report private demo mode. Each browser profile gets a separate SQLite database and demo clock for each app. The service starts on boot, and the two hosts share a certificate valid through February 17, 2027 with automatic renewal enabled.

The release manifest identifier is `a9e32ac219e66b98`. All 14 packaged service and frontend files matched the local build. The 57 service tests passed, and the 15-scenario local browser suite passed on three consecutive runs with fresh data.

## Independent browsers

The public run began at 14:32 UTC. Judge A used Chromium 151. Judge B used Firefox 159. Each ran in its own process with an empty profile.

| Action | Observed result |
| --- | --- |
| A sets up both apps, then B reloads both | B still sees two fresh setup screens. |
| A and B separately obtain two approvals. A advances the Break Glass clock 30 minutes. | A's previously issued link returns HTTP 410 with no release material. B's request stays approved and its clock offset stays at zero. |
| A resets Break Glass. B reopens its own link. | B receives HTTP 200, decrypts exactly the requested fictional passphrase in Firefox and can hide it. |
| B advances Last Light 60 days and submits one trustee share. A resets Last Light. B reloads. | B retains its first share, adds two more and recovers the expected letter. The future-dated letter remains held. |
| A third, fresh browser profile opens both sites | Both apps start empty and both clocks show zero offset. Cookies in the existing profiles belong to their individual app hosts. |

## Paper recovery

The current CLI recovered the original vault under a network-deny policy using the owner's previously hand-transcribed Bram card and its two corresponding trustee shares. The single-share attempt was rejected.

On November 19 a fresh browser downloaded Bram’s card and the matching encrypted bundle from the public Last Light site. Both the word code and QR in the printable PDF matched the new vault. On November 20 the owner entered the code from the printed card. With network access denied, the CLI rejected that share alone and recovered the expected family letter when two other trustees’ shares were added. The scanner found zero matches across 33 tested representations in the captured browser traffic, service log and configuration notes, or the encrypted bundle. [Physical acceptance record](AG-01-printed-card.md#november-20-public-deployment-result).
