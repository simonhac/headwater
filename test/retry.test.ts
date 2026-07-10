import { describe, it, expect, vi } from "vitest";
import { withRetry } from "@/lib/retry";

describe("withRetry (ingestion hardening)", () => {
  it("returns immediately on first success", async () => {
    const fn = vi.fn(async () => "ok");
    expect(await withRetry(fn, [1, 1])).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a few times then succeeds", async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      if (++n < 3) throw new Error("blip");
      return "ok";
    });
    expect(await withRetry(fn, [1, 1])).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws the last error after exhausting all attempts", async () => {
    const fn = vi.fn(async () => {
      throw new Error("down");
    });
    await expect(withRetry(fn, [1, 1])).rejects.toThrow("down");
    expect(fn).toHaveBeenCalledTimes(3); // backoffs.length + 1
  });
});
