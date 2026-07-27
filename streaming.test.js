import assert from "node:assert/strict";
import test from "node:test";
import { conversationRelayTwiml, streamAIResponse } from "./server.js";

test("TwiML enables fast turn detection and speech interruption", () => {
  const xml = conversationRelayTwiml("wss://relay.example.test/ws");
  assert.match(xml, /speechTimeout="900"/);
  assert.match(xml, /interruptible="speech"/);
  assert.match(xml, /reportInputDuringAgentSpeech="speech"/);
});

test("streams LLM tokens to Twilio and marks only the final token", async () => {
  const openai = {
    chat: {
      completions: {
        create: async () => ({
          async *[Symbol.asyncIterator]() {
            yield { choices: [{ delta: { content: "您好，" } }] };
            yield { choices: [{ delta: { content: "刘先生。" } }] };
          },
        }),
      },
    },
  };
  const tokens = [];
  const answer = await streamAIResponse(
    openai,
    [{ role: "user", content: "是的" }],
    async (token, last) => tokens.push({ token, last }),
  );
  assert.equal(answer, "您好，刘先生。");
  assert.deepEqual(tokens, [
    { token: "您好，", last: false },
    { token: "刘先生。", last: true },
  ]);
});

test("passes an AbortSignal to the streaming provider", async () => {
  const controller = new AbortController();
  let receivedSignal;
  const openai = {
    chat: {
      completions: {
        create: async (_body, options) => {
          receivedSignal = options.signal;
          return {
            async *[Symbol.asyncIterator]() {
              yield { choices: [{ delta: { content: "好" } }] };
            },
          };
        },
      },
    },
  };
  await streamAIResponse(openai, [], async () => {}, controller.signal);
  assert.equal(receivedSignal, controller.signal);
});
