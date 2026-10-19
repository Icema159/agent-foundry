import type { ModelProvider } from "./types.js";
import { OllamaProvider } from "./ollama-provider.js";
import { OpenAIProvider } from "./openai-provider.js";

export type ModelProviderFactoryOptions = {
  ollamaBaseUrl?: string;
  openAIApiKey?: string;
};

export class ModelProviderFactory {
  constructor(private readonly options: ModelProviderFactoryOptions = {}) {}

  create(providerName: string, modelName: string): ModelProvider {
    if (providerName === "ollama") {
      return new OllamaProvider({ model: modelName, baseUrl: this.options.ollamaBaseUrl });
    }
    if (providerName === "openai") {
      return new OpenAIProvider({ model: modelName, apiKey: this.options.openAIApiKey });
    }
    throw new Error(`Unknown model provider: ${providerName}`);
  }
}
