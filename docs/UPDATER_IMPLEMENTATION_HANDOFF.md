# 자동 업데이트 알림·다운로드 구현 인수인계

> **1.2.3 후속 구현 — 2026-07-23**
> 이 문서의 one-shot 자동 확인과 자동 업데이트 창 설계는 [1.2.3 놓치지 않는 업데이트 발견](./refactor/1.2.3-resilient-update-discovery.md)에서 교체했다. 앱은 실행 중에도 다음 확인 시각을 계산하고, 자동 발견 시 창 대신 Windows 알림과 지속되는 트레이 문구를 사용한다. 로컬 fmt·Clippy·단위·UI·release manifest 테스트는 통과했지만, 서명된 installer를 이용한 실제 `1.2.2 -> 1.2.3` Windows E2E와 데이터 보존 검증은 아직 남아 있다.

## 구현 결과 — 2026-07-21

이 문서의 구현 단계는 `codex/forecast-copy-compact-rate` 브랜치에서 완료했다. 아래의 `현재 상태`와 권장 구현 순서는 작업 시작 전 스냅샷으로 남긴다.

- 제품 버전을 `1.2.0`으로 맞추고 Rust updater, 24시간 cooldown/snooze 상태, 프로세스 중복 guard와 설치 직전 버전 재확인을 구현했다.
- 앱 시작 15초 뒤 자동 확인, Setup·트레이 수동 확인, 전용 업데이트 창, 사용자 승인 설치, 진행률, 실패 재시도와 X 닫기 snooze를 구현했다.
- updater 공개키를 설정하고 암호화된 개인키·비밀번호를 GitHub Actions secret에 등록했다. 개인키는 저장소에 없다.
- Release workflow가 `.exe`, `.exe.sig`, `latest.json`을 만들고 이름·크기·URL·SemVer·signature exact match와 공개키 암호 검증을 통과한 뒤 게시하도록 변경했다.
- 일반 CI는 `createUpdaterArtifacts: false` overlay로 공식 키 없이 설치 파일만 검증한다.
- 로컬 signed NSIS build는 2,263,224 bytes로 20MB 예산 이내였고, 생성된 `.sig`와 `latest.json` 검증을 통과했다.

아직 남은 외부 검증은 `1.2.0`을 수동 설치한 뒤 테스트 Release의 `1.2.1`로 실제 Windows 업데이트하는 E2E와, SignPath 승인 뒤 Authenticode를 적용하고 최종 installer를 Tauri 키로 다시 서명하는 단계다.

작성일: 2026-07-21 (Asia/Seoul)
대상 저장소: `Kyuhan1230/ai-usage-monitor`
현재 작업 브랜치: `codex/forecast-copy-compact-rate`

## 한 줄 결론

새 버전을 감지하면 `새 버전이 있습니다` 창을 띄우고, 사용자가 `업데이트`를 눌렀을 때만 서명된 설치 파일을 내려받아 설치·재시작한다. `나중에`를 누르면 24시간 동안 같은 버전을 다시 묻지 않는다.

## 사용자 요구

- GitHub에 더 높은 버전이 배포되면 앱이 스스로 확인해야 한다.
- `업데이트하시겠습니까?`라는 명시적인 안내가 떠야 한다.
- 사용자가 동의하면 앱 안에서 다운로드와 설치가 이어져야 한다.
- 사용자의 동의 없이 자동으로 설치하면 안 된다.
- 실패해도 현재 앱과 사용 기록은 그대로 남아야 한다.

## 현재 상태

- 설치·실행 중인 로컬 수정본의 제품 버전은 `1.1.1`이다.
- 현재 소스에는 `tauri-plugin-updater`, 업데이트 endpoint, 업데이트 공개키, 업데이트 UI가 없다.
- [README](../README.md), [PRIVACY.md](PRIVACY.md), [CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md)는 자동 업데이트 확인을 하지 않는다고 명시한다.
- [tests/ui-tests.js](../tests/ui-tests.js)는 `tauri-plugin-updater`가 들어오면 실패하도록 작성돼 있다.
- 프런트엔드는 번들러 없이 `src/ui`의 정적 HTML·CSS·JavaScript를 Tauri가 직접 싣는다. `@tauri-apps/plugin-updater`를 JavaScript에서 바로 import하는 방식은 현재 구조와 맞지 않는다.
- 현재 브랜치에는 예측 계산·윤문·Compact 소진 속도 표시 변경이 커밋되지 않은 상태로 남아 있다. 새 세션은 먼저 `git status`와 diff를 확인하고 이 변경을 보존해야 한다.

