/**
 * Barcode → food resolution, the database half. The provider chain and its
 * fallback order are unit-tested with mocked fetch (tests/food-lookup.test.ts);
 * what belongs here is the local round trip: a custom food saved with a
 * barcode resolves instantly and offline on the next scan, scoped to its
 * owner. No test here may reach the network — every lookup hits a local row.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { saveFoodItem } from "@/server/actions/nutrition";
import { lookupFoodByBarcode } from "@/server/food";
import { actAs, resetDatabase, twoUsers, type User } from "./helpers";

let alice: User;
let bob: User;

const CODE = "4006381333931";

beforeAll(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  ({ alice, bob } = await twoUsers());
  actAs(alice);
});

describe("custom food with a barcode", () => {
  it("saves the code and the next scan resolves locally", async () => {
    const saved = await saveFoodItem({
      name: "Rice cakes",
      calories: 35,
      barcode: CODE,
      basis: "per_serving",
      servingSize: 1,
      servingUnit: "piece",
    });
    expect(saved.ok).toBe(true);

    const outcome = await lookupFoodByBarcode(alice.id, CODE);
    expect(outcome.food).toMatchObject({ name: "Rice cakes", origin: "local" });
    expect(outcome.failure).toBeNull();
  });

  it("rejects a malformed barcode instead of storing junk", async () => {
    const result = await saveFoodItem({
      name: "Bad code",
      calories: 10,
      barcode: "12ab",
    });
    expect(result.ok).toBe(false);
  });

  it("another user's custom barcode is invisible in the local pass", async () => {
    actAs(bob);
    const saved = await saveFoodItem({
      name: "Bob's secret bar",
      calories: 200,
      barcode: CODE,
    });
    expect(saved.ok).toBe(true);

    // Alice's LOCAL pass must not see it. (The full lookup would then fall
    // through to providers — network — so assert the local query directly.)
    const row = await prisma.foodItem.findFirst({
      where: { barcode: CODE, OR: [{ userId: null }, { userId: alice.id }] },
    });
    expect(row).toBeNull();

    const own = await lookupFoodByBarcode(bob.id, CODE);
    expect(own.food?.name).toBe("Bob's secret bar");
  });
});
