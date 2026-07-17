#!/usr/bin/env node
"use strict";

const fs = require("fs");

let buffer = "";
const logPath = process.env.MOCK_CODEX_APP_SERVER_LOG;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function record(message) {
  if (logPath) {
    fs.appendFileSync(logPath, `${JSON.stringify(message)}\n`, "utf8");
  }
}

function handle(message) {
  record(message);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "mock", codexHome: "mock" } });
    return;
  }
  if (message.method === "account/rateLimits/read") {
    send({
      id: message.id,
      result: {
        rateLimits: {
          primary: { usedPercent: 27, windowDurationMins: 300, resetsAt: 1784334600 },
          secondary: { usedPercent: 61, windowDurationMins: 10080, resetsAt: 1784766600 },
        },
        rateLimitResetCredits: { availableCount: 1, credits: [] },
        spendControlReached: false,
      },
    });
    return;
  }
  if (message.method === "account/usage/read") {
    send({ id: message.id, result: { summary: { totalTokens: 123456 }, dailyBuckets: [] } });
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    handle(JSON.parse(line));
  }
});
