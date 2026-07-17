"use strict";

const fs = require("fs");
const path = require("path");

/**
 * 현재 시각을 KST ISO 문자열로 반환한다.
 *
 * @returns {string} `+09:00` 오프셋이 포함된 ISO 시각
 */
function nowKstIso() {
  const now = new Date();
  const kstTime = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return `${kstTime.toISOString().slice(0, 19)}+09:00`;
}

/**
 * JSON 파일을 임시 파일을 거쳐 원자적으로 교체한다.
 *
 * @param {string} filePath 저장 경로
 * @param {unknown} data 저장할 값
 * @returns {void}
 */
function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

/**
 * 사용량 상태를 날짜별 JSONL 기록에 추가한다.
 *
 * @param {string} historyDir 기록 디렉터리
 * @param {object} status 상태 스냅샷
 * @returns {void}
 */
function appendHistory(historyDir, status) {
  fs.mkdirSync(historyDir, { recursive: true });
  const date = String(status.captured_at || nowKstIso()).slice(0, 10);
  const historyPath = path.join(historyDir, `${date}.jsonl`);
  fs.appendFileSync(historyPath, `${JSON.stringify(status)}\n`, "utf8");
}

/**
 * 상태 비교에 필요한 한도 값만 안정적인 문자열로 만든다.
 *
 * @param {object|null} status 상태 스냅샷
 * @returns {string} 비교용 서명
 */
function statusLimitSignature(status) {
  const limits = status && Array.isArray(status.limits) ? status.limits : [];
  return JSON.stringify(limits.map((limit) => ({
    type: limit && limit.type,
    remaining: limit && limit.remaining_percent,
    reset: limit && (limit.resets_at || limit.reset_text),
  })));
}

/**
 * 값이 바뀌었거나 장기간 기록이 없을 때만 성공 상태를 보관한다.
 *
 * @param {string} historyDir 기록 디렉터리
 * @param {object} status 새 상태
 * @param {object|null} previousStatus 이전 상태
 * @param {number} maximumSilenceMs 동일 값 재기록 간격
 * @returns {boolean} 실제 기록 여부
 */
function appendHistoryIfChanged(
  historyDir,
  status,
  previousStatus = null,
  maximumSilenceMs = 30 * 60 * 1000,
) {
  if (!status || status.parse_status !== "ok") {
    return false;
  }
  const previousTime = Date.parse(previousStatus && previousStatus.captured_at);
  const currentTime = Date.parse(status.captured_at);
  const changed = statusLimitSignature(status) !== statusLimitSignature(previousStatus);
  const silentTooLong = Number.isFinite(previousTime)
    && Number.isFinite(currentTime)
    && currentTime - previousTime >= maximumSilenceMs;
  if (previousStatus && !changed && !silentTooLong) {
    return false;
  }
  appendHistory(historyDir, status);
  return true;
}

module.exports = {
  nowKstIso,
  writeJsonAtomic,
  appendHistory,
  appendHistoryIfChanged,
  statusLimitSignature,
};
