import assert from "node:assert/strict";
import test from "node:test";
import {
  conversationRelayTwiml,
  identityResponseFor,
  streamAIResponse,
  WELCOME_GREETING,
} from "./server.js";

test("TwiML enables fast turn detection and speech interruption", () => {
  const xml = conversationRelayTwiml("wss://relay.example.test/ws");
  assert.match(xml, /speechTimeout="900"/);
  assert.match(xml, /interruptible="speech"/);
  assert.match(xml, /reportInputDuringAgentSpeech="speech"/);
});

test("welcome greeting and affirmative identity reply advance without the LLM", () => {
  assert.match(WELCOME_GREETING, /刘宗宝先生/);
  const response = identityResponseFor("是的");
  assert.equal(response.confirmed, true);
  assert.doesNotMatch(response.text, /请问您是刘宗宝/);
  assert.match(response.text, /民事判决书/);
  assert.match(response.text, /送达流程吗？$/);
});

test("unclear identity reply asks once more without disclosing case details", () => {
  const response = identityResponseFor("喂，你说什么");
  assert.equal(response.confirmed, null);
  assert.match(response.text, /刘宗宝先生本人吗？$/);
  assert.doesNotMatch(response.text, /案号|判决书/);
});

test("streams complete LLM sentences and marks only the final sentence", async () => {
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
  assert.deepEqual(tokens, [{ token: "您好，刘先生。", last: true }]);
});

test("replaces a long incomplete tail with a complete spoken fallback", async () => {
  const openai = {
    chat: {
      completions: {
        create: async () => ({
          async *[Symbol.asyncIterator]() {
            yield { choices: [{ delta: { content: "刘先生，具体内容请查看文书。" } }] };
            yield { choices: [{ delta: { content: "如有问题请联系您的" } }] };
            yield { choices: [{ delta: {}, finish_reason: "length" }] };
          },
        }),
      },
    },
  };
  const tokens = [];
  const answer = await streamAIResponse(openai, [], async (token, last) =>
    tokens.push({ token, last }),
  );
  assert.equal(
    answer,
    "刘先生，具体内容请查看文书。后续信息需要通过官方渠道确认。请问您需要我重新说明吗？",
  );
  assert.deepEqual(tokens, [
    { token: "刘先生，具体内容请查看文书。", last: false },
    {
      token: "后续信息需要通过官方渠道确认。请问您需要我重新说明吗？",
      last: true,
    },
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
