import { describe, expect, it } from "vitest";

import { blendProviderResults, type FoodProviderId } from "@/lib/logic/food";

/**
 * The quota draft, in isolation. The property under test: after local results
 * take their slots, no provider can crowd another out of the cap, and slots a
 * short provider cannot use flow to the others rather than going empty.
 */

function bucket(provider: FoodProviderId, foods: string[]) {
  return { provider, foods };
}

describe("blendProviderResults", () => {
  it("splits slots evenly when every provider has plenty", () => {
    const out = blendProviderResults(
      [bucket("usda", ["u1", "u2", "u3", "u4", "u5", "u6"]), bucket("off", ["o1", "o2", "o3", "o4", "o5", "o6"])],
      6,
    );

    expect(out.filter((id) => id.startsWith("u"))).toHaveLength(3);
    expect(out.filter((id) => id.startsWith("o"))).toHaveLength(3);
  });

  it("hands a short provider's unused share to the others", () => {
    const out = blendProviderResults(
      [bucket("usda", ["u1", "u2", "u3", "u4", "u5", "u6", "u7", "u8", "u9"]), bucket("off", ["o1"])],
      6,
    );

    expect(out).toContain("o1");
    expect(out.filter((id) => id.startsWith("u"))).toHaveLength(5);
  });

  it("preserves each provider's own ordering", () => {
    const out = blendProviderResults(
      [bucket("usda", ["u1", "u2", "u3"]), bucket("off", ["o1", "o2", "o3"])],
      6,
    );

    expect(out.filter((id) => id.startsWith("u"))).toEqual(["u1", "u2", "u3"]);
    expect(out.filter((id) => id.startsWith("o"))).toEqual(["o1", "o2", "o3"]);
  });

  it("returns everything, once, when the slots exceed the supply", () => {
    const out = blendProviderResults([bucket("usda", ["u1", "u2"]), bucket("off", ["o1"])], 25);
    expect(out).toHaveLength(3);
    expect(new Set(out).size).toBe(3);
  });

  it("gives a lone provider every slot", () => {
    const out = blendProviderResults([bucket("usda", ["u1", "u2", "u3", "u4"])], 3);
    expect(out).toEqual(["u1", "u2", "u3"]);
  });

  it("copes with three providers and uneven lists", () => {
    const out = blendProviderResults(
      [bucket("usda", ["u1", "u2", "u3", "u4"]), bucket("off", ["o1"]), bucket("local", ["l1", "l2"])],
      6,
    );

    // One round each, then the leftovers go to whoever still has foods.
    expect(out).toHaveLength(6);
    expect(out).toContain("o1");
    expect(out.filter((id) => id.startsWith("u"))).toEqual(["u1", "u2", "u3"]);
    expect(out.filter((id) => id.startsWith("l"))).toEqual(["l1", "l2"]);
  });

  it("returns nothing for zero slots or no providers", () => {
    expect(blendProviderResults([bucket("usda", ["u1"])], 0)).toEqual([]);
    expect(blendProviderResults([bucket("usda", ["u1"])], -1)).toEqual([]);
    expect(blendProviderResults([], 10)).toEqual([]);
  });

  it("ignores a provider that returned nothing", () => {
    const out = blendProviderResults([bucket("usda", []), bucket("off", ["o1", "o2"])], 4);
    expect(out).toEqual(["o1", "o2"]);
  });
});
