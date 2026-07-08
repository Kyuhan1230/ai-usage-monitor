#!/usr/bin/env node
"use strict";

// 실제 TUI들이 흔히 하는 것처럼, 한 데이터 청크(chunk) 안에 여러 글자가 한꺼번에
// 도착하면 그 안의 \r/\n을 "제출(Enter)"이 아니라 그냥 붙여넣기 텍스트로 취급한다.
// \r/\n이 완전히 혼자 도착했을 때만 그 줄을 실행한다.
// 이렇게 해야 term.write("/status\r")처럼 한 번에 밀어넣는 회귀와,
// typeIntoTerminal처럼 한 글자씩 지연을 두고 보내는 정상 동작을 구분해서 테스트할 수 있다.

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();
process.stdin.setEncoding("utf8");

let lineBuffer = "";

function runLine(rawLine) {
  const input = rawLine.trim();
  if (input === "/status") {
    process.stdout.write("\r\nCodex Usage Dashboard Status\r\n");
    process.stdout.write("5-hour remaining: 71%, resets in 2h 18m\r\n");
    process.stdout.write("Weekly remaining: 84%, resets in 3d 4h\r\n");
    process.stdout.write("> ");
    return;
  }

  if (input === "exit") {
    process.exit(0);
  }

  process.stdout.write(`echo: ${input}\r\n`);
  process.stdout.write("> ");
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

process.stdout.write("Mock Codex ready\r\n");
process.stdout.write("> ");
