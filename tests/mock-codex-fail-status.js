#!/usr/bin/env node
"use strict";

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();
process.stdin.setEncoding("utf8");

let lineBuffer = "";

function runLine(rawLine) {
  const input = rawLine.trim();
  if (input === "/status") {
    return;
  }
  if (input === "exit") {
    process.exit(0);
  }
}

process.stdin.on("data", (chunk) => {
  const isIsolatedEnter = chunk.length === 1 && (chunk === "\r" || chunk === "\n");
  if (isIsolatedEnter) {
    const submitted = lineBuffer;
    lineBuffer = "";
    runLine(submitted);
    return;
  }

  lineBuffer += chunk;
});

process.stdout.write("Mock Codex without status output\r\n");
