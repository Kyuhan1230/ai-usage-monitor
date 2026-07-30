"use strict";

const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

const EXPECTED = Object.freeze({
  node: "22.12.0",
  npm: "10.9.0",
  rustc: "1.97.1",
  cargo: "1.97.1",
  windowsTarget: "x86_64-pc-windows-msvc",
});

function commandName(name) {
  if (process.platform !== "win32") return name;
  if (name === "npm") return "npm.cmd";
  if (name === "rustup") return "rustup.exe";
  return name;
}

function run(name, args) {
  let executable = commandName(name);
  let commandArgs = args;
  if (process.platform === "win32" && name === "npm") {
    const npmCli = path.join(
      path.dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    );
    if (!existsSync(npmCli)) {
      throw new Error(`현재 Node.js 배포판의 npm CLI를 찾을 수 없습니다: ${npmCli}`);
    }
    executable = process.execPath;
    commandArgs = [npmCli, ...args];
  }
  const result = spawnSync(executable, commandArgs, {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`${name}을(를) 실행할 수 없습니다: ${result.error.code || result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${name} ${args.join(" ")} 명령이 종료 코드 ${result.status}로 실패했습니다.`);
  }
  return `${result.stdout || ""}\n${result.stderr || ""}`.trim();
}

function exactVersion(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${label} 버전 불일치: ${actual || "없음"} (필요: ${expected})`);
  }
  process.stdout.write(`OK ${label} ${actual}\n`);
}

function firstSemver(text) {
  const match = String(text).match(/\b(\d+\.\d+\.\d+)\b/);
  return match ? match[1] : "";
}

function main() {
  exactVersion("Node.js", process.version.replace(/^v/, ""), EXPECTED.node);
  exactVersion("npm", firstSemver(run("npm", ["--version"])), EXPECTED.npm);

  if (process.argv.includes("--node-only")) {
    return;
  }

  exactVersion("rustc", firstSemver(run("rustc", ["--version"])), EXPECTED.rustc);
  exactVersion("cargo", firstSemver(run("cargo", ["--version"])), EXPECTED.cargo);

  if (process.platform === "win32") {
    const targets = run("rustup", ["target", "list", "--installed"])
      .split(/\r?\n/)
      .map((value) => value.trim());
    if (!targets.includes(EXPECTED.windowsTarget)) {
      throw new Error(
        `Rust MSVC target 누락: ${EXPECTED.windowsTarget}. ` +
        `rustup target add ${EXPECTED.windowsTarget} --toolchain ${EXPECTED.rustc} 명령으로 추가하세요.`,
      );
    }
    process.stdout.write(`OK Rust target ${EXPECTED.windowsTarget}\n`);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`개발 툴체인 확인 실패: ${error.message}\n`);
  process.stderr.write(
    "README의 Development prerequisites를 확인하세요. 이 검사는 전역 도구를 설치하거나 변경하지 않습니다.\n",
  );
  process.exit(1);
}
