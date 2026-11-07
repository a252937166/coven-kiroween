// Fictional fixtures shared by core-ts tests. No real people or credentials.

import { toBase64 } from "../src/bytes.ts";
import type { Bundle } from "../src/bundle.ts";
import { entryHash, GENESIS, type RecordEntry } from "../src/records.ts";
import { encodeQrPayload, encodeWordCode, shareTag } from "../src/shares.ts";
import { sealVaultItem, sealVaultKey } from "../src/vault.ts";

export async function chain(types: string[]): Promise<RecordEntry[]> {
  const out: RecordEntry[] = [];
  let h = GENESIS;
  for (let i = 0; i < types.length; i++) {
    const e: RecordEntry = { seq: i + 1, at: `2026-11-0${(i % 9) + 1}T12:00:00Z`, type: types[i], data: { n: i } };
    h = await entryHash(h, e);
    out.push({ ...e, hash: h });
  }
  return out;
}

export interface Fixture {
  bundle: Bundle;
  qr: string[];
  words: string[];
}

/** A fictional 3-of-5 Last Light vault with two items. */
export async function fixtureVault(vaultId = "vault-hollow-family"): Promise<Fixture> {
  const trustees = ["Ada", "Bram", "Cleo", "Dov", "Esme"].map((name, i) => ({ id: `t${i + 1}`, name }));
  const { vaultKey, header, shares } = await sealVaultKey(vaultId, 5, 3);
  const bodies = [
    { id: "item-letter", label: "Letter to the family", deliverTo: ["Ada", "Bram"], earliestRelease: null, body: "Dear all, the spare key is under the pumpkin. (fictional)" },
    { id: "item-wifi", label: "Home Wi-Fi", deliverTo: ["Cleo"], earliestRelease: "2027-01-01", body: "ssid: hollow-house / pass: not-a-real-password" },
  ];
  const items = [];
  for (const b of bodies) {
    const s = await sealVaultItem(vaultKey, vaultId, b.id, b.body);
    items.push({ id: b.id, label: b.label, deliverTo: b.deliverTo, earliestRelease: b.earliestRelease, wrappedKey: toBase64(s.wrappedKey), ciphertext: toBase64(s.ciphertext) });
  }
  const entries = await chain(["vault.created", "cards.issued", "checkin"]);
  const tag = await shareTag(vaultId);
  return {
    bundle: {
      format: "coven/v1",
      kind: "last-light-vault",
      exportedAt: "2026-11-07T12:00:00Z",
      vault: { id: vaultId, name: "Hollow family vault (fictional)", threshold: 3, trustees },
      header: toBase64(header),
      items,
      record: { entries, receipt: { length: entries.length, head: entries[entries.length - 1].hash! } },
    },
    qr: shares.map((s) => encodeQrPayload(tag, s)),
    words: shares.map((s) => encodeWordCode(tag, s)),
  };
}
