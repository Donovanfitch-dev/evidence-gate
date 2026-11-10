/**
 * Three-valued (strong Kleene) logic.
 *
 * A boolean gate has to decide what "no data" means, and it usually decides
 * silently. Carrying `unknown` as a first-class value keeps that decision
 * visible: absence of evidence is never promoted to success or to failure.
 */
export type Tri = "met" | "unmet" | "unknown";

/** Conjunction: one unmet operand decides it, even if other operands are unknown. */
export function all(values: readonly Tri[]): Tri {
  if (values.includes("unmet")) return "unmet";
  if (values.includes("unknown")) return "unknown";
  return "met";
}

/** Disjunction: one met operand decides it, even if others are unknown. */
export function any(values: readonly Tri[]): Tri {
  if (values.includes("met")) return "met";
  if (values.includes("unknown")) return "unknown";
  return "unmet";
}

/** Negation: unknown stays unknown. */
export function not(value: Tri): Tri {
  if (value === "met") return "unmet";
  if (value === "unmet") return "met";
  return "unknown";
}
