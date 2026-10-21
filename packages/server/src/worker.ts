/**
 * Cloudflare Worker entry. Builds the app from the environment of each
 * request; the Firebase keys stay cached between requests by auth.ts.
 */

import { createApp } from './app';
import { readConfig, type Env } from './env';
import { GeminiModelClient, readSheetWithGemini } from './gemini/client';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const config = readConfig(env);
    const gemini = config.geminiApiKey
      ? { apiKey: config.geminiApiKey, model: config.geminiModel, baseUrl: config.geminiBaseUrl }
      : null;

    return createApp({
      config,
      model: gemini ? new GeminiModelClient(gemini) : null,
      readSheet: gemini ? pdf => readSheetWithGemini(gemini, pdf) : null
    }).fetch(request);
  }
};
