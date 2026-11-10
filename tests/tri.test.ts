import { describe, expect, it } from "vitest";
import { all, any, not, type Tri } from "../src/tri.js";

const S: Tri = "met";
const V: Tri = "unmet";
const U: Tri = "unknown";

describe("three-valued logic", () => {
  it("all: an unmet operand decides, even next to an unknown", () => {
    expect(all([S, S])).toBe(S);
    expect(all([S, U])).toBe(U);
    expect(all([U, V])).toBe(V);
    expect(all([S, V])).toBe(V);
  });

  it("any: a met operand decides, even next to an unknown", () => {
    expect(any([V, V])).toBe(V);
    expect(any([V, U])).toBe(U);
    expect(any([U, S])).toBe(S);
  });

  it("not: unknown stays unknown", () => {
    expect(not(S)).toBe(V);
    expect(not(V)).toBe(S);
    expect(not(U)).toBe(U);
  });

  it("obeys De Morgan for every pair", () => {
    for (const a of [S, V, U]) {
      for (const b of [S, V, U]) {
        expect(not(all([a, b]))).toBe(any([not(a), not(b)]));
        expect(not(any([a, b]))).toBe(all([not(a), not(b)]));
      }
    }
  });
});
