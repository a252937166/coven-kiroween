// Client-side key storage. Private keys are non-extractable CryptoKey objects;
// IndexedDB stores them by structured clone, so the raw bytes never exist in
// JavaScript and never leave this browser profile.
//
// Demo simplification: one browser holds every fictional persona's key, so a
// single judge can play all roles. Passphrase-wrapped keys that follow a person
// across devices (proposal 3.2) are not built yet.

import { exportRawPublicKey, generateLongTermKeyPair } from "@coven/core-ts/keys";

export interface KeyStore {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryKeyStore implements KeyStore {
  private m = new Map<string, unknown>();
  async get<T>(key: string) {
    return this.m.get(key) as T | undefined;
  }
  async put(key: string, value: unknown) {
    this.m.set(key, value);
  }
  async delete(key: string) {
    this.m.delete(key);
  }
  async clear() {
    this.m.clear();
  }
}

export class IndexedDbKeyStore implements KeyStore {
  private readonly dbName: string;
  private dbp: Promise<IDBDatabase> | undefined;
  constructor(dbName: string) {
    this.dbName = dbName;
  }

  private db(): Promise<IDBDatabase> {
    this.dbp ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("keys");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbp;
  }

  private async run<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest): Promise<T> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("keys", mode);
      const req = op(tx.objectStore("keys"));
      tx.oncomplete = () => resolve(req.result as T);
      tx.onerror = () => reject(tx.error);
    });
  }

  get<T>(key: string) {
    return this.run<T | undefined>("readonly", (s) => s.get(key));
  }
  async put(key: string, value: unknown) {
    await this.run("readwrite", (s) => s.put(value, key));
  }
  async delete(key: string) {
    await this.run("readwrite", (s) => s.delete(key));
  }
  async clear() {
    await this.run("readwrite", (s) => s.clear());
  }
}

export interface LongTermKey {
  privateKey: CryptoKey;
  publicKey: Uint8Array;
}

export async function longTermKey(ks: KeyStore, user: string): Promise<LongTermKey | undefined> {
  return ks.get<LongTermKey>(`lt:${user}`);
}

export async function createLongTermKey(ks: KeyStore, user: string): Promise<LongTermKey> {
  const pair = await generateLongTermKeyPair();
  const key = { privateKey: pair.privateKey, publicKey: await exportRawPublicKey(pair.publicKey) };
  await ks.put(`lt:${user}`, key);
  return key;
}
