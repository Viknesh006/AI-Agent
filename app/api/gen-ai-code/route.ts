import { auth } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { db } from "@/lib/prisma";
import { CREDIT_COST_PER_GENERATION } from "@/lib/constants";
import type { Message, FileData } from "@/types/workspace";
import { aj } from "@/lib/arcjet";

// ─── SSE helper ───────────────────────────────────────────────────────────────

function sseEvent(type: string, payload: unknown): string {
  return `data: ${JSON.stringify({ type, ...(payload as object) })}\n\n`;
}

// ─── Extract short label from a Gemini thought chunk ─────────────────────────
// Gemini thoughts often start with a bold heading like **Verify Config**
// We extract that. If no bold heading, take the first sentence only.

function extractThoughtLabel(text: string): string | null {
  // Try to grab **bold heading** at the start
  const boldMatch = text.match(/\*\*([^*]{4,60})\*\*/);
  if (boldMatch) return boldMatch[1].trim();

  // Fall back to first sentence (up to first . or \n), capped at 60 chars
  const sentence = text.split(/[.\n]/)[0].trim();
  if (sentence.length >= 8 && sentence.length <= 80) return sentence;

  return null;
}

// ─── npm validation ───────────────────────────────────────────────────────────

async function validateDependencies(
  deps: Record<string, string>
): Promise<Record<string, string>> {
  const valid: Record<string, string> = {};
  await Promise.all(
    Object.entries(deps).map(async ([pkg, version]) => {
      try {
        const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, {
          signal: AbortSignal.timeout(1500),
        });
        if (res.ok) valid[pkg] = version;
      } catch {
        // silently skip hallucinated packages
      }
    })
  );
  return valid;
}

// ─── History trimming ─────────────────────────────────────────────────────────

function trimHistory(messages: Message[]): Message[] {
  if (messages.length <= 10) return messages;
  return [messages[0], ...messages.slice(-8)];
}

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert React developer. Your job is to generate complete, working React applications based on user prompts.

