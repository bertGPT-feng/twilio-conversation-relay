import assert from "node:assert/strict";
import test from "node:test";
import { buildServer, conversationRelayTwiml, SYSTEM_PROMPT } from "./server.js";

test("generates Chinese ConversationRelay TwiML without ElevenLabs", () => {
  const xml = conversationRelayTwiml("wss://relay.example.test/ws");
  assert.match(xml, /url="wss:\/\/relay\.example\.test\/ws"/);
  assert.match(xml, /language="zh-CN"/);
  assert.match(xml, /transcriptionProvider="Deepgram"/);
  assert.match(xml, /speechModel="nova-2-general"/);
  assert.match(xml, /ttsProvider="Amazon"/);
  assert.match(xml, /voice="Zhiyu-Neural"/);
  assert.doesNotMatch(xml, /ElevenLabs/i);
});

test("system prompt preserves the configured role and safety boundaries", () => {
  assert.match(SYSTEM_PROMPT, /法院通知中心/);
  assert.match(SYSTEM_PROMPT, /刘宗宝/);
  assert.match(SYSTEM_PROMPT, /（2026）京01民初123号/);
  assert.match(SYSTEM_PROMPT, /不要求转账或付款/);
});

test("health identifies the active ConversationRelay mode", async () => {
  const app = buildServer({ openai: null });
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().mode, "conversation-relay");
  await app.close();
});

test("voice route returns ConversationRelay TwiML", async () => {
  const app = buildServer({ openai: null });
  const response = await app.inject({ method: "POST", url: "/voice" });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"], /^text\/xml/);
  assert.match(response.body, /<ConversationRelay/);
  await app.close();
});

test("ConversationRelay confirms identity before sending a complex prompt to the LLM", async () => {
  const openai = {
    chat: {
      completions: {
        create: async ({ messages }) => {
          assert.match(messages[0].content, /法院通知中心/);
          assert.equal(messages.at(-1).content, "为什么会给我发这份文书");
          return { choices: [{ message: { content: "这是演示送达流程说明。" } }] };
        },
      },
    },
  };
  const app = buildServer({ openai });
  await app.ready();
  const socket = await app.injectWS("/ws");
  socket.send(JSON.stringify({ type: "setup", callSid: "CA_TEST" }));
  const identityResponse = new Promise((resolve) => socket.once("message", resolve));
  socket.send(JSON.stringify({ type: "prompt", voicePrompt: "是的", last: true }));
  const identityMessage = JSON.parse((await identityResponse).toString());
  assert.match(identityMessage.token, /民事判决书/);
  assert.equal(identityMessage.last, true);

  const llmResponse = new Promise((resolve) => socket.once("message", resolve));
  socket.send(
    JSON.stringify({
      type: "prompt",
      voicePrompt: "为什么会给我发这份文书",
      last: true,
    }),
  );
  const llmMessage = JSON.parse((await llmResponse).toString());
  assert.deepEqual(llmMessage, {
    type: "text",
    token: "这是演示送达流程说明。",
    last: true,
    interruptible: true,
    preemptible: true,
  });
  const closed = new Promise((resolve) => socket.once("close", resolve));
  socket.close();
  await closed;
  await app.close();
});