### 최초 1회 수동 설치가 필요한 이유

`1.1.1`에는 updater 코드가 없으므로, GitHub에 updater가 포함된 새 버전을 올려도 기존 `1.1.1`이 이를 알아낼 방법이 없다.

따라서 updater가 처음 들어가는 부트스트랩 릴리스는 사용자가 한 번 직접 설치해야 한다. 권장 버전은 기능 추가를 나타내는 `1.2.0`이다. `1.2.0` 이후의 `1.2.1`, `1.3.0`부터는 앱 안에서 업데이트 알림과 설치가 가능하다.

## 확정할 UX

### 자동 확인 시점

- 앱 프로세스가 시작된 뒤 15초 후 한 번 확인한다.
- 마지막 성공 확인으로부터 24시간이 지나지 않았다면 자동 확인을 생략한다.
- 매분 확인하지 않는다.
- Setup 화면과 트레이 메뉴에 `업데이트 확인`을 추가해 수동 확인은 언제든 가능하게 한다.
- 자동 확인 실패는 팝업으로 반복 노출하지 않는다. 수동 확인 실패만 사용자에게 원인을 보여준다.

### 업데이트 발견 창

별도의 작은 Tauri 창 `update`를 만든다.

표시 내용:

- 제목: `새 버전이 있습니다`
- 본문: `현재 1.2.0 · 새 버전 1.2.1`
- 릴리스 요약. 비어 있으면 `안정성과 사용 경험을 개선한 새 버전입니다.`
- 버튼: `업데이트`, `나중에`
- 보조 동작: `릴리스 내용 보기` 또는 접을 수 있는 상세 내용

동작:

- `업데이트`: 다운로드 진행률을 같은 창에서 표시하고 버튼을 잠근다. 다운로드·서명 검증·설치가 끝나면 앱을 재시작한다.
- `나중에`: 창을 닫고 해당 버전을 24시간 snooze 한다.
- 닫기(X): `나중에`와 동일하게 처리한다.
- 같은 버전 창을 한 프로세스에서 두 번 띄우지 않는다.
- 새 버전이 더 올라오면 기존 snooze보다 새 버전을 우선한다.

권장 문구:

```text
새 버전이 있습니다

현재 1.2.0 · 새 버전 1.2.1
업데이트하면 앱을 잠시 다시 시작합니다. 사용 기록은 그대로 유지됩니다.

[나중에] [업데이트]
```

## 권장 아키텍처

### Rust가 업데이트를 소유한다

현재 프런트엔드에는 npm 번들 단계가 없으므로 updater의 Rust API를 사용한다.

- `src-tauri/src/update.rs`를 새로 만든다.
- `tauri-plugin-updater = "2"`를 `src-tauri/Cargo.toml`에 추가한다.
- `tauri_plugin_updater::Builder::new().build()`를 앱에 등록한다.
- `tauri_plugin_updater::UpdaterExt`로 확인·다운로드·설치를 수행한다.
- JavaScript에는 프로젝트 자체 Tauri command만 노출한다.
- generic HTTP 클라이언트나 `tauri-plugin-http`를 추가하지 않는다.

권장 command 계약:

```text
check_for_update(manual: bool) -> UpdateCheckResult
install_update(expected_version: String, progress_channel) -> UpdateInstallResult
postpone_update(version: String) -> UpdateState
get_update_state() -> UpdateState
```

`install_update`는 저장해 둔 다운로드 URL을 그대로 신뢰하지 말고, 설치 직전에 다시 `check()`한 뒤 `expected_version`과 일치하는지 확인한다.

### 상태 파일

`~/.codex-usage-wrapper/update-state.json`에 최소한 다음 값을 저장한다.

```json
{
  "lastSuccessfulCheckAt": "2026-07-21T21:00:00+09:00",
  "lastNotifiedVersion": "1.2.1",
  "snoozeUntil": "2026-07-22T21:00:00+09:00"
}
```

- 임시 파일 후 rename하는 현재 `storage::write_json`을 재사용한다.
- 다운로드 파일 경로나 서명키는 상태 파일에 저장하지 않는다.
- 상태 파일이 손상되면 기본 상태로 복구하고 앱 시작을 막지 않는다.
- 업데이트 확인이 동시에 두 번 실행되지 않도록 in-flight guard를 둔다.

