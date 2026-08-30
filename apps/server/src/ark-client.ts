import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";

/**
 * One-shot text completion against the configured Ark model (OpenAI-compatible
 * `/responses` endpoint). Used for the pre-commit OWASP classification so it is a
 * single request with no agent loop, no tools, and no conversation history.
 */
export async function arkClassify(config: AppConfig, prompt: string): Promise<string> {
  const url = config.arkBaseUrl.replace(/\/+$/, "") + "/responses";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + config.arkApiKey,
      },
      body: JSON.stringify({ model: config.arkModel, input: prompt, stream: false }),
      signal: controller.signal,
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new HttpError(
        502,
        "Security model call failed (" + response.status + "): " + raw.slice(0, 300),
      );
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return raw; // some gateways return the completion as plain text
    }
    const text = extractResponseText(data);
    if (!text) {
      throw new HttpError(502, "Security model returned an empty response.");
    }
    return text;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const message =
      error instanceof Error && error.name === "AbortError"
        ? "the request timed out"
        : error instanceof Error
          ? error.message
          : String(error);
    throw new HttpError(502, "Security model call failed: " + message);
  } finally {
    clearTimeout(timer);
  }
}

/** Pull the assistant text out of a Responses-API or chat-completions payload. */
function extractResponseText(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const record = data as Record<string, unknown>;

  if (typeof record.output_text === "string") return record.output_text;

  if (Array.isArray(record.output)) {
    const parts: string[] = [];
    for (const item of record.output) {
      if (!item || typeof item !== "object") continue;
      const content = (item as Record<string, unknown>).content;
      if (Array.isArray(content)) {
        for (const piece of content) {
          const t = (piece as Record<string, unknown>)?.text;
          if (typeof t === "string") parts.push(t);
        }
      } else if (typeof (item as Record<string, unknown>).text === "string") {
        parts.push((item as Record<string, unknown>).text as string);
      }
    }
    if (parts.length) return parts.join("");
  }

  const choices = record.choices;
  if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") {
    const message = (choices[0] as Record<string, unknown>).message;
    const content = message && typeof message === "object"
      ? (message as Record<string, unknown>).content
      : undefined;
    if (typeof content === "string") return content;
  }

  return "";
}
