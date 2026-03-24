
/**
 * Augment the existing NodeJS.ProcessEnv to include environment variables.
 * GROQ_API_KEY: One or more Groq API keys (comma/space separated for pool).
 * Get free keys at https://console.groq.com
 */
declare namespace NodeJS {
  interface ProcessEnv {
    GROQ_API_KEY: string;
  }
}