### 창과 capability

- `src/ui/update.html`, `update.css`, `update.js`를 추가한다.
- `src-tauri/capabilities/default.json`의 windows 목록에 `update`를 추가한다.
- Rust command를 통해 updater를 호출한다면 updater plugin의 광범위한 JavaScript permission은 열지 않는다.
- 새 창은 업데이트가 발견됐을 때만 생성한다. 백그라운드 대기 중 WebView를 상시 유지하지 않는다.

## Tauri 설정

`src-tauri/tauri.conf.json`에 다음 성격의 설정이 필요하다. 실제 `pubkey`는 새 세션에서 생성한 공개키 내용으로 교체한다.

```json
{
  "bundle": {
    "createUpdaterArtifacts": true
  },
  "plugins": {
    "updater": {
      "pubkey": "TAURI UPDATE PUBLIC KEY CONTENT",
      "endpoints": [
        "https://github.com/Kyuhan1230/ai-usage-monitor/releases/latest/download/latest.json"
      ],
      "windows": {
        "installMode": "passive"
      }
    }
  }
}
```

필수 원칙:

- production endpoint는 HTTPS만 허용한다.
- `dangerousInsecureTransportProtocol`은 켜지 않는다.
- downgrade를 허용하지 않는다.
- 공개키는 설정에 포함해도 되지만 개인키는 절대 저장소에 넣지 않는다.
- Windows `passive` 모드로 설치 진행률은 보이되 추가 입력은 요구하지 않는 방향을 사용한다.

Tauri 2는 기본 자동 확인 대화상자를 제공하지 않는다. `check()`가 `null`이 아닌 경우에만 프로젝트가 직접 위 업데이트 창을 띄워야 한다.

## 업데이트 서명키

Tauri updater 서명과 Windows Authenticode 서명은 서로 다른 목적이다.

- Tauri updater 서명: 다운로드한 업데이트 파일이 공식 빌드인지 plugin이 검증한다. 이번 기능에 필수다.
- Authenticode/SignPath: Windows가 게시자를 표시하고 SmartScreen 신뢰를 형성한다. 기존 코드 서명 계획을 계속 따른다.

키 준비:

1. Tauri CLI로 updater signing key pair를 생성한다.
2. 공개키 내용은 `tauri.conf.json`의 `plugins.updater.pubkey`에 넣는다.
3. 개인키와 암호는 GitHub Actions secret에만 둔다.

권장 secret 이름:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

로컬 `.env`, 저장소 파일, Release asset에 개인키를 넣지 않는다.

### Authenticode 적용 시 서명 순서

SignPath가 NSIS 파일을 나중에 변경하면 그 전에 만든 Tauri `.sig`는 무효가 된다.

최종 순서는 반드시 다음과 같아야 한다.

1. NSIS installer 생성
2. Authenticode/SignPath 서명 적용
3. 최종 installer 바이트를 대상으로 Tauri updater `.sig` 생성 또는 재생성
4. 그 `.sig` 내용을 `latest.json`에 기록
5. installer, `.sig`, `latest.json`을 같은 Release에 게시

현재 SignPath가 아직 연결되지 않았다면 1번 산출물에 바로 Tauri 서명을 적용할 수 있다. 이후 SignPath를 도입할 때 위 순서를 다시 지켜야 한다.

## `latest.json` 계약

GitHub Release의 고정 asset 이름은 `latest.json`으로 한다.

예시:

```json
{
  "version": "1.2.1",
  "notes": "Compact 표시와 업데이트 안정성을 개선했습니다.",
  "pub_date": "2026-07-21T12:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "SIGNATURE FILE CONTENT, NOT A URL",
      "url": "https://github.com/Kyuhan1230/ai-usage-monitor/releases/download/v1.2.1/Codex-Claude-Usage-Setup-1.2.1.exe"
    }
  }
}
```

주의:

- `signature`에는 `.sig` 파일의 URL이 아니라 파일 내용이 들어가야 한다.
- `version`은 유효한 SemVer여야 한다.
- URL 버전, tag, `package.json`, `tauri.conf.json`, `Cargo.toml` 버전이 모두 같아야 한다.
- static manifest를 만드는 `scripts/create-updater-manifest.js`와 검증 스크립트를 추가하는 것을 권장한다.

