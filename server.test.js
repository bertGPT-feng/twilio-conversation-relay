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
  assert.match(xml, /法院通知中心的AI演示客服/);
});

test("system prompt preserves the configured role and safety boundaries", () => {
  assert.match(SYSTEM_PROMPT, /法院通知中心/);
  assert.match(SYSTEM_PROMPT, /张伟/);
  assert.match(SYSTEM_PROMPT, /（2026）京01民初123号/);
  assert.match(SYSTEM_PROMPT, /AI 演示客服/);
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

test("ConversationRelay prompt reaches the LLM and returns a text token", async () => {
  const openai = {
    chat: {
      completions: {
        create: async ({ messages }) => {
          assert.match(messages[0].content, /法院通知中心/);
          assert.equal(messages.at(-1).content, "你好");
          return { choices: [{ message: { content: "您好，请问需要什么帮助？" } }] };
        },
      },
    },
  };
  const app = buildServer({ openai });
  await app.ready();
  const socket = await app.injectWS("/ws");
  const response = new Promise((resolve) => socket.once("message", resolve));
  socket.send(JSON.stringify({ type: "setup", callSid: "CA_TEST" }));
  socket.send(JSON.stringify({ type: "prompt", voicePrompt: "你好", last: true }));
  const message = JSON.parse((await response).toString());
  assert.deepEqual(message, {
    type: "text",
    token: "您好，请问需要什么帮助？",
    last: true,
    interruptible: true,
  });
  const closed = new Promise((resolve) => socket.once("close", resolve));
  socket.close();
  await closed;
  await app.close();
});
