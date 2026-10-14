import type { AssistantErrorCode } from "./types";

const wait = (sec?: number) => {
  if (!sec) return "a minute";
  if (sec < 90) return `${sec} second${sec === 1 ? "" : "s"}`;
  return `${Math.ceil(sec / 60)} minutes`;
};

/** What the reader sees. Generic on purpose: never the vendor's raw error text, never a key. */
export function friendlyMessage(code: AssistantErrorCode, retryAfterSec?: number): string {
  switch (code) {
    case "missing_key":
      return "The assistant isn't set up yet. Add a free Gemini API key as GEMINI_API_KEY in .env.local (see the README), then restart the server.";
    case "invalid_key":
      return "Google rejected the API key. Check GEMINI_API_KEY in .env.local (create a key in Google AI Studio), then restart the server.";
    case "rate_limited":
      return `The free Gemini quota is used up for now. Try again in about ${wait(retryAfterSec)}. Free-tier limits are set by Google per project.`;
    case "local_rate_limited":
      return `You're asking quickly. Please wait about ${wait(retryAfterSec)} before the next question (this protects the free quota).`;
    case "timeout":
      return "The AI took too long to answer. Please try again.";
    case "blocked":
      return "Google's safety filter blocked this request. Try rephrasing the question.";
    case "empty":
      return "The AI returned an empty answer. Please try again.";
    case "unavailable":
      return "The AI service is temporarily unavailable. Please try again shortly.";
    case "model_unavailable":
      return "The configured model isn't available for your key. Set GEMINI_MODEL to a model you can use (see Google AI Studio), then restart the server.";
    case "bad_request":
      return "The AI service rejected the request. Please try a shorter or simpler question.";
    case "not_found":
      return "Book not found.";
  }
}

/** Per-user question limits that protect the free quota. Counts come from the caller's stored questions. */
export function checkRateLimit(
  counts: { lastMinute: number; lastDay: number },
  limits: { maxPerMinute: number; maxPerDay: number },
): { retryAfterSec: number } | null {
  if (counts.lastMinute >= limits.maxPerMinute) return { retryAfterSec: 60 };
  if (counts.lastDay >= limits.maxPerDay) return { retryAfterSec: 3600 };
  return null;
}
