import { readAssistantConfig, type AssistantConfig } from "@/lib/assistant/config";
import { ProviderError, type ChatProvider, type GenerateRequest, type GenerateResult } from "@/lib/assistant/provider";
import type { SourcePassage } from "@/lib/assistant/types";

export const BOOK = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

export const config = (over: Partial<AssistantConfig> = {}): AssistantConfig => ({
  ...readAssistantConfig({ GEMINI_API_KEY: "test-key-not-real" }),
  ...over,
});

let counter = 0;
export function passage(over: Partial<SourcePassage> & { chapter_number: number }): SourcePassage {
  counter++;
  return {
    chunk_id: `chunk-${counter}`,
    chapter_id: `chapter-${over.chapter_number}`,
    chapter_title: `Chapter ${over.chapter_number} title`,
    volume_number: 1,
    volume_title: "Volume one",
    arc: null,
    content: `Original sample passage number ${counter} about the lantern keeper.`,
    rank: 1 - counter / 1000,
    ...over,
  };
}

export type FakeProvider = ChatProvider & { calls: GenerateRequest[] };

/** A scripted stand-in for Gemini. It records every request, so tests can inspect exactly what would be sent. */
export function fakeProvider(reply: string | ((req: GenerateRequest) => string) | ProviderError | Error): FakeProvider {
  const calls: GenerateRequest[] = [];
  return {
    name: "fake",
    model: "fake-model",
    calls,
    async generate(req: GenerateRequest): Promise<GenerateResult> {
      calls.push(req);
      if (reply instanceof Error) throw reply;
      return { text: typeof reply === "function" ? reply(req) : reply };
    },
  };
}

/** Everything the provider was sent, as one string (system + every turn). */
export const everythingSent = (p: FakeProvider) => p.calls.flatMap((c) => [c.system, ...c.turns.map((t) => t.text)]).join("\n");

/** Everything sent EXCEPT the reader's own typed question line: i.e. the system rules, history and book sources. */
export const sentExceptQuestion = (p: FakeProvider) => everythingSent(p).replace(/^QUESTION:.*$/gm, "");

/** A fake reply that cites whichever numbered source contains `needle` (sources are numbered in reading order). */
export const citeSourceContaining =
  (needle: string, template: (n: number) => string) =>
  (req: GenerateRequest): string => {
    const user = req.turns.at(-1)!.text;
    // Sources are numbered in reading order, so find the block whose text contains `needle` and cite ITS number.
    const m = user.match(new RegExp('<source id="(\\d+)"[^>]*>[^<]*' + needle));
    return template(m ? Number(m[1]) : 1);
  };