## Release workflow 변경

현재 `.github/workflows/release.yml`은 installer 한 개만 업로드하고 asset이 정확히 한 개인지 검사한다. 다음과 같이 바꿔야 한다.

1. build step에 updater signing secrets를 환경 변수로 전달한다.
2. `createUpdaterArtifacts: true`로 NSIS `.sig`를 생성한다.
3. installer 이름을 `Codex-Claude-Usage-Setup-<version>.exe`로 정규화한다.
4. 최종 installer의 Tauri `.sig`를 준비한다.
5. `latest.json`을 생성한다.
6. draft Release에 다음 세 asset을 올린다.
   - `Codex-Claude-Usage-Setup-<version>.exe`
   - `Codex-Claude-Usage-Setup-<version>.exe.sig`
   - `latest.json`
7. 기존 `asset.Count -eq 1` 검사를 세 asset의 정확한 이름·크기·signature 내용 검증으로 교체한다.
8. draft 공개 전 로컬에서 manifest URL, SemVer, signature와 installer hash를 검증한다.
9. Release 공개 후 `releases/latest/download/latest.json`이 HTTP 200과 예상 버전을 반환하는지 smoke check한다.

CI의 일반 PR 빌드는 개인키가 없으므로 updater artifact 생성 방식을 분리해야 할 수 있다. 권장 방식은 release 전용 Tauri config overlay를 두거나, CI에서 테스트용 일회성 키를 사용하되 절대 공식 공개키와 섞지 않는 것이다. 최종 선택은 키 없이 `createUpdaterArtifacts`가 현재 Tauri 버전에서 어떻게 실패하는지 먼저 실험한 뒤 결정한다.

## 수정해야 할 기존 문서와 테스트

### 문서

- `README.md`: `명시적 업데이트`를 자동 확인 + 사용자 승인 설치로 변경
- `docs/PRIVACY.md`: 성공한 manifest 확인 뒤 24시간 동안 자동 재확인하지 않고, 실패 시 다음 시작에서 재시도할 수 있다고 명시
- `docs/CODE_SIGNING_POLICY.md`: updater metadata와 Tauri 서명 정책 추가
- `docs/SIGNING_SETUP.md`: updater signing secrets와 SignPath 이후 재서명 순서 추가
- `CHANGELOG.md`: updater 알림·다운로드·설치·재시작 추가

과거 설계 문서인 `docs/refactor/1.0.0-tauri-rust.md`는 당시 결정 기록이므로 내용을 지우지 말고, 상단이나 후속 문단에 `1.2.0에서 정책 변경` 링크만 추가한다.

### 테스트

현재 이 단언은 updater를 금지한다.

```js
assert(!cargoToml.match(/reqwest|ureq|hyper|tauri-plugin-(?:http|updater)/i));
```

다음 의도로 교체한다.

- generic HTTP 라이브러리와 `tauri-plugin-http`는 계속 금지
- 공식 `tauri-plugin-updater`는 정확히 한 번 허용·요구
- endpoint가 `https://github.com/Kyuhan1230/ai-usage-monitor/releases/latest/download/latest.json`인지 확인
- insecure transport, downgrade 허용 설정이 없는지 확인
- `update` 창 capability와 UI 파일을 확인
- 사용자 승인 전 `download_and_install`이 실행되지 않는 구조를 확인

Rust 단위 테스트:

- 마지막 확인 후 24시간 이내에는 자동 확인 생략
- 수동 확인은 cooldown을 무시
- 같은 버전 snooze 중에는 자동 창 생략
- 더 높은 새 버전은 기존 snooze와 무관하게 알림
- 동시에 두 번 확인하지 않음
- 잘못된 상태 파일에서 기본값 복구
- 설치 직전 재확인한 버전이 다르면 중단

UI 테스트:

- 현재/새 버전과 릴리스 요약 표시
- `업데이트`, `나중에` 버튼 존재
- 다운로드 중 진행률과 버튼 비활성화
- 실패 시 `다시 시도`와 기존 앱 유지 안내
- 사용자 동의 전 다운로드 command를 호출하지 않음

Release 검증:

- installer와 `.sig`가 존재
- `latest.json`의 signature가 `.sig` 내용과 정확히 일치
- manifest URL과 asset 이름이 Release asset과 일치
- 공개키로 최종 installer 검증 성공
- installer가 20MB 예산을 넘지 않음. updater plugin 추가 후 크기 변화를 기록

