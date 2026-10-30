import hours from "./release-hours.json" with { type: "json" };

/** Validate the standalone schedule before either process starts. */
export function releaseHours(rows: unknown = hours): readonly bigint[] {
  if (!Array.isArray(rows)) throw Error("Invalid release schedule");
  let previous = -1;
  return Object.freeze(rows.map((row) => {
    if (!row || !["CPI", "PPI", "Jobs", "FOMC"].includes(row.type) ||
        !Number.isSafeInteger(row.t) || row.t % 60 !== 0 || row.t <= previous)
      throw Error("Invalid release hour");
    previous = row.t;
    return BigInt(row.t) - 60n;
  }));
}
export const RELEASE_HOURS = releaseHours();
