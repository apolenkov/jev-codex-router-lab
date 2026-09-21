import type {
  FallbackReason,
  PrecheckedInput,
  SemanticResponse,
} from "./contracts.js";

export interface SystemOneRequest {
  state: unknown;
  questions: Readonly<Record<string, unknown>>;
}

export interface SystemOneClientPort {
  systemOne(request: SystemOneRequest): Promise<unknown>;
}

export interface PassMetadata {
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface Pass1Result extends SemanticResponse {
  metadata: PassMetadata;
}

export interface Pass2Result {
  skillCandidates: readonly string[];
  metadata: PassMetadata;
}

export interface SemanticGateway {
  pass1(input: PrecheckedInput): Promise<Pass1Result>;
  pass2(input: PrecheckedInput, shortlist: readonly string[]): Promise<Pass2Result>;
}

export class SemanticGatewayError extends Error {
  constructor(
    readonly reason: FallbackReason,
    readonly metadata?: PassMetadata,
  ) {
    super(reason);
    this.name = "SemanticGatewayError";
  }
}