## 수동 E2E 시나리오

테스트용 `1.2.0`을 설치하고 테스트 Release에 `1.2.1`을 준비한다.

1. `1.2.0` 실행 후 15초 안팎에 업데이트 창이 한 번 뜬다.
2. 창에 현재 버전, 새 버전, 릴리스 요약이 맞게 표시된다.
3. `나중에`를 누르고 앱을 다시 실행해도 24시간 동안 자동 창이 뜨지 않는다.
4. 트레이 또는 Setup의 `업데이트 확인`은 snooze 중에도 결과를 보여준다.
5. `업데이트`를 누르면 진행률이 증가한다.
6. 서명 검증이 성공한 파일만 설치된다.
7. 앱이 재시작되고 제품 버전이 `1.2.1`이 된다.
8. `~/.codex-usage-wrapper`의 history, analytics, monitoring, onboarding 파일이 유지된다.
9. 손상된 signature를 제공하면 설치가 중단되고 현재 앱이 계속 실행된다.
10. 네트워크가 끊기면 자동 확인은 조용히 실패하고, 수동 확인은 재시도 가능한 오류를 보여준다.

## 완료 기준

- [x] updater 포함 첫 버전이 `1.2.0` 이상으로 버전 정합성을 갖는다.
- [x] 성공한 자동 확인 뒤 24시간 동안 재확인하지 않고, 실패 시 다음 시작에서 재시도할 수 있다.
- [x] 새 버전이 있으면 전용 창이 뜬다.
- [x] 사용자 동의 전에는 다운로드하지 않는다.
- [x] 다운로드 진행률과 실패 복구가 보인다.
- [x] Tauri 서명 검증 실패 시 설치하지 않는다.
- [ ] 설치 성공 후 재시작하고 새 버전을 표시한다.
- [x] updater가 사용자 기록 파일을 변경하지 않는다.
- [ ] installer, `.sig`, `latest.json`이 같은 GitHub Release에 있다.
- [x] README, Privacy, Signing 문서가 새 네트워크 동작과 일치한다.
- [x] Rust, Clippy, UI, release manifest 테스트가 통과한다.
- [ ] 실제 `1.2.0 -> 1.2.1` Windows 업데이트를 한 번 통과한다.

## 권장 구현 순서

1. 현재 uncommitted 예측/UI 변경을 검토·테스트하고 먼저 커밋한다.
2. updater signing key를 만들고 GitHub secrets를 준비한다.
3. Rust updater 모듈과 상태/cooldown 테스트를 작성한다.
4. update 창과 Setup·tray의 수동 확인 진입점을 만든다.
5. Tauri config, capability, 버전을 갱신한다.
6. release workflow에 `.sig`와 `latest.json` 생성을 추가한다.
7. README·Privacy·Signing·CHANGELOG를 갱신한다.
8. 테스트 Release로 `1.2.0 -> 1.2.1` E2E를 실행한다.
9. 첫 updater 포함 버전을 수동 설치용으로 공개한다.

## 로컬 빌드 환경 메모

- Visual Studio Build Tools 2022와 Windows 11 SDK는 2026-07-21에 설치했다.
- `VsDevCmd.bat`: `%ProgramFiles(x86)%\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat`
- C: 공간이 부족하므로 Rust target은 D:를 사용한다.

```powershell
$env:CARGO_TARGET_DIR='<별도 드라이브의 Cargo target>\ai-usage-monitor'
npm test
npm run dist
```

- 기본 로컬 설치 위치: `%LOCALAPPDATA%\Codex Claude Usage\codex-claude-usage.exe`
- 기본 데이터 위치: `%USERPROFILE%\.codex-usage-wrapper`
- 첫 updater 구현 세션은 기존 실행 프로세스를 종료하기 전에 installer 생성과 전체 테스트를 완료해야 한다.

## 공식 참고자료

- Tauri 2 Updater: <https://v2.tauri.app/plugin/updater/>
- Tauri 2 migration note: <https://v2.tauri.app/start/migrate/from-tauri-1/#migrate-to-updater-plugin>
- Updater JavaScript API reference: <https://v2.tauri.app/reference/javascript/updater/>

Tauri 공식 문서 기준으로 Windows updater artifact에는 installer와 `.sig`가 필요하며, static JSON의 `signature`에는 `.sig` URL이 아니라 파일 내용이 들어가야 한다.
