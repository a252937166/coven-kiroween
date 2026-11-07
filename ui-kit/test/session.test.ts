// The page-wide session lock is single-flight and is taken synchronously:
// a second sign-in attempted while one is pending never starts.

import { test } from "node:test";
import assert from "node:assert/strict";

import { sessionBusy, withSessionLock } from "../src/session.ts";

test("withSessionLock runs at most one sequence at a time", async () => {
  let started = 0;
  let release!: () => void;
  const first = withSessionLock(async () => {
    started++;
    await new Promise<void>((r) => (release = r));
    return "first";
  });
  // Synchronously after the first call: the lock is already held.
  assert.equal(sessionBusy(), true);
  const second = await withSessionLock(async () => {
    started++;
    return "second";
  });
  assert.equal(second, undefined);
  assert.equal(started, 1);
  release();
  assert.equal(await first, "first");
  assert.equal(sessionBusy(), false);
  assert.equal(await withSessionLock(async () => "third"), "third");
});

test("the lock is released when the sequence fails", async () => {
  await assert.rejects(withSessionLock(async () => { throw new Error("network"); }));
  assert.equal(sessionBusy(), false);
});
