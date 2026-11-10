# Design notes

## The model

There are four kinds of object.

- **Evidence** is an observation: a `kind`, the `revision` it is about, an `outcome`, when it was
  observed, and which `source` (and optionally which `actor`) reported it.
- A **requirement** names the kind of evidence that can meet it and the conditions that
  evidence has to meet: how fresh, from how many distinct actors, and what a disagreement means.
- The **gate** is a boolean expression over requirement ids.
- A **waiver** is a human decision to accept a requirement as met for one revision until a date.

Evaluation is a pure function of `(policy, evidence, waivers, revision, now)`.

## Why `unknown` has to be a value

Consider a gate written as `tests && scan && health`. If the scan did not run, a boolean
implementation has two options. It can treat the missing value as `false`, which reports a failure
that did not happen, or as `true`, which reports a check that did not happen. Either way the
report is wrong about the world, and the person reading it cannot tell.

With three values, the same expression yields `unknown`, and the report says which operand caused
it. Three-valued logic also gives the right answer in the cases where missing data does not
matter: if `tests` failed, the verdict is `NO_GO` whether or not the scan ran, and if one branch of
an `any` passed, the other branch being unknown changes nothing.

## Selecting evidence

For each requirement, records of the matching kind go through four filters in order.

1. **Revision.** Records about another revision are set aside as `other-revision`. This is the
   filter that catches a health check which ran against the previous deploy.
2. **Clock sanity.** A record observed later than `now` plus the skew allowance (300 seconds by
   default) is set aside as `future-dated`. It is more likely a broken clock than a prediction.
3. **Freshness.** With `maxAgeMinutes` set, older records are set aside as `expired`.
4. **Supersession.** Among what remains, only the latest record per `(source, actor)` is kept.
   Ties on the timestamp are broken by record id, so the result never depends on input order.

Everything set aside is listed in the report with its reason. A reader can see that evidence
existed and why it did not count.

## From evidence to a state

| What survived the filters | State | Reason code |
| --- | --- | --- |
| Passes and failures from different sources | `unknown`, or `unmet` with `onConflict: "unmet"` | `CONFLICT` |
| Failures only | `unmet` | `FAILED` |
| Passes, enough distinct actors (or no actor rule) | `met` | `PASSED` |
| Passes, too few distinct actors | `unknown` | `INSUFFICIENT_ACTORS` |
| Nothing, and expired records were set aside | `unknown` | `EXPIRED` |
| Nothing, and only other revisions had records | `unknown` | `WRONG_REVISION` |
| Nothing at all | `unknown` | `MISSING` |

The three "nothing" rows have the same state and different reason codes on purpose. They call for
different actions: re-run the check, run it on the right revision, or set it up in the first
place.

## Waivers

A waiver applies when its requirement id and revision match and it has not expired. It sets the
state the gate sees to `met` and the reason to `WAIVED`, and leaves `evidenceState` as the
evidence had it. The report's top-level `waived` flag is computed by evaluating the gate twice,
with and without waivers: it is true only when the verdict would have been different. A waiver on
a requirement that turned out not to matter does not mark the release as waived.

A waiver is bound to one revision. Shipping a new commit means the risk has to be accepted again.

## Reproducibility

`inputsDigest` is the SHA-256 of a canonical serialization (sorted object keys, evidence sorted by
id) of the policy, the revision, the evidence and the waivers. Two evaluations with the same
digest and the same `evaluatedAt` produce the same report. Storing the digest next to a release
record makes it possible to show later exactly which inputs a decision was made from.

The digest covers all supplied evidence, including records that were set aside, because what was
set aside is part of what the evaluator was shown.

## What a production version would add

- **Authenticated evidence.** Records signed by the collector, or delivered as attestations, so
  `source` and `actor` are verified rather than asserted.
- **Collectors.** Small adapters that turn a CI run, a review system or a deploy probe into
  evidence records.
- **A verdict history.** Appending each report to a store makes "what changed between the
  UNDETERMINED at 10:00 and the GO at 10:20" answerable.
- **Typed outcomes.** Numeric observations with thresholds in the policy, for requirements such as
  minimum coverage.

None of these change the core: evidence in, three-valued states, an explained verdict out.
