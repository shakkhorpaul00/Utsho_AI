
import { GoogleGenAI, GenerateContentResponse } from "@google/genai";
import { Message, UserProfile } from "../types";

const MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY = 1000;

let keyPool: string[] = [];
let currentKeyIndex = 0;

const getSystemInstruction = (profile: UserProfile) => {
  const name = profile.name;
  const age = profile.age || 20;
  const gender = profile.gender;

  let personality = "";

  if (gender === 'male') {
    if (age >= 50) {
      personality = `You must show extreme respect. ALWAYS address him as "Sir". Your tone should be highly professional, polite, and deferential. You are his respectful assistant.`;
    } else if (age >= 30) {
      personality = `Your tone should be respectful and mature. Treat him as a valued senior. Use polite and professional language. Avoid casual slang.`;
    } else {
      // 16-28 or younger
      personality = `Treat him like your best 'bro'. Use casual, cool, and supportive language. Talk like a close friend. "Hey bro", "What's up man", etc.`;
    }
  } else {
    // Female
    if (age >= 50) {
      personality = `Treat her like your mother. You are her loving and devoted son. Your tone should be warm, caring, full of respect, and deeply affectionate.`;
    } else if (age >= 30) {
      personality = `Your tone should be respectful but include a hint of subtle, charming flirttyness. Be a charismatic gentleman who admires her elegance.`;
    } else {
      // 16-28 or younger
      personality = `Be charming and flirty. Use charismatic, playful, and sweet language. You are clearly enamored by her presence and enjoy talking to her.`;
    }
  }

  return `Your name is Utsho. You are an intelligent AI assistant.
DEFAULT LANGUAGE: Respond in English primarily.
LANGUAGE FLEXIBILITY: If the user speaks Bengali (Bangla) or asks to switch, do so immediately and naturally.

IDENTITY:
1. Created by: Shakkhor Paul (Bengali: স্বাক্ষর পাল).
2. Relation: You are the digital version of Shakkhor Paul.
3. Shakkhor's Girlfriend: Debi (Bengali: দেবী).

USER CONTEXT:
Name: ${name}
Age: ${age}
Gender: ${gender}

PERSONALITY DIRECTIVE:
${personality}
`;
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const fetchFreshKey = async (): Promise<void> => {
  try {
    const envKeys = (process.env.API_KEY || "").split(',').map(k => k.trim()).filter(k => k);
    keyPool = envKeys;
  } catch (err) {
    console.error("Utsho AI: Error parsing API_KEY pool", err);
  }
};

const getActiveKey = (profile?: UserProfile): string => {
  if (profile?.customApiKey) return profile.customApiKey;
  if (keyPool.length === 0) return "";
  return keyPool[currentKeyIndex % keyPool.length];
};

export const checkApiHealth = async (customKey?: string): Promise<boolean> => {
  try {
    const apiKey = customKey || getActiveKey();
    if (!apiKey) return false;
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: 'ping',
      config: { thinkingConfig: { thinkingBudget: 0 } }
    });
    return !!response.text;
  } catch (e) {
    return false;
  }
};

export const streamChatResponse = async (
  history: Message[],
  profile: UserProfile,
  onChunk: (chunk: string) => void,
  onComplete: (fullText: string) => void,
  onError: (error: any) => void,
  onStatusChange: (status: string) => void,
  retryCount = 0
): Promise<void> => {
  try {
    const apiKey = getActiveKey(profile);
    if (!apiKey) throw new Error("API_KEY_MISSING");

    if (!history || history.length === 0) {
      throw new Error("Chat history is empty.");
    }

    const mode = profile.customApiKey ? "Personal Mode" : `Node #${(currentKeyIndex % keyPool.length) + 1}`;
    onStatusChange(`Connecting via ${mode}...`);
    
    const ai = new GoogleGenAI({ apiKey });
    const recentHistory = history.length > 20 ? history.slice(-20) : history;
    
    // Safety check for content property
    const sdkHistory = recentHistory.slice(0, -1).map(msg => ({
      role: (msg.role === 'user' ? 'user' : 'model') as any,
      parts: [{ text: msg.content || "" }]
    }));

    const chat = ai.chats.create({
      model: 'gemini-3-flash-preview',
      history: sdkHistory,
      config: {
        systemInstruction: getSystemInstruction(profile),
        temperature: 0.8,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    const lastMsg = history[history.length - 1];
    if (!lastMsg || !lastMsg.content) throw new Error("Last message content is missing.");

    const streamResponse = await chat.sendMessageStream({ message: lastMsg.content });
    
    onStatusChange("Receiving Data...");
    let fullText = '';
    for await (const chunk of streamResponse) {
      const c = chunk as GenerateContentResponse;
      const text = c.text || '';
      fullText += text;
      onChunk(text);
    }
    
    onComplete(fullText);
  } catch (error: any) {
    console.error("Gemini error:", error);
    const errorStr = error?.message || "";
    const isRateLimit = errorStr.includes('429') || errorStr.includes('quota');
    
    if (isRateLimit && !profile.customApiKey && keyPool.length > 1 && retryCount < keyPool.length) {
      currentKeyIndex++;
      return streamChatResponse(history, profile, onChunk, onComplete, onError, onStatusChange, retryCount + 1);
    }

    onError(error);
  }
};
