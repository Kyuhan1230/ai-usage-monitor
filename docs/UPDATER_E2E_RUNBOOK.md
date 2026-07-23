# Signed updater E2E 실행 절차

작성일: 2026-07-23
대상 릴리스: `1.2.3`

## 목적과 경계

정식 릴리스 전에는 ephemeral test key로 서명한 격리 채널에서 업데이트 발견·사용자 승인 설치·재시작을 검증한다. 정식 게시 뒤에는 production endpoint와 production key를 사용하는 stock `1.2.2 -> 1.2.3` canary를 별도로 실행한다.

격리 빌드는 다음 경계를 강제한다.

- 앱 이름: `Codex Claude Usage E2E`
- 실행 파일명: `codex-claude-usage-e2e.exe`
- identifier: `local.codex-claude-usage.e2e`
- 데이터: `%TEMP%\codex-claude-usage-updater-e2e`
- 태그: `updater-e2e-<run_id>-<run_attempt>`
- 서명키: workflow 실행 때 생성하고 runner와 함께 폐기하는 ephemeral key
- production `releases/latest`, production 서명 secret과 `~\.codex-usage-wrapper`를 사용하지 않음

workflow 성공은 자산 준비 완료만 뜻한다. 아래 수동 Windows gate까지 통과해야 signed updater E2E 완료다.

## 1. 격리 prerelease 준비

1. `release/v1-2-3` PR을 main에 merge하고 main CI 통과를 확인한다.
2. **Prepare signed updater E2E prerelease** workflow를 main에서 실행한다.
3. 입력값은 `action=prepare`, `confirm=PREPARE_SIGNED_E2E`로 제한한다.
4. workflow가 다음 네 자산을 가진 prerelease를 만들었는지 확인한다.
   - `Codex-Claude-Usage-E2E-Seed-1.2.3-e2e.0.exe`
   - `Codex-Claude-Usage-E2E-Target-<version>.exe`
   - 같은 target의 `.sig`
   - `latest-e2e.json`
5. production latest가 계속 `v1.2.2`인지 확인한다.

## 2. 발견과 표시 gate

1. E2E 앱은 별도 identifier와 설치 폴더를 사용한다. 트레이 아이콘을 혼동하지 않도록 가능하면 production 앱을 종료하고, 동시에 실행할 때는 제품명·프로세스 경로·버전을 함께 대조한다.
2. seed installer를 `/S`로 설치하고 아직 실행하지 않는다.
3. 격리 데이터 폴더에 임의 marker 파일을 만들고 SHA-256을 기록한다.
4. `update-state.json`을 다음 조건으로 준비한다.
   - `schemaVersion=2`
   - `lastSuccessfulCheckAppVersion=1.2.3-e2e.0`
   - `lastSuccessfulCheckAt=현재 시각 - 24시간 + 30초`
   - 자동 실패 0, 오류·available·lastNotified 없음
5. seed를 `--background`로 한 번 실행한다.
6. 시작 15초 뒤에도 due가 아니면 앱이 종료되지 않고 남은 시간까지 기다리는지 확인한다.
7. 재시작하지 않은 같은 프로세스에서 due가 되면 다음을 확인한다.
   - `availableVersion`과 `lastNotifiedVersion`이 target 버전
   - 자동 실패 0, 마지막 오류 없음
   - 업데이트 창은 자동으로 열리지 않음
   - Windows 알림이 한 번 표시됨
   - 트레이 항목이 `v<target> 업데이트 가능`으로 유지됨
8. 알림을 닫아도 트레이 항목이 유지되는지 확인한다.

## 3. 사용자 승인 설치 gate

1. 트레이의 업데이트 가능 항목을 눌러 업데이트 창을 연다.
2. 현재·target 버전과 릴리스 설명이 manifest와 일치하는지 확인한다.
3. **업데이트**를 누르기 전에는 target installer 다운로드가 시작되지 않는지 확인한다.
4. **업데이트**를 눌러 진행률, 서명 검증, passive NSIS 설치와 앱 재시작을 확인한다.
5. 재시작한 앱과 레지스트리 DisplayVersion이 target 버전인지 확인한다.
6. marker 파일의 경로·크기·SHA-256이 설치 전과 같은지 확인한다.
7. 새 앱의 자동 확인에서 현재 target과 같은 manifest를 최신으로 처리하고 available·오류를 정리하는지 확인한다.

