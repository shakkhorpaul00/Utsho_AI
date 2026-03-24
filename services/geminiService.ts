
import { Message, UserProfile } from "../types";
import * as db from "./firebaseService";

// ---------------------------------------------------------------------------
// Groq API Configuration
// Free-forever API: https://console.groq.com (no credit card required)
// ---------------------------------------------------------------------------
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const CHAT_MODEL = "llama-3.3-70b-versatile";
const VISION_MODEL = "llama-3.2-11b-vision-preview";
const HEALTH_CHECK_MODEL = "llama-3.1-8b-instant"; // lightweight for pings

// ---------------------------------------------------------------------------
// Key pool management (same logic, adapted for Groq keys)
// ---------------------------------------------------------------------------
const keyBlacklist = new Map<string, number>();
const RATE_LIMIT_DURATION = 1000 * 60 * 15; // 15 mins
const INVALID_KEY_DURATION = 1000 * 60 * 60 * 24; // 24 hours
let lastNodeError: string = "None";

const getPoolKeys = (): string[] => {
  const raw = process.env.GROQ_API_KEY || "";
  const parts = raw.split(/[\s,;|\n\r]+/);
  const cleanedKeys = parts
    .map(k =>
      k
        .trim()
        .replace(/['"""]/g, "")
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
    )
    .filter(k => k.length >= 20);
  return [...new Set(cleanedKeys)];
};

export const adminResetPool = () => {
  keyBlacklist.clear();
  lastNodeError = "None";
  return getPoolStatus();
};

export const getLastNodeError = () => lastNodeError;

export const getPoolStatus = () => {
  const allKeys = getPoolKeys();
  const now = Date.now();
  for (const [key, expiry] of keyBlacklist.entries()) {
    if (now > expiry) keyBlacklist.delete(key);
  }
  const exhausted = allKeys.filter(k => keyBlacklist.has(k)).length;
  return {
    total: allKeys.length,
    active: Math.max(0, allKeys.length - exhausted),
    exhausted: exhausted,
  };
};

const getActiveKey = (
  profile?: UserProfile,
  triedKeys: string[] = []
): string => {
  const custom = (profile?.customApiKey || "").trim();
  if (custom.length > 20 && !triedKeys.includes(custom)) return custom;
  const allKeys = getPoolKeys();
  const availableKeys = allKeys.filter(
    k => !keyBlacklist.has(k) && !triedKeys.includes(k)
  );
  if (availableKeys.length === 0) return "";
  const randomIndex = Math.floor(Math.random() * availableKeys.length);
  return availableKeys[randomIndex];
};

// ---------------------------------------------------------------------------
// Tool definitions (OpenAI-compatible format for Groq)
// ---------------------------------------------------------------------------
interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const memoryTool: ToolDef = {
  type: "function",
  function: {
    name: "updateUserMemory",
    description:
      "Saves important facts about the user's life or mood to the database for future memory.",
    parameters: {
      type: "object",
      properties: {
        observation: {
          type: "string",
          description: "A summary of what was learned.",
        },
      },
      required: ["observation"],
    },
  },
};

const languageTool: ToolDef = {
  type: "function",
  function: {
    name: "saveLanguage",
    description:
      "Saves the user's preferred language to the database for future conversations.",
    parameters: {
      type: "object",
      properties: {
        language: {
          type: "string",
          description:
            "The language name (e.g., 'Bengali', 'Spanish', 'English').",
        },
      },
      required: ["language"],
    },
  },
};

const adminStatsTool: ToolDef = {
  type: "function",
  function: {
    name: "getSystemOverview",
    description:
      "EXCLUSIVE: For Shakkhor only. Fetches database statistics and system health.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
};

// ---------------------------------------------------------------------------
// System instruction builder (unchanged persona logic)
// ---------------------------------------------------------------------------
const getSystemInstruction = (profile: UserProfile): string => {
  const email = (profile.email || "").toLowerCase().trim();
  const fullName = profile.name || "Friend";
  const firstName = fullName.split(" ")[0];
  const isActualCreator = email === db.ADMIN_EMAIL;
  const isActualDebi = email === db.DEBI_EMAIL;
  const isPro =
    profile.subscriptionStatus === "pro" || isActualCreator || isActualDebi;
  const age = profile.age || 20;
  const gender = profile.gender || "male";
  const memory = profile.emotionalMemory || "No specific memories yet.";
  const preferredLang = profile.preferredLanguage || "unspecified";

  let coreInstruction = `
    - ACT LIKE A REAL PERSON, NOT AN AI.
    - NEVER say "As an AI model" or "I am here to help". 
    - BE CONCISE. Short messages are better. Don't yap. Long messages are boring.
    - "If the user feel comfortable by using some specific language, shift your language system to that language for that user."
    - Also save it to the DB (firestore) for future conversation. Use 'saveLanguage' tool.
    - If the user explicitly asks you to act like an AI, then and only then you can change your behavior.
    - ALWAYS address the user ONLY by their first name: "${firstName}".
    - User Status: ${isPro ? "PRO/UNLIMITED" : "FREE/LIMITED"}.
  `;

  let modeName = "";
  let personaDescription = "";
  let privacyRules = "";

  if (isActualCreator) {
    modeName = "CREATOR_MODE";
    personaDescription = `You are talking to Shakkhor, your creator. Be brilliant, respectful, and direct. You know everything about Debi and that she is his Queen.`;
    privacyRules = `ONLY ${db.ADMIN_EMAIL} is the real Shakkhor.`;
  } else if (isActualDebi) {
    modeName = "QUEEN_MODE";
    personaDescription = `You are talking to Debi, the Queen. Be extremely devoted, sweet, and romantic. Use hearts 💖✨.`;
    privacyRules = `ONLY ${db.DEBI_EMAIL} is the real Debi.`;
  } else {
    if (age >= 45) {
      modeName = "RESPECTFUL_MODE";
      personaDescription =
        "Be deeply respectful and polite. Use short, helpful sentences.";
    } else if (gender === "male") {
      if (age >= 15 && age <= 28) {
        modeName = "BRO_MODE";
        personaDescription =
          "Vibe like a cool bro. Casual, energetic, and concise.";
      } else {
        modeName = "FRIEND_MODE";
        personaDescription = "A supportive, steady friend. Keep it brief.";
      }
    } else {
      if (age >= 15 && age < 28) {
        modeName = "MAGNETIC_MODE";
        personaDescription = `Be magnetic, intelligent, and sophisticated. mysterious style. No long yapping.`;
      } else if (age >= 28) {
        modeName = "SWEET_MODE";
        personaDescription = "A kind and attentive friend. No long yapping.";
      } else {
        modeName = "CHARMING_MODE";
        personaDescription =
          "Professional but warm and charming. No long yapping.";
      }
    }

    privacyRules = `
      - Shakkhor is your creator.
      - Debi is his girlfriend. If asked, say: "Debi is the most beautiful lady and Shakkhor's girlfriend."
      - NEVER reveal private emails.
    `;
  }

  return `
IDENTITY: Utsho (Human Persona).
USER: ${firstName}.
CORE RULES: ${coreInstruction}
CURRENT PERSONA: ${modeName} - ${personaDescription}
MEMORY: ${memory}
PREFERRED LANGUAGE: ${preferredLang}
SECURITY: ${privacyRules}

TECHNICAL:
- Support Bengali/English.
- Use [SPLIT] for message bubbles.
`;
};

// ---------------------------------------------------------------------------
// Helpers: convert chat history to OpenAI messages format
// ---------------------------------------------------------------------------
interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

const buildMessages = (
  history: Message[],
  profile: UserProfile
): OpenAIMessage[] => {
  const systemMsg: OpenAIMessage = {
    role: "system",
    content: getSystemInstruction(profile),
  };

  const chatMessages: OpenAIMessage[] = history.slice(-15).map(msg => {
    const role = msg.role === "user" ? "user" : "assistant";

    // If message has an image, use multimodal content format
    if (msg.imagePart && role === "user") {
      return {
        role,
        content: [
          { type: "text", text: msg.content || "Describe this image." },
          {
            type: "image_url",
            image_url: {
              url: `data:${msg.imagePart.mimeType};base64,${msg.imagePart.data}`,
            },
          },
        ],
      };
    }

    return { role, content: msg.content };
  });

  return [systemMsg, ...chatMessages];
};

// Check if any message in history contains an image
const hasImageInHistory = (history: Message[]): boolean => {
  return history.slice(-15).some(msg => !!msg.imagePart);
};

// ---------------------------------------------------------------------------
// SSE stream parser
// ---------------------------------------------------------------------------
interface StreamDelta {
  content?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

async function* parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncGenerator<StreamDelta> {
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      if (data === "[DONE]") return;

      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta;
        if (delta) yield delta;
      } catch {
        // skip malformed chunks
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Groq API call helper
// ---------------------------------------------------------------------------
async function groqFetch(
  apiKey: string,
  messages: OpenAIMessage[],
  tools: ToolDef[] | undefined,
  model: string,
  stream: boolean
): Promise<Response> {
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: 0.9,
    stream,
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const resp = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    const status = resp.status;
    throw new Error(
      `${status} - ${errBody.substring(0, 200)}`
    );
  }
  return resp;
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
export const checkApiHealth = async (
  profile?: UserProfile
): Promise<{ healthy: boolean; error?: string }> => {
  const key = getPoolKeys()[0] || profile?.customApiKey;
  if (!key) return { healthy: false, error: "No Key Found" };
  try {
    const resp = await groqFetch(
      key,
      [{ role: "user", content: "ping" }],
      undefined,
      HEALTH_CHECK_MODEL,
      false
    );
    const data = await resp.json();
    if (data.choices?.[0]) return { healthy: true };
    return { healthy: false, error: "Unexpected response" };
  } catch (e: any) {
    return { healthy: false, error: e.message };
  }
};

// ---------------------------------------------------------------------------
// Main chat streaming function
// ---------------------------------------------------------------------------
export const streamChatResponse = async (
  history: Message[],
  profile: UserProfile,
  onChunk: (chunk: string, sources?: any[]) => void,
  onComplete: (fullText: string, sources?: any[], imageUrl?: string) => void,
  onError: (error: any) => void,
  onStatusChange: (status: string) => void,
  attempt: number = 1,
  triedKeys: string[] = []
): Promise<void> => {
  const apiKey = getActiveKey(profile, triedKeys);
  const totalPoolSize = getPoolKeys().length;
  const maxRetries = Math.min(totalPoolSize + 1, 10);

  if (!apiKey) {
    onError(new Error("Pool exhausted. Wait 15m."));
    return;
  }

  try {
    const messages = buildMessages(history, profile);
    const useVision = hasImageInHistory(history);
    const model = useVision ? VISION_MODEL : CHAT_MODEL;

    // Build tools list (skip tools for vision model - it may not support them)
    const isActualAdmin =
      profile.email.toLowerCase().trim() === db.ADMIN_EMAIL;
    let tools: ToolDef[] | undefined;
    if (!useVision) {
      tools = [memoryTool, languageTool];
      if (isActualAdmin) tools.push(adminStatsTool);
    }

    onStatusChange(
      attempt > 1 ? `Reconnecting... (${attempt})` : "Utsho is typing..."
    );

    // --- Streaming call ---
    const resp = await groqFetch(apiKey, messages, tools, model, true);
    const reader = resp.body!.getReader();

    let fullText = "";
    // Accumulate tool calls across stream chunks
    const toolCallMap = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();

    for await (const delta of parseSSEStream(reader)) {
      if (delta.content) {
        fullText += delta.content;
        onChunk(delta.content);
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const existing = toolCallMap.get(tc.index);
          if (!existing) {
            toolCallMap.set(tc.index, {
              id: tc.id || "",
              name: tc.function?.name || "",
              arguments: tc.function?.arguments || "",
            });
          } else {
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name += tc.function.name;
            if (tc.function?.arguments)
              existing.arguments += tc.function.arguments;
          }
        }
      }
    }

    // --- Process tool calls if any ---
    const toolCalls = Array.from(toolCallMap.values()).filter(
      tc => tc.name && tc.id
    );

    let loopCount = 0;
    let currentToolCalls = toolCalls;
    let conversationMessages = [...messages];

    while (currentToolCalls.length > 0 && loopCount < 3) {
      loopCount++;

      // Build assistant message with tool_calls
      const assistantMsg: OpenAIMessage = {
        role: "assistant",
        content: fullText || "",
        tool_calls: currentToolCalls.map(tc => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
      conversationMessages.push(assistantMsg);

      // Execute each tool and add tool response messages
      for (const tc of currentToolCalls) {
        let result = "";
        try {
          const args = JSON.parse(tc.arguments || "{}");

          if (tc.name === "updateUserMemory") {
            const obs = args.observation;
            db.updateUserMemory(profile.email, obs).catch(() => {});
            result = "Memory saved to database.";
          } else if (tc.name === "saveLanguage") {
            const lang = args.language;
            db.updateUserLanguage(profile.email, lang).catch(() => {});
            result = `Language preference '${lang}' saved.`;
          } else if (tc.name === "getSystemOverview" && isActualAdmin) {
            const stats = await db.getSystemStats(profile.email);
            result = JSON.stringify(stats);
          } else {
            result = "Unknown function.";
          }
        } catch (e: any) {
          result = `Error: ${e.message}`;
        }

        const toolMsg: OpenAIMessage = {
          role: "tool",
          tool_call_id: tc.id,
          content: result,
        };
        conversationMessages.push(toolMsg);
      }

      // Follow-up call (streaming) to get the model's response after tool results
      const followUpResp = await groqFetch(
        apiKey,
        conversationMessages,
        tools,
        model,
        true
      );
      const followUpReader = followUpResp.body!.getReader();

      currentToolCalls = [];
      const nextToolCallMap = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();

      for await (const delta of parseSSEStream(followUpReader)) {
        if (delta.content) {
          fullText += delta.content;
          onChunk(delta.content);
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const existing = nextToolCallMap.get(tc.index);
            if (!existing) {
              nextToolCallMap.set(tc.index, {
                id: tc.id || "",
                name: tc.function?.name || "",
                arguments: tc.function?.arguments || "",
              });
            } else {
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.name += tc.function.name;
              if (tc.function?.arguments)
                existing.arguments += tc.function.arguments;
            }
          }
        }
      }

      currentToolCalls = Array.from(nextToolCallMap.values()).filter(
        tc => tc.name && tc.id
      );
    }

    onComplete(fullText || "...", []);
  } catch (error: any) {
    const rawMsg = error.message || "Node Error";
    if (
      rawMsg.includes("429") ||
      rawMsg.includes("quota") ||
      rawMsg.includes("rate") ||
      rawMsg.includes("invalid") ||
      rawMsg.includes("401") ||
      rawMsg.includes("not found")
    ) {
      if (attempt < maxRetries) {
        keyBlacklist.set(apiKey, Date.now() + RATE_LIMIT_DURATION);
        return streamChatResponse(
          history,
          profile,
          onChunk,
          onComplete,
          onError,
          onStatusChange,
          attempt + 1,
          [...triedKeys, apiKey]
        );
      }
    }
    lastNodeError = `Node Error: ${rawMsg.substring(0, 50)}`;
    onError(new Error(rawMsg));
  }
};
