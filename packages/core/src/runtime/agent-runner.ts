export type RuntimeJsonValue = null | boolean | number | string | RuntimeJsonValue[] | { [key: string]: RuntimeJsonValue };
export type RuntimeJsonSchema = { [key: string]: RuntimeJsonValue };

export interface RuntimeModel {
  readonly provider: string;
  readonly model: string;
  readonly thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export interface RuntimeToolCall {
  readonly id: string;
  readonly input: RuntimeJsonValue;
  readonly signal: AbortSignal;
}

export interface RuntimeToolResult {
  readonly value: RuntimeJsonValue;
  readonly isError?: boolean;
}

export interface RuntimeTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: RuntimeJsonSchema;
  execute(call: RuntimeToolCall): Promise<RuntimeToolResult>;
}

export type RuntimeUsageAvailability = "complete" | "partial" | "unavailable";

export interface RuntimeUsage {
  readonly availability: RuntimeUsageAvailability;
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly costUsd?: number;
}

export interface RuntimeAgentIdentity {
  readonly id: string;
  readonly structuralPath: readonly string[];
  readonly parentId?: string;
}

export interface RuntimeRunIdentity {
  readonly id: string;
  readonly namespaceId: string;
  readonly workflowName: string;
}

export interface RuntimeAgentProgress {
  readonly usage: RuntimeUsage;
  readonly activity?: { readonly kind: "reasoning" | "tool" | "text"; readonly text: string };
  readonly lastEventAt?: number;
  readonly persist: boolean;
}
export interface RuntimeAgentRunRequest {
  readonly task: string;
  readonly cwd: string;
  readonly model: RuntimeModel;
  readonly enabledTools: readonly string[];
  readonly customTools: readonly RuntimeTool[];
  readonly resultSchema?: RuntimeJsonSchema;
  readonly run: RuntimeRunIdentity;
  readonly agent: RuntimeAgentIdentity;
  readonly signal: AbortSignal;
  readonly onProgress?: (progress: RuntimeAgentProgress) => void | Promise<void>;
  readonly onControl?: (control: { steer(message: string): Promise<void> }) => void | Promise<void>;
}

export interface RuntimeAgentReference {
  readonly transport: string;
  readonly locator?: RuntimeJsonValue;
}

export interface RuntimeAgentRunResult {
  readonly value: RuntimeJsonValue;
  readonly usage: RuntimeUsage;
  readonly reference?: RuntimeAgentReference;
}

export interface RuntimeAgentRunner {
  readonly id: string;
  readonly capabilities: {
    readonly customTools: boolean;
    readonly structuredResults: boolean;
    readonly steering: boolean;
    readonly usage: RuntimeUsageAvailability;
  };
  run(request: Readonly<RuntimeAgentRunRequest>): Promise<RuntimeAgentRunResult>;
}
