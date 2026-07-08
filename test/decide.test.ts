import { describe, it, expect } from "vitest";
import { decide } from "@/lib/decide";

describe("decide (pipeline branch graph)", () => {
  it("seen → duplicate, regardless of posting/existing", () => {
    for (const postingEnabled of [true, false]) {
      for (const existing of [true, false]) {
        expect(decide({ seen: true, postingEnabled, existing })).toBe("duplicate");
      }
    }
  });

  it("not-seen + posting disabled → preview, even with an existing story", () => {
    for (const existing of [true, false]) {
      expect(decide({ seen: false, postingEnabled: false, existing })).toBe("preview");
    }
  });

  it("not-seen + posting + existing story → merge", () => {
    expect(decide({ seen: false, postingEnabled: true, existing: true })).toBe("merge");
  });

  it("not-seen + posting + no existing → post", () => {
    expect(decide({ seen: false, postingEnabled: true, existing: false })).toBe("post");
  });

  it("precedence: duplicate > preview > merge > post", () => {
    expect(decide({ seen: true, postingEnabled: false, existing: true })).toBe("duplicate");
    expect(decide({ seen: false, postingEnabled: false, existing: true })).toBe("preview");
    expect(decide({ seen: false, postingEnabled: true, existing: true })).toBe("merge");
    expect(decide({ seen: false, postingEnabled: true, existing: false })).toBe("post");
  });
});
