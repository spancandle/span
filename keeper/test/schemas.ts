import { expect } from "vitest";
type Schema =
  | "string"
  | "number"
  | "boolean"
  | "integerString"
  | "csv"
  | { nullable: Schema }
  | { array: Schema }
  | { object: Record<string, Schema> };
const object = (fields: Record<string, Schema>): Schema => ({ object: fields }),
  array = (item: Schema): Schema => ({ array: item }),
  nullable = (item: Schema): Schema => ({ nullable: item });
const mark = object({
  burn: "integerString",
    side: "string",
    price: "integerString",
    publishTs: "integerString",
    slot: "integerString",
    sig: "string",
  }),
  read = nullable(
    object({
      price: "integerString",
      publishTs: "integerString",
      slot: nullable("integerString"),
      sig: nullable("string"),
    }),
  );
export const schemas: Record<string, Schema> = {
  state: object({
    v: "number",
    generated: "number",
    cluster: "string",
    genesis: "string",
    program: "string",
    slot: "integerString",
    clock: "integerString",
    config: object({
      admin: "string",
      usdcMint: "string",
      feed: "string",
      readWindow: "number",
      ageLimit: "number",
      buyCutoff: "number",
      spanMint: nullable("string"),
      spanTokenProgram: nullable("string"),
      burnPerMark: "integerString",
      nextTicketId: "integerString",
    }),
    candles: array(
      object({
        address: "string",
        t0: "integerString",
        readWindow: "number",
        ageLimit: "number",
        buyCutoff: "number",
        settleAfter: "integerString",
        reads: array(read),
        readHigh: "integerString",
        readLow: "integerString",
        tickets: object({
          open: "number",
          sold: "number",
          offers: array(
            object({
              address: "string",
              id: "integerString",
              premium: "integerString",
        strikeBps: "number",
            }),
          ),
        }),
      }),
    ),
  }),
  tickets: object({
    v: "number",
    generated: "number",
    tickets: array(
      object({
        address: "string",
        id: "integerString",
        t0: "integerString",
        seller: "string",
        buyer: nullable("string"),
        premium: "integerString",
        strikeBps: "number",
        state: "string",
        spanLoaded: "integerString",
        stepBps: "number",
        marker: "string",
        tailHigh: "integerString",
        tailLow: "integerString",
        marks: "number",
        burned: "integerString",
        markLog: array(mark),
      }),
    ),
  }),
  feed: object({
    v: "number",
    generated: "number",
    feed: "string",
    from: "integerString",
    ts: "csv",
    p: "csv",
    slots: "csv",
    gaps: array(
      object({
        a: "integerString",
        b: nullable("integerString"),
        reason: "string",
      }),
    ),
    candles: array(
      object({
        t0: "integerString",
        high: nullable("integerString"),
        low: nullable("integerString"),
        last: nullable(
          object({ price: "integerString", publishTs: "integerString" }),
        ),
        complete: "boolean",
      }),
    ),
  }),
  history: object({
    v: "number",
    generated: "number",
    receipts: array(
      object({
        ticket: "string",
        id: "integerString",
        t0: "integerString",
        outcome: "string",
        seller: "string",
        buyer: nullable("string"),
        premium: "integerString",
        strikeBps: "number",
        p0: "integerString",
        readHigh: "integerString",
        readLow: "integerString",
        tailHigh: "integerString",
        tailLow: "integerString",
        high: "integerString",
        low: "integerString",
        payout: "integerString",
        toBuyer: "integerString",
        toSeller: "integerString",
        spanReturned: "integerString",
        burned: "integerString",
        marks: "number",
        reads: "number",
        sig: "string",
        slot: "integerString",
        blockTime: nullable("integerString"),
        markLog: array(mark),
      }),
    ),
    withdrawals: array(
      object({
        ticket: "string",
        id: "integerString",
        t0: "integerString",
        seller: "string",
        returned: "integerString",
        sig: "string",
        slot: "integerString",
        blockTime: nullable("integerString"),
      }),
    ),
    candles: array(
      object({
        t0: "integerString",
        reads: array(read),
        readHigh: "integerString",
        readLow: "integerString",
        doves: nullable(
          object({
            high: nullable("integerString"),
            low: nullable("integerString"),
            complete: "boolean",
          }),
        ),
      }),
    ),
  }),
  chain: object({
    v: "number",
    generated: "number",
    cluster: "string",
    blockhash: "string",
    lastValidBlockHeight: "integerString",
    blockHeight: "integerString",
    hashAt: "number",
    listedAt: "number",
    fee: "integerString",
    recent: array(
      object({
        sig: "string",
        slot: "integerString",
        blockTime: nullable("integerString"),
        signer: "string",
        err: nullable("string"),
        events: array("string"),
      }),
    ),
  }),
  status: object({
    v: "number",
    generated: "number",
    cluster: "string",
    program: "string",
    state: object({ lastFullMs: "number", lastSlot: "integerString" }),
    history: object({
      lastSig: nullable("string"),
      lastSlot: nullable("integerString"),
      lagSecs: "number",
    }),
    feed: object({
      recording: "boolean",
      lastPublishTs: "integerString",
      lastSlot: "integerString",
      lagSecs: "number",
      openGaps: "number",
    }),
    counts1h: object({
      txs: "number",
      failed: "number",
      reads: "number",
      marks: "number",
      settles: "number",
    }),
    rpc1h: object({}),
    http: object({ requests1h: "number", busy1h: "number" }),
  }),
};
function validate(value: any, schema: Schema, path: string) {
  if (typeof schema === "string") {
    if (schema === "integerString") expect(value, path).toMatch(/^-?\d+$/);
    else if (schema === "csv")
      expect(value, path).toMatch(/^(?:-?\d+(?:,-?\d+)*)?$/);
    else expect(typeof value, path).toBe(schema);
    return;
  }
  if ("nullable" in schema) {
    if (value !== null) validate(value, schema.nullable, path);
    return;
  }
  if ("array" in schema) {
    expect(Array.isArray(value), path).toBe(true);
    value.forEach((v: any, i: number) =>
      validate(v, schema.array, `${path}[${i}]`),
    );
    return;
  }
  expect(value, path).toBeTypeOf("object");
  for (const [key, s] of Object.entries(schema.object)) {
    expect(value, path).toHaveProperty(key);
    validate(value[key], s, `${path}.${key}`);
  }
}
export function validateDocument(name: string, value: any) {
  validate(value, schemas[name], name);
  expect(value.v).toBe(1);
  if (name === "state" || name === "history")
    for (const c of value.candles) expect(c.reads).toHaveLength(13);
  if (name === "feed")
    expect(value.ts.split(",").length).toBe(value.p.split(",").length);
}
