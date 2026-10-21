/**
 * What the agent needs from a model, and nothing about which one it is.
 * A provider is a ModelClient: Gemini today, anything that can call tools
 * tomorrow.
 */

export interface ToolCall {
  name: string;
  args: unknown;
}

export interface ToolResult {
  name: string;
  /** What the tool answered, or { error } when it was refused. */
  output: unknown;
}

export type ModelMessage =
  | { role: 'user'; text?: string; toolResults?: ToolResult[] }
  | {
      role: 'model';
      text?: string;
      toolCalls?: ToolCall[];
      /**
       * The provider's own message, handed back as it came. Some providers
       * need parts of it (ex. thought signatures) in the next turn.
       */
      raw?: unknown;
    };

export interface ToolDeclaration {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  parameters: unknown;
}

export interface ModelRequest {
  system: string;
  messages: ModelMessage[];
  tools: ToolDeclaration[];
}

export interface ModelResponse {
  text: string;
  toolCalls: ToolCall[];
  raw?: unknown;
}

export interface ModelClient {
  generate(request: ModelRequest): Promise<ModelResponse>;
}
