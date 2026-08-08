import { registerWorkflowExtension } from "../../src/index.js";

export default function (): void {
  registerWorkflowExtension({
    version: "1.0.0",
    headline: "Reusable development workflows",
    functions: {
      tddDev: {
        description: "Develop something using TDD, input a task and the shell command to run tests",
        input: { type: "object", required: ["task", "testCmd", "maxAttempts"], properties: { task: { type: "string" }, testCmd: { type: "string" }, maxAttempts: { type: "integer" } }, additionalProperties: false },
        output: { type: "object", required: ["error", "success"], properties: { error: { type: "string" }, success: { type: "string" } }, additionalProperties: false },
        run: async () => { throw new Error("The real-session test stops before tddDev executes"); },
      },
      developUntilApproved: {
        description: "Run developer and reviewer agents until review passes or the iteration limit is reached",
        input: { type: "object", required: ["task"], properties: { task: { type: "string" }, maxIterations: { type: "integer", minimum: 1 } }, additionalProperties: false },
        output: { type: "object", required: ["pass", "iterations", "devResult", "review"], properties: { pass: { type: "boolean" }, iterations: { type: "integer" }, devResult: {}, review: { type: "object", properties: {} } }, additionalProperties: false },
        run: async () => { throw new Error("The real-session test stops before developUntilApproved executes"); },
      },
    },
  });
}