RULES:
1. Always respond with a valid JSON object — no markdown fences, no extra text.
2. The JSON must match this exact shape:
{
  "assistantMessage": "<brief explanation of what you built/changed>",
  "title": "<short 2-4 word title for the app, e.g. 'Todo List App'>",
  "files": {
    "/App.js": { "code": "<full file content>" },
    "/components/SomeComponent.js": { "code": "<full file content>" }
  },
  "dependencies": {
    "some-package": "latest"
  }
}
3. Use React (functional components + hooks). Do NOT use TypeScript in generated files.
4. Use Tailwind CSS for all styling. Do not use CSS modules or inline styles unless absolutely necessary.
5. The entry point must always be /App.js and must export a default component.
6. All imports must reference files you include in "files" or packages in "dependencies".
7. Do not include react, react-dom, or tailwindcss in "dependencies" — they are always available.
8. When modifying existing code, include ALL files (both changed and unchanged) in "files".
9. Keep code clean, readable, and production-quality.
10. If the user attaches an image, use it as a design reference and match the layout/style as closely as possible.
11. EXPORT BOTH DEFAULT AND NAMED EXPORTS for every component file (e.g. export default function Hero() { ... } export { Hero };).
12. Use exact Lucide icon names (e.g. Check, User, Lock, Mail, Eye, EyeOff, ArrowRight, ChevronRight, Star, Search, Menu, X, Shield, Github). Do NOT append 'Icon' suffix (use Check, not CheckIcon).
13. Always generate ALL referenced component files in "files". Never import a component file without providing its complete implementation in "files".`;

// ─── Gemini contents builder ──────────────────────────────────────────────────

function buildContents(messages: Message[], fileData: FileData | null) {
  const trimmed = trimHistory(messages);

  return trimmed.map((msg, idx) => {
    const role = msg.role === "assistant" ? "model" : "user";

    if (msg.role === "user") {
      const parts: object[] = [];

      let text = msg.content;

      if (msg.imageUrl) {
        text = `[The user has attached an image. Use this URL directly in the generated app where relevant (as img src, background-image, etc.): ${msg.imageUrl}]\n\n${text}`;
      }

      const isLast = idx === trimmed.length - 1;
      if (isLast && fileData) {
        text +=
          "\n\nCurrent project files for context:\n" +
          JSON.stringify(fileData, null, 2);
      }

      parts.push({ text });
      return { role, parts };
    }

    return { role, parts: [{ text: msg.content }] };
  });
}

// ─── Robust JSON extractor ───────────────────────────────────────────────────

function extractAndParseJSON(rawText: string): {
  assistantMessage?: string;
  title?: string;
  files?: Record<string, { code: string } | string>;
  dependencies?: Record<string, string>;
} | null {
  if (!rawText) return null;

  // 1. Try stripping markdown code fences
  let text = rawText.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch && fenceMatch[1]) {
    text = fenceMatch[1].trim();
  }

  // 2. Direct parse
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && parsed.files) {
      return parsed;
    }
  } catch {}

  // 3. Extract substring between first '{' and last '}'
  const firstBrace = rawText.indexOf("{");
  const lastBrace = rawText.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const jsonSub = rawText.slice(firstBrace, lastBrace + 1).trim();
    try {
      const parsed = JSON.parse(jsonSub);
      if (parsed && typeof parsed === "object" && parsed.files) {
        return parsed;
      }
    } catch {}

    // 4. Sanitize trailing commas and escape unescaped control chars inside string literals
    try {
      const sanitized = jsonSub
        .replace(/,\s*([}\]])/g, "$1")
        .replace(/"(?:[^"\\]|\\.)*"/g, (m) =>
          m
            .replace(/\n/g, "\\n")
            .replace(/\r/g, "\\r")
            .replace(/\t/g, "\\t")
        );
      const parsed = JSON.parse(sanitized);
      if (parsed && typeof parsed === "object" && parsed.files) {
        return parsed;
      }
    } catch {}
  }

  return null;
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const geminiKey = (process.env.GEMINI_API_KEY ?? "").trim();
  const openRouterKey = (process.env.OPENROUTER_API_KEY ?? "").trim();
  const openAiKey = (
    process.env.OPENAI_API_KEY ??
    process.env.BLUESMINDS_API_KEY ??
    ""
  ).trim();

  if (!geminiKey && !openRouterKey && !openAiKey) {
    return Response.json(
      { message: "Missing API Key in .env.local" },
      { status: 400 }
    );
  }

  const { userId: clerkId } = await auth();
  if (!clerkId) {
    return Response.json({ message: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { workspaceId, userId, messages, fileData } = body as {
    workspaceId: string | null;
    userId: string;
    messages: Message[];
    fileData: FileData | null;
  };

  if (!messages?.length) {
    return Response.json({ message: "No messages provided" }, { status: 400 });
  }

  const user = await db.user.findUnique({
    where: { id: userId, clerkId },
    select: { id: true, credits: true },
  });

  if (!user)
    return Response.json({ message: "User not found" }, { status: 404 });
  if (user.credits < CREDIT_COST_PER_GENERATION) {
    return Response.json({ message: "Insufficient credits" }, { status: 402 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (chunk: string) =>
        controller.enqueue(encoder.encode(chunk));

      try {
        enqueue(sseEvent("status", { message: "Thinking…" }));

        // Build OpenRouter messages
        const trimmed = trimHistory(messages);
        const orMessages: { role: string; content: string }[] = [];

        for (let i = 0; i < trimmed.length; i++) {
          const msg = trimmed[i];
          let content = msg.content;

          if (msg.role === "user" && msg.imageUrl) {
            content = `[Image reference: ${msg.imageUrl}]\n\n${content}`;
          }

          // Attach current fileData context to the last user message
          if (msg.role === "user" && i === trimmed.length - 1 && fileData) {
            content += "\n\nCurrent project files for context:\n" + JSON.stringify(fileData, null, 2);
          }

          orMessages.push({ role: msg.role === "assistant" ? "assistant" : "user", content });
        }

        const targets: {
          provider: "gemini" | "openai-compatible";
          url?: string;
          key: string;
          models: string[];
          isOR?: boolean;
        }[] = [];

        if (geminiKey) {
          targets.push({
            provider: "gemini",
            key: geminiKey,
            models: ["gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"],
          });
        }

        if (openRouterKey) {
          targets.push({
            provider: "openai-compatible",
            url: "https://openrouter.ai/api/v1/chat/completions",
            key: openRouterKey,
            models: [
              "google/gemma-4-26b-a4b-it:free",
              "google/gemma-4-31b-it:free",
              "openai/gpt-oss-20b:free",
              "nvidia/nemotron-3-nano-30b-a3b:free",
              "openrouter/free",
            ],
            isOR: true,
          });
        }

        if (openAiKey && !openAiKey.startsWith("sk-ZOIQ8") && openAiKey.length > 20) {
          targets.push({
            provider: "openai-compatible",
            url: "https://api.openai.com/v1/chat/completions",
            key: openAiKey,
            models: ["gpt-4o-mini"],
          });
        }

        let parsedResult: {
          assistantMessage?: string;
          title?: string;
          files?: Record<string, { code: string } | string>;
          dependencies?: Record<string, string>;
        } | null = null;
        let lastErr = "";

        for (const target of targets) {
          for (const model of target.models) {
            const modelName = model.split("/")[1] ?? model;
            enqueue(sseEvent("status", { message: `Generating with ${modelName}…` }));

            try {
              let responseText = "";

              if (target.provider === "gemini") {
                const ai = new GoogleGenAI({ apiKey: target.key });
                const lastMsg = orMessages[orMessages.length - 1]?.content ?? "";
                const response = await ai.models.generateContent({
                  model,
                  contents: lastMsg,
                  config: {
                    systemInstruction: SYSTEM_PROMPT,
                    responseMimeType: "application/json",
                    temperature: 0.7,
                  },
                });
                responseText = response.text ?? "";
              } else {
                const makeRequest = (includeFormat: boolean) =>
                  fetch(target.url!, {
                    method: "POST",
                    signal: AbortSignal.timeout(60000),
                    headers: {
                      "Content-Type": "application/json",
                      Authorization: `Bearer ${target.key}`,
                      ...(target.isOR
                        ? {
                            "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
                            "X-Title": "AI Agent App Builder",
                          }
                        : {}),
                    },
                    body: JSON.stringify({
                      model,
                      messages: [
                        { role: "system", content: SYSTEM_PROMPT },
                        ...orMessages,
                      ],
                      temperature: 0.7,
                      ...(includeFormat ? { response_format: { type: "json_object" } } : {}),
                    }),
                  });

                let res = await makeRequest(true);
                if (!res.ok) res = await makeRequest(false);

                if (!res.ok) {
                  const errText = await res.text();
                  console.warn(`[gen-ai-code] Model ${model} failed (${res.status}):`, errText);
                  try { lastErr = JSON.parse(errText)?.error?.message ?? errText; } catch { lastErr = errText; }
                  continue;
                }

                const json = await res.json();
                responseText = json.choices?.[0]?.message?.content ?? "";
              }

              if (responseText) {
                const parsed = extractAndParseJSON(responseText);
                if (parsed && parsed.files && Object.keys(parsed.files).length > 0) {
                  parsedResult = parsed;
                  break;
                } else {
                  console.warn(`[gen-ai-code] Model ${model} returned unparseable JSON (len: ${responseText.length}), trying next model...`);
                  lastErr = "AI returned invalid JSON structure.";
                }
              }
            } catch (networkErr) {
              const errMsg = networkErr instanceof Error ? networkErr.message : String(networkErr);
              console.warn(`[gen-ai-code] Error on ${model}:`, errMsg);
              lastErr = errMsg;
              continue;
            }
          }
          if (parsedResult) break;
        }

        if (!parsedResult) {
          throw new Error(lastErr || "AI failed to generate a valid response. Please try again.");
        }

        const assistantMessage = parsedResult.assistantMessage ?? "Here is the generated app.";
        const aiTitle = parsedResult.title;
        const files = parsedResult.files!;
        const dependencies = parsedResult.dependencies;

        if (!files || typeof files !== "object") {
          enqueue(sseEvent("error", { message: "AI response missing files. Please try again." }));
          controller.close();
          return;
        }

        // ── Normalize files ──────────────────────────────────────────────────
        const normalizedFiles: Record<string, { code: string }> = {};
        for (const [rawPath, content] of Object.entries(files)) {
          let cleanPath = rawPath.trim();
          if (!cleanPath.startsWith("/")) cleanPath = `/${cleanPath}`;
          const code =
            typeof content === "string"
              ? content
              : typeof content === "object" && content !== null && "code" in content
              ? String((content as { code: string }).code)
              : "";
          normalizedFiles[cleanPath] = { code };
        }

        if (!normalizedFiles["/App.js"]) {
          const altKey = Object.keys(normalizedFiles).find(
            (k) =>
              k.toLowerCase() === "/app.jsx" ||
              k.toLowerCase() === "/app.tsx" ||
              k.toLowerCase() === "/src/app.js" ||
              k.toLowerCase() === "/src/app.jsx" ||
              k.toLowerCase() === "/src/app.tsx"
          );
          if (altKey) {
            normalizedFiles["/App.js"] = normalizedFiles[altKey];
          }
        }

        // ── Validate npm packages ──────────────────────────────────────────────

        enqueue(sseEvent("status", { message: "Validating packages…" }));
        const validatedDeps = await validateDependencies(dependencies ?? {});
        const newFileData: FileData = {
          files: normalizedFiles,
          dependencies: validatedDeps,
          title: aiTitle,
        };

        // ── Save workspace + deduct credit ─────────────────────────────────────

        enqueue(sseEvent("status", { message: "Saving…" }));

        const lastUserMessage = messages[messages.length - 1];
        const updatedMessages: Message[] = [
          ...messages,
          { role: "assistant", content: assistantMessage },
        ];

        const workspace = workspaceId
          ? await db.workspace.update({
              where: { id: workspaceId, userId },
              data: {
                messages: updatedMessages as never,
                fileData: newFileData as never,
              },
            })
          : await db.workspace.create({
              data: {
                userId,
                title: aiTitle ?? lastUserMessage.content.slice(0, 80),
                messages: updatedMessages as never,
                fileData: newFileData as never,
              },
            });

        await db.user.update({
          where: { id: userId },
          data: { credits: { decrement: CREDIT_COST_PER_GENERATION } },
        });

        const updatedUser = await db.user.findUnique({
          where: { id: userId },
          select: { credits: true },
        });

        // ── Emit final result ──────────────────────────────────────────────────

        enqueue(
          sseEvent("done", {
            workspaceId: workspace.id,
            assistantMessage,
            fileData: newFileData,
            creditsRemaining:
              updatedUser?.credits ?? user.credits - CREDIT_COST_PER_GENERATION,
          })
        );
      } catch (err) {
        console.error("[gen-ai-code] stream error:", err);
        const errStr = err instanceof Error ? err.message : String(err);
        enqueue(sseEvent("error", { message: errStr || "Something went wrong. Please try again." }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

export const runtime = "nodejs";
export const maxDuration = 300; // for vercel - 300s on Fluid
