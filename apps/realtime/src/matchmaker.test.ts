import assert from "node:assert/strict";
import test from "node:test";
import { MemoryMatchmaker, compatible, sharedInterests } from "./matchmaker.js";

test("pairs visitors who share an interest and exposes that overlap", async () => {
  const matcher = new MemoryMatchmaker();
  await matcher.join("first", { language: "en", interests: ["music", "travel"] });
  const result = await matcher.join("second", { language: "en", interests: ["music"] });
  assert.equal(result.state, "matched");
  if (result.state === "matched") assert.deepEqual(result.match.sharedInterests, ["music"]);
});

test("does not pair visitors with incompatible selected interests", async () => {
  const matcher = new MemoryMatchmaker();
  await matcher.join("first", { language: "en", interests: ["music"] });
  const result = await matcher.join("second", { language: "en", interests: ["sports"] });
  assert.equal(result.state, "queued");
});

test("still matches users when both interest lists are empty", async () => {
  const matcher = new MemoryMatchmaker();
  await matcher.join("first", { language: "en", interests: [] });
  const result = await matcher.join("second", { language: "en", interests: [] });
  assert.equal(result.state, "matched");
  if (result.state === "matched") {
    assert.deepEqual(result.match.sharedInterests, []);
    assert.equal(result.peerSocketId, "first");
  }
});

test("sharedInterests and compatible reflect the exact overlap rules", () => {
  assert.deepEqual(sharedInterests({ language: "en", interests: ["music", "travel"] }, { language: "en", interests: ["music", "film"] }), ["music"]);
  assert.equal(compatible({ language: "en", interests: ["music"] }, { language: "en", interests: ["music"] }), true);
  assert.equal(compatible({ language: "en", interests: ["music"] }, { language: "en", interests: ["sports"] }), false);
  assert.equal(compatible({ language: "en", interests: [] }, { language: "en", interests: [] }), true);
});

test("increments message ordering once per active match", async () => {
  const matcher = new MemoryMatchmaker();
  await matcher.join("first", { language: "en", interests: [] });
  await matcher.join("second", { language: "en", interests: [] });
  assert.equal((await matcher.nextMessage("first"))?.sequence, 1);
  assert.equal((await matcher.nextMessage("second"))?.sequence, 2);
});
