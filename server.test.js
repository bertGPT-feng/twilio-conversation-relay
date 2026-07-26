import assert from "node:assert/strict";
import test from "node:test";
import { buildServer, conversationRelayTwiml } from "./server.js";

test("generates Chinese ConversationRelay TwiML without ElevenLabs", () => {
  const xml = conversationRelayTwiml("wss://relay.example.test/ws");
  assert.match(xml, /url="wss:\/\/relay\.example\.test\/ws"/);
  assert.match(xml, /language="zh-CN"/);
  assert.match(xml, /transcriptionProvider="Google"/);
  assert.match(xml, /speechModel="long"/);
  assert.match(xml, /ttsProvider="Amazon"/);
  assert.match(xml, /voice="Zhiyu-Neural"/);
  assert.doesNotMatch(xml, /ElevenLabs/i);
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
