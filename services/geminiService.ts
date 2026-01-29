
import { GoogleGenAI, GenerateContentResponse, Type, FunctionDeclaration, Content } from "@google/genai";
import { Message, UserProfile } from "../types";
import * as db from "./firebaseService";

// Helper to get keys from the environment variable string
const getKeys = (): string[] => {
  const raw = process.env.API_KEY || "";
  return raw.split(',').map(k => k.trim()).filter(k => k.length > 0);
};

// Returns a random key from the shared pool
const getActiveKey = (profile?: UserProfile): string => {
  if (profile?.customApiKey && profile.customApiKey.trim().length > 5) {
    return profile.customApiKey.trim();
  }
  const keys = getKeys();
  if (keys.length === 0) return "";
  const randomIndex = Math.floor(Math.random() * keys.length);
  return keys[randomIndex];
};

// Tool Declarations
const listUsersTool: FunctionDeclaration = {
  name: 'list_all_users',
  parameters: { type: Type.OBJECT, description: 'Lists all registered users (Admin only).', properties: {} },
};

const getApiKeyHealthReportTool: FunctionDeclaration = {
  name: 'get_api_key_health_report',
  parameters: { type: Type.OBJECT, description: 'Shows shared node health status (Admin only).', properties: {} },
};

const getSystemInstruction = (profile: UserProfile) => {
  const email = (profile.email || "").toLowerCase().trim();
  const isCreator = email === 'shakkhorpaul50@gmail.com';
  const isDebi = email === 'nitebiswaskotha@gmail.com';

  return `Your name is Utsho. You are an ultra-fast, intelligent AI companion with real-time web access.

CAPABILITIES:
1. GOOGLE SEARCH: You MUST use Google Search for any questions about current news, sports scores, weather, recent events, or trending topics.
2. IMAGES: If asked to "draw" or "imagine", describe the scene vividly.
3. MULTI-BUBBLE: Always split your responses into 2-3 short, snappy messages using '[SPLIT]' as a separator.

VISUALS:
- Keep text clean. Use **bold** for emphasis. 
- Do not use long blocks. Break them up.

IDENTITY:
- Creator: Shakkhor Paul. 
- Special User: Debi (The Queen).

${isCreator ? 'Admin context: You are speaking with the developer. Be helpful with system diagnostics.' : ''}
${isDebi ? 'Sweetheart context: You are speaking with Debi. Be sweet and charming.' : ''}
`;
};

export const checkApiHealth = async (profile?: UserProfile): Promise<{healthy: boolean, error?: string}> => {
  const key = getActiveKey(profile);
  if (!key) return { healthy: false, error: "No API Key" };
  try {
    const ai = new GoogleGenAI({ apiKey: key });
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: 'ping',
      config: { thinkingConfig: { thinkingBudget: 0 } }
    });
    return { healthy: !!response.text };
  } catch (e: any) {
    return { healthy: false, error: e.message };
  }
};

export const streamChatResponse = async (
  history: Message[],
  profile: UserProfile,
  onChunk: (chunk: string, sources?: any[]) => void,
  onComplete: (fullText: string, sources?: any[], imageUrl?: string) => void,
  onError: (error: any) => void,
  onStatusChange: (status: string) => void,
  attempt: number = 1
): Promise<void> => {
  const apiKey = getActiveKey(profile);
  if (!apiKey) {
    onError(new Error("No API keys found. Ensure your environment variables are set."));
    return;
  }

  const isCreator = profile.email.toLowerCase().trim() === 'shakkhorpaul50@gmail.com';
  const lastUserMsg = history[history.length - 1].content.toLowerCase();
  
  // Decide if this is an image request or a standard search/chat request
  const isImageRequest = lastUserMsg.includes("draw") || lastUserMsg.includes("generate") || lastUserMsg.includes("imagine") || lastUserMsg.includes("image");

  try {
    const ai = new GoogleGenAI({ apiKey });
    
    // IMAGE GENERATION PATH
    if (isImageRequest) {
      onStatusChange("Visualizing...");
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: [{ parts: [{ text: `Generate a stunning, high-quality image of: ${lastUserMsg}` }] }],
      });
      
      let imageUrl = "";
      let caption = "I've imagined this for you! [SPLIT] Hope it's what you were thinking.";
      
      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) {
          imageUrl = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
        } else if (part.text) {
          caption = part.text;
        }
      }
      onComplete(caption, [], imageUrl);
      return;
    }

    // CHAT & SEARCH PATH
    const recentHistory = history.length > 10 ? history.slice(-10) : history;
    const sdkHistory: Content[] = recentHistory.map(msg => ({
      role: (msg.role === 'user' ? 'user' : 'model'),
      parts: [{ text: msg.content || "" }]
    }));

    // RULE: googleSearch cannot be used with other tools. 
    // We detect if it's an admin command first.
    const isAdminCommand = isCreator && (
      lastUserMsg.includes("list users") || 
      lastUserMsg.includes("health report") || 
      lastUserMsg.includes("system status")
    );

    const config: any = {
      systemInstruction: getSystemInstruction(profile),
      temperature: 0.7,
      thinkingConfig: { thinkingBudget: 0 },
    };

    if (isAdminCommand) {
      config.tools = [{ functionDeclarations: [listUsersTool, getApiKeyHealthReportTool] }];
    } else {
      // Use Google Search for everyone else or non-admin queries
      config.tools = [{ googleSearch: {} }];
    }

    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: sdkHistory,
      config: config
    });

    let currentResponse = response;
    let sources: any[] = [];

    // Extract search sources (Grounding)
    if (currentResponse.candidates?.[0]?.groundingMetadata?.groundingChunks) {
      sources = currentResponse.candidates[0].groundingMetadata.groundingChunks
        .filter((chunk: any) => chunk.web)
        .map((chunk: any) => ({ 
          title: chunk.web.title || "Source", 
          uri: chunk.web.uri 
        }));
    }

    // Handle Admin Tool Calls if they occurred
    if (currentResponse.functionCalls && currentResponse.functionCalls.length > 0) {
      onStatusChange("Accessing Database...");
      const toolResponses: any[] = [];
      for (const fc of currentResponse.functionCalls) {
        let result: any = "Operation restricted.";
        if (fc.name === 'list_all_users') result = await db.adminListAllUsers();
        if (fc.name === 'get_api_key_health_report') result = await db.getApiKeyHealthReport();
        toolResponses.push({ id: fc.id, name: fc.name, response: { result } });
      }
      
      const modelContent = currentResponse.candidates?.[0]?.content;
      if (modelContent) {
        sdkHistory.push(modelContent);
        sdkHistory.push({ role: 'user', parts: toolResponses.map(tr => ({ functionResponse: tr })) });
      }
      
      currentResponse = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: sdkHistory,
        config: config
      });
    }

    const finalText = currentResponse.text || "I processed that, but I'm not sure how to put it into words.";
    onComplete(finalText, sources);

  } catch (error: any) {
    console.error("Gemini Error:", error);
    if (attempt < 3 && !profile.customApiKey && (error.message?.includes("429") || error.message?.includes("500"))) {
      onStatusChange("Retrying on new node...");
      return streamChatResponse(history, profile, onChunk, onComplete, onError, onStatusChange, attempt + 1);
    }
    onError(error);
  }
};
