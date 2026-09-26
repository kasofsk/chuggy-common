import { resultReportCharsMax } from "@chuggy/worker-contract/workerDocuments";

/** The account an agent is told to finish with, whose summary becomes the manifest's report. */
export const agentResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary"],
  properties: {
    verdict: { enum: ["Pass", "Fail"] },
    summary: { type: "string", minLength: 1, maxLength: resultReportCharsMax },
  },
};

/**
 * The verdict and summary an agent finished with. A summary longer than a
 * report holds is not refused here: the schema bounds it in code points and a
 * string's length counts code units, and the report is cut to the bound anyway.
 */
export function agentResult(value, runtime) {
  if (value?.verdict !== "Pass" && value?.verdict !== "Fail")
    throw new Error(`${runtime} returned no structured verdict`);
  if (typeof value.summary !== "string" || value.summary.length === 0)
    throw new Error(`${runtime} returned no structured verdict`);
  return value;
}
