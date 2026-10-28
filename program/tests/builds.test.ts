import { getCompiledTransactionMessageDecoder } from "@solana/kit";
import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { FailedTransactionMetadata } from "litesvm";
import { Harness, PROGRAM, accountData } from "./harness.js";
import {
  devFeedInstruction,
  feedPda,
  decodeDevFeedEvents,
} from "./feed.js";
it("P0 excludes development instructions and non-DOVES owners from the public build", async () => {
  const idl = JSON.parse(
    readFileSync(new URL("../client/idl/span.json", import.meta.url), "utf8"),
  );
  expect(idl.instructions).toHaveLength(12);
  expect(idl.instructions.some((x: any) => x.name.startsWith("dev_"))).toBe(
    false,
  );
  const h = await Harness.create();
  await h.send(
    "no_dev_instruction",
    await devFeedInstruction("dev_feed_init", h.admin),
    h.admin,
    "",
  );
  const fake = await feedPda();
  h.clone((await import("../client/constants.js")).SOL_FEED, fake);
  const a = h.svm.getAccount(fake);
  if (!a.exists) throw Error();
  h.svm.setAccount({ ...a, programAddress: PROGRAM });
  await h.send(
    "no_dev_owner",
    h.ix("setFeed", { admin: h.admin, feed: fake }),
    h.stranger,
    "FeedInvalid",
  );
});
it("P0 devnet build gates both raw feed commands by upgrade authority before init", async () => {
  const h = await Harness.create({
      initialize: false,
      binary: "../target/devnet/span.so",
    }),
    feed = await feedPda();
  const unauthorized = await h.transaction(
    [await devFeedInstruction("dev_feed_init", h.stranger)],
    h.stranger,
  );
  const failed = h.svm.sendTransaction(unauthorized);
  expect(failed).toBeInstanceOf(FailedTransactionMetadata);
  if (!(failed instanceof FailedTransactionMetadata)) throw Error();
  expect(failed.meta().logs().join("\n")).toContain("NotUpgradeAuthority");
  expect(h.svm.getAccount(feed).exists).toBe(false);
  for (const instruction of [
    await devFeedInstruction("dev_feed_init", h.admin),
    await devFeedInstruction("dev_feed_write", h.admin, 8_246_000_000n, 1000n),
  ]) {
    const tx = await h.transaction([instruction], h.admin);
    const result = h.svm.sendTransaction(tx);
    if (result instanceof FailedTransactionMetadata)
      throw Error(result.meta().logs().join("\n"));
    const keys = getCompiledTransactionMessageDecoder().decode(
      tx.messageBytes,
    ).staticAccounts;
    const events = decodeDevFeedEvents(
      result
        .innerInstructions()
        .flat()
        .map((i) => ({
          programAddress: keys[i.instruction().programIdIndex()],
          data: i.instruction().data(),
        })),
    );
    expect(events).toHaveLength(1);
    expect(events[0].data.price).toBe(
      accountData(h.svm, feed).readBigUInt64LE(168),
    );
    expect(events[0].data.publishTs).toBe(
      accountData(h.svm, feed).readBigInt64LE(177),
    );
  }
  const d = accountData(h.svm, feed);
  expect(d.length).toBe(394);
  expect(d.subarray(0, 8).toString("hex")).toBe("70f98bd9d7d0f936");
  expect(d[176]).toBe(248);
  expect(d.readBigUInt64LE(168)).toBe(8_246_000_000n);
  expect(d.readBigInt64LE(177)).toBe(1000n);
  await h.send(
    "init_devnet",
    h.ix("init", {
      authority: h.admin,
      deployment: PROGRAM,
      programData: h.programData,
      feed,
      admin: h.admin.address,
      readWindow: 20,
      ageLimit: 20,
      buyCutoff: 5,
    }),
    h.admin,
  );
});

it('P0 rejects a program-owned oracle during default-build initialization', async () => {
  const h = await Harness.create({ initialize: false }), fake = await feedPda();
  h.clone((await import('../client/constants.js')).SOL_FEED, fake);
  const account = h.svm.getAccount(fake);
  if (!account.exists) throw Error('Missing oracle fixture');
  h.svm.setAccount({ ...account, programAddress: PROGRAM });
  await h.send('init_fake_owner', h.ix('init', {
    authority: h.admin, deployment: PROGRAM, programData: h.programData,
    feed: fake, admin: h.admin.address, readWindow: 20, ageLimit: 20, buyCutoff: 5,
  }), h.admin, 'FeedInvalid');
});