## 4. 격리 자산 정리

1. E2E 앱을 종료하고 제거한다.
2. `%TEMP%\codex-claude-usage-updater-e2e`를 삭제한다.
3. workflow를 `action=cleanup`, `confirm=DELETE_SIGNED_E2E`, `release_tag=updater-e2e-...`로 실행한다.
4. prerelease와 test tag가 사라지고 production latest가 그대로인지 확인한다.

## 5. 정식 게시와 stock canary

1. production 앱과 Codex·Claude 작업을 멈춘 뒤 production `1.2.2`를 설치한다.
2. `~\.codex-usage-wrapper`를 별도 폴더에 백업하고 임의 marker를 만든다. 모든 기존 파일의 경로·크기·SHA-256을 기록하되, 자동 확인이 정상적으로 갱신하는 `update-state.json`만 엄격한 hash 비교에서 제외한다. canary는 활동 감지 수집이 시작되기 전 1분 안에 진행한다.
3. GitHub의 `production-release` environment에 required reviewer가 실제 설정됐는지 API로 확인한다.
4. main의 정확한 최신 release commit에 annotated tag `v1.2.3`을 만들고 push한다.
5. production environment approval 뒤 release workflow의 draft 원격 hash·manifest·signature 검증이 통과한 경우에만 게시한다.
6. published `latest.json`이 `1.2.3`과 정확한 asset URL·signature를 반환하는지 확인한다.
7. stock `1.2.2` 앱에서 업데이트를 발견하고 사용자가 승인한 뒤 production-signed `1.2.3`을 설치·재시작하는지 확인한다.
8. 설치 버전과 상태 schema v2를 확인한다. marker와 `update-state.json` 외 기존 파일은 경로·크기·SHA-256이 같아야 하며, 차이가 있으면 게시 성공으로 판정하지 말고 백업과 비교해 원인을 확인한다.

정식 게시 뒤 canary가 실패하면 이미 노출된 asset이나 manifest를 덮어쓰거나 삭제하지 않는다. 릴리스를 중단하고 원인을 수정한 `1.2.4`를 준비한다.

## 기록할 증거

- workflow run과 prerelease URL
- seed·target 버전과 네 자산 SHA-256
- due 전·후 process ID와 `update-state.json`의 비민감 필드
- 알림·트레이·업데이트 창 화면
- 설치 전·후 marker 및 production 데이터 hash 비교
- 정식 release run, tag, manifest와 installer signature 검증 결과

## 2026-07-23 실행 기록

- 준비 workflow: Actions run `29974352185` 성공
- seed: `1.2.3-e2e.0`, SHA-256 `2DD3E796257E181710A3968296D4849DDE8BF4C1FBA290AED3E407C395B1B0DF`
- target: `1.2.3-e2e.29974352185.1`, SHA-256 `25BDB207203832C29CA16CB59453184301474244C7B4ED60D1CF4A582B1DAEF1`
- signature SHA-256: `98126A2DAF9FBBCBB9BCB960314C052350D0BBD53914CC7C79C40F26D896ACD2`
- manifest SHA-256: `4588FC836331AC6045ED8674F406FBC86233DF0DE2C45AC750A69AD635EB503B`
- due 전·후 PID `21076` 유지, target 설치 뒤 PID `25980`으로 재시작
- marker SHA-256 `8D26584A2673A27C4E1444C5A2A78DD7B352BB762F1EA48779DCB73A684E33FA` 유지
- target ProductVersion·FileVersion, schema v2, 자동 실패 0, 마지막 오류 없음 확인
- 자동 발견 당시 데스크톱 잠금으로 toast 시각 확인은 미완료. Setup의 지속 업데이트 진입점과 사용자 승인 업데이트 창·설치·재시작은 확인
- cleanup workflow: Actions run `29978069880` 성공. prerelease·test tag·로컬 E2E 설치·데이터 파일 제거, production latest `v1.2.2` 유지
