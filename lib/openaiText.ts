/**
 * Minimal wrapper around OpenAI's Responses API for one-shot structured
 * text tasks (used by the memory extractor). Kept separate from the
 * realtime route since it's a completely different API surface.
 */

type JsonSchema = Record<string, unknown>;

export async function callStructured<T>(opts: {
  apiKey: string;
  model: string;
  input: string;
  schemaName: string;
  schema: JsonSchema;
}): Promise<T> {
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model,
      input: opts.input,
      text: {
        format: {
          type: "json_schema",
          name: opts.schemaName,
          strict: true,
          schema: opts.schema,
        },
      },
    }),
  });

  const raw = await r.text();
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`OpenAI Responses API returned non-JSON: ${raw.slice(0, 500)}`);
  }

  if (!r.ok) {
    throw new Error(`OpenAI Responses API error (${r.status}): ${JSON.stringify(data)}`);
  }

  const text = extractOutputText(data);
  if (!text) {
    throw new Error(`OpenAI Responses API returned no text output: ${JSON.stringify(data).slice(0, 500)}`);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Structured output was not valid JSON: ${text.slice(0, 500)}`);
  }
}

/**
 * The Responses API exposes a convenience `output_text` field in most
 * current SDKs/snapshots, but that's not guaranteed on every model
 * version reaching this raw REST call — fall back to walking `output`.
 */
function extractOutputText(data: any): string | null {
  if (typeof data?.output_text === "string" && data.output_text.length > 0) {
    return data.output_text;
  }

  if (Array.isArray(data?.output)) {
    for (const item of data.output) {
      if (Array.isArray(item?.content)) {
        for (const part of item.content) {
          if (typeof part?.text === "string" && part.text.length > 0) {
            return part.text;
          }
        }
      }
    }
  }

  return null;
}
