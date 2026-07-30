# Codex CLI 원격 Windows T3 시험 절차

> 현재 상태: NOT RUN — 운영 결정 `TBD`, 사람 T3와 최종 release commit 증거 대기

이 문서는 별도 물리 PC가 없을 때 일회성 원격 Windows 11 VM에서 Codex CLI의 설치, 로그인, 첫 사용량 확인을 사람이 검증하는 절차다. 이 시험은 [설치·탐지·로그인 강화 명세](spec.md)의 **T3**이며, GitHub-hosted runner에서 수행하는 T2와 대체 관계가 아니다.

Draft 생성부터 exact-byte 공개 승인까지의 자동 gate와 구조화 Issue marker는 [Codex onboarding Release gate](RELEASE_GATE.md)를 따른다.

VM subscription, exact image, 비용 한도와 담당자 결정은 [T3 원격 Windows 운영 결정](remote-test-decision.md)을 따른다. 해당 문서에 `TBD`가 하나라도 남아 있으면 T3를 시작하지 않는다.

## 1. T2와 T3의 경계

| 등급 | 실행 위치 | 실제로 증명하는 것 | 증명하지 못하는 것 |
| --- | --- | --- | --- |
| T2 | GitHub-hosted `windows-latest` | 공식 `install.ps1`, 기본·사용자 지정 설치 위치, 실제 CLI version/capability, 비어 있는 `CODEX_HOME`의 비인증 결과, 저장소 resolver harness | Windows 11 데스크톱 UI, SmartScreen, RDP, 브라우저 OAuth/MFA, 실제 계정 사용량, 재부팅 후 사용자 경험 |
| T3 | 일회성 Windows 11 데스크톱 VM | 실제 RC 설치 파일, 사용자 동의 UI, 사람이 완료한 OAuth/MFA, 첫 사용량, 앱 재실행·Windows 재부팅, legacy npm 충돌, 앱 제거 뒤 Codex 보존 | 다른 Windows version·architecture·기업 정책 전체 |

GitHub Actions secret에 ChatGPT 계정, OAuth token, session cookie 또는 MFA 복구 코드를 넣지 않는다. Playwright나 다른 브라우저 자동화로 OAuth를 흉내 내지 않는다. T3의 계정 인증은 RDP 세션에서 권한 있는 테스터가 직접 수행한다.

## 2. 시작 전 Release 후보 조건

다음 조건이 하나라도 충족되지 않으면 VM을 만들지 말고 Release 담당자에게 돌려보낸다.

- [ ] 시험할 installer가 아직 공개 Release로 승격되지 않은 정확한 Release candidate다.
- [ ] 앱 version, Git commit, versioned installer 이름과 SHA-256을 받았다.
- [ ] 같은 commit의 `Codex CLI official installer smoke` T2 기본 위치·custom 위치 job이 모두 성공했다.
- [ ] T2 evidence artifact의 official script SHA-256, 실제 Codex version, capability 결과와 repository harness 결과를 확인했다.
- [ ] T2가 raw installer/auth 출력이나 전체 사용자 경로를 artifact로 올리지 않았음을 확인했다.
- [ ] blocker로 분류된 Setup Issue가 없다.
- [ ] [compatibility matrix](evidence/codex-compatibility-matrix.md)에 지정된 `@openai/codex@0.144.5`, Node.js `22.12.0` x64, npm `10.9.0`을 legacy 충돌 시험에 사용한다.
- [ ] [원격 운영 결정](remote-test-decision.md)의 subscription, image, 비용, auto-shutdown, tester/reviewer와 QA account owner가 모두 확정됐다.
- [ ] fresh standard user에서 Codex desktop/CLI, Node.js, npm과 Rust가 모두 없는 image를 사용할 수 있다.

T3 보고서의 installer SHA-256은 최종 공개할 versioned installer의 SHA-256과 같아야 한다. T3 뒤 Release workflow가 installer를 다시 빌드했다면 기존 T3 결과는 무효다.

2026-07-31의 [T2 implementation snapshot](evidence/REMOTE_T2_2026-07-31.md)은 commit `62c208c6821aa3db5c38da03c4ee2b8229d56492`에서 PASS했다. 후속 code 또는 documentation commit은 release commit과 SHA가 다르므로 그 snapshot을 same-commit gate로 재사용하지 않고 T2를 다시 실행한다.

## 3. VM과 계정 보안

### 3.0 별도 PC가 없을 때의 실행 수단

권장 경로는 **GitHub-hosted Windows T2 + 사용자가 접속하는 일회성 Azure Windows 11 T3**의 조합이다.

1. T2는 이 저장소의 `Codex CLI official installer smoke` workflow를 실행한다. 공개 저장소의 GitHub-hosted runner는 job마다 새 VM을 제공하지만 대화형 RDP·브라우저 OAuth 시험장으로 사용하지 않는다. [GitHub-hosted runners 공식 설명](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
2. T3는 Azure Marketplace의 `MicrosoftWindowsDesktop` publisher, `Windows-11` offer에서 제공되는 Windows 11 x64 image를 사용한다. Windows 11 cloud 사용 권한과 image 제공 여부는 구독·지역·라이선스에 따라 다르므로 생성 화면에서 비용과 자격을 사용자가 직접 확인한다. Microsoft는 Student/Free Trial 계정의 개발·시험용 Windows 11 image 사용 가능성도 별도로 설명한다. [Azure의 Windows 11 배포 계약](https://learn.microsoft.com/en-us/azure/virtual-machines/windows/windows-desktop-multitenant-hosting-deployment)
3. 새 VM 생성, 유료 요금 동의, QA ChatGPT 계정 로그인은 자동화하지 않는다. 비용과 계정 권한의 주체인 사용자가 직접 수행해야 한다.
4. Azure Bastion을 사용할 수 있으면 public RDP를 만들지 않는다. 직접 RDP가 필요하면 source를 현재 공인 IP 하나로 제한하고 짧은 시간만 연다. `0.0.0.0/0`에 3389를 열지 않는다. [Azure VM 안전 접속 선택지](https://learn.microsoft.com/en-us/azure/networking/design-guide/developer-admin-access), [Azure Windows VM RDP 절차](https://learn.microsoft.com/en-us/azure/virtual-machines/windows/connect-rdp)
5. 이미 Windows 365, Azure Virtual Desktop 또는 Microsoft Dev Box 권한이 있다면 fresh Windows 11 desktop, standard user, reboot, 앱 제거, 시험 뒤 credential 폐기가 모두 가능한 경우에만 대체할 수 있다. 기존 업무 desktop이나 동기화된 browser profile은 사용하지 않는다.

GitHub Actions만으로 T3를 대신하거나, Windows Server image·브라우저 전용 테스트 서비스에서 installer UI와 재부팅을 생략하지 않는다. 사용자는 RDP/Windows App 세션에서 Setup이 시작한 visible terminal을 확인하고 Codex가 연 브라우저에 계정·MFA를 직접 입력한다. 앱이나 CI가 대신 로그인하지 않는다.

### 3.1 VM

- Windows Server가 아니라 공개 지원 대상과 같은 **Windows 11 x64 desktop image**를 사용한다.
- VM, OS disk, data disk, public IP와 보안 그룹은 이번 시험 전용으로 새로 만든다.
- RDP 3389는 테스터의 현재 공인 IP에만 임시 허용한다. 가능하면 공급자의 JIT 또는 bastion을 사용한다.
- 관리자 계정은 VM 준비에만 사용한다. 앱과 Codex 시험은 별도의 standard user로 수행한다.
- 회사 자료, 개인 브라우저 profile, 동기화 drive, 기존 SSH/Git key를 VM에 넣지 않는다.
- RDP clipboard와 drive redirection은 기본적으로 끈다. installer 전송 때만 필요한 한 방향 전송 수단을 사용하고 즉시 다시 끈다.
- 인증 전의 깨끗한 snapshot은 허용한다. OAuth가 끝난 뒤에는 snapshot이나 reusable image를 만들지 않는다.
- 시험 종료 뒤 VM만 정지하지 말고 OS disk, snapshot, public IP와 임시 보안 규칙까지 폐기한다.

### 3.2 시험 계정

- 테스터가 사용 권한을 가진 별도 QA용 ChatGPT 계정을 사용한다.
- 계정은 Codex CLI와 `account/rateLimits/read`를 실제 사용할 수 있어야 한다.
- 계정 비밀번호, 이메일, 조직명, workspace 이름과 MFA 정보는 보고서에 쓰지 않는다.
- 계정 credential은 tester가 Codex가 연 브라우저에 직접 입력한다. 다른 사람에게 전달하거나 GitHub secret으로 저장하지 않는다.
- VM 브라우저에는 이번 시험 전용 profile만 만들고 password sync를 켜지 않는다.

## 4. 증거에 허용되는 정보

허용:

- 앱 version과 Git commit
- Windows edition/version/architecture
- installer 파일명, byte size, SHA-256와 Authenticode 상태
- T2 workflow run URL
- Codex version
- `default_standalone_path`, `legacy_npm` 같은 source 종류
- provenance confidence와 privacy-safe candidate tag
- 예상·실제 CLI/install/login/auth 상태
- safe error code
- 단계별 PASS/FAIL과 후속 Issue URL

금지:

- Windows 사용자명과 전체 home/temporary 경로
- ChatGPT 이메일, 조직명, workspace 이름과 계정 ID
- password, token, cookie, MFA code와 QR code
- `auth.json` 또는 그 내용
- `codex login status`의 원문 stdout/stderr
- prompt, response, session JSONL과 실제 quota 숫자
- browser profile, 주소 표시줄의 민감한 query, RDP credential
- redaction 전 screenshot 또는 installer/login 원문 log

`where.exe codex` 결과가 필요하면 VM 안에서만 다음처럼 home 부분을 치환해 확인한다. 보고서에는 전체 문자열 대신 `alias`, `default_standalone_path`, `legacy_npm` 같은 분류만 기록한다.

```powershell
where.exe codex 2>$null | ForEach-Object {
  [regex]::Replace(
    $_,
    [regex]::Escape($env:USERPROFILE),
    '<USERPROFILE>',
    [Text.RegularExpressions.RegexOptions]::IgnoreCase
  )
}
```

## 5. 시험 준비

1. VM을 만들고 Windows Update를 적용한 뒤 재부팅한다.
2. 관리자와 standard tester 계정을 분리한다.
3. standard tester로 RDP 접속한다.
4. Windows edition과 architecture를 확인한다.

   ```powershell
   Get-ComputerInfo |
     Select-Object WindowsProductName, WindowsVersion, OsBuildNumber, OsArchitecture
   ```

5. 아래 명령으로 Codex CLI, Node.js, npm과 Rust가 **모두 absent**인지 확인한다. 하나라도 `Present=True`면 이 image로 pristine 고객 baseline을 주장하지 않는다. 설치 제거로 상태를 추측해 만들지 말고 새 image 또는 새 standard user를 준비한다.

   ```powershell
   foreach ($name in 'codex', 'node', 'npm', 'rustc') {
     [pscustomobject]@{
       Tool = $name
       Present = $null -ne (Get-Command $name -ErrorAction SilentlyContinue)
     }
   }
   ```

6. Codex desktop도 설치되지 않은 새 image인지 확인한다. 발견한 전체 경로는 보고서에 옮기지 않는다.
7. RC installer를 신뢰하는 제어 PC에서 받은 뒤 VM으로 한 번만 전송한다. 시험 VM에 개인 GitHub credential을 저장하지 않는다.
8. VM에서 SHA-256과 Authenticode 상태를 확인한다.

   ```powershell
   Get-FileHash '.\Codex-Claude-Usage-Setup-<version>.exe' -Algorithm SHA256
   Get-AuthenticodeSignature '.\Codex-Claude-Usage-Setup-<version>.exe' |
     Select-Object Status, StatusMessage
   ```

9. SHA-256이 Release candidate 기록과 다르면 즉시 `FAIL`이다. 실행하지 않는다.
10. 이 시점의 깨끗한 pre-auth snapshot이 필요하면 하나만 만든다.

## 6. 필수 시나리오

각 단계에서 [Windows install smoke report template](../community/INSTALL_SMOKE_REPORT_TEMPLATE.md)의 상태 전이 표를 채운다. “창이 열림”과 “작업 성공”, login process와 auth 사실을 별도로 기록한다.

### 6.1 CLI 없음과 설치 거절

1. RC installer를 standard tester로 실행한다.
2. SmartScreen이 나타나면 게시자 상태와 사용자가 거친 버튼만 기록한다. 계정이나 desktop 전체 screenshot은 남기지 않는다.
3. NSIS의 Codex 설치 질문 기본 선택이 **아니요**인지 확인하고 거절한다.
4. Codex 설치 거절과 무관하게 모니터 설치가 완료되는지 확인한다.
5. 첫 일반 실행에서 Setup이 열리는지 확인한다.
6. Codex 상태가 `missing`, install operation이 `idle`, auth가 `unavailable`인지 확인한다.
7. **상태 다시 확인**을 눌러도 상태가 거짓 `ready` 또는 `authenticated`로 바뀌지 않는지 확인한다.

예상과 다르면 이후 OAuth를 진행하지 말고 `FAIL`로 기록한다.

### 6.2 앱에서 공식 standalone 설치

1. Setup의 **Codex 설치**를 누른다.
2. 확인 화면에 공식 URL, 네트워크 다운로드, PATH 변경 가능성, 취소 가능성이 표시되는지 확인한다.
3. 설치를 승인한다.
4. visible PowerShell의 시작과 install operation `running`을 각각 확인한다.
5. terminal이 열렸다는 이유만으로 앱이 `설치 완료`를 표시하지 않는지 확인한다.
6. 설치 프로세스가 끝난 뒤 앱이 자동으로 후보를 다시 찾는지 확인한다.
7. 앱이 발견 위치 source를 `default_standalone_path`로, install provenance를 별도 `tracked_official_install`로, 실제 Codex version을 호환 상태로 표시하는지 확인한다.
8. 설치 뒤 앱을 재시작하지 않아도 CLI 상태가 `ready`로 바뀌는지 확인한다.
9. 비어 있던 계정에서 auth는 `unauthenticated`여야 한다.

앱의 **설치 취소**로 터미널을 종료했다면 `cancelled`가 표시돼야 한다. installer가 nonzero로 끝나고 유효한 CLI가 없으면 `failed`와 safe error code가 표시돼야 한다. nonzero 뒤에도 재탐지한 유효 CLI가 있으면 CLI는 `ready`, install operation은 `succeeded`로 두되 `install_exit_nonzero` warning을 반드시 보존한다. 어느 경우에도 프로세스 시작이나 nonzero 결과만으로 설치 성공을 추정하지 않는다.

### 6.3 앱에서 로그인 시작과 사람 OAuth

1. Setup의 **Codex 로그인**을 누른다.
2. 앱이 선택한 standalone의 전체 경로로 `codex login` terminal을 시작하는지 확인한다. 브라우저는 앱이 직접 조작하는 것이 아니라 Codex CLI가 연다.
3. login operation `running`과 auth `unauthenticated`를 독립적으로 확인한다.
4. Codex가 연 브라우저에서 tester가 직접 계정 로그인과 MFA를 완료한다.
5. password, MFA code, OAuth callback URL 또는 browser 화면을 촬영하지 않는다.
6. CLI가 끝난 뒤 앱이 auth를 자동으로 다시 확인하는지 확인한다.
7. auth가 `authenticated`로 바뀌어야 한다. 수동 **상태 다시 확인**은 복구 수단으로도 작동해야 하지만, 자동 재확인이 빠졌다면 목표 구현은 `FAIL`이다.
8. 터미널에서 원문을 숨긴 채 종료 코드만 교차 확인할 수 있다.

   ```powershell
   codex login status *> $null
   "login-status-exit=$LASTEXITCODE"
   ```

9. 종료 코드가 `0`인데 앱이 authenticated가 아니거나, nonzero인데 앱이 authenticated면 `FAIL`이다.

`authenticated`는 credential 존재 증거다. 이 단계만으로 subscription 사용량 연결 성공을 기록하지 않는다. 선택 후보가 `--device-auth`를 지원하더라도 개인 보안 설정 또는 workspace 관리 정책에서 device code를 허용하지 않을 수 있다. Device-code fallback을 사용할 때는 Codex CLI가 terminal에 표시한 flow를 tester가 직접 완료하며 code나 URL을 보고서에 남기지 않는다.

### 6.4 첫 실제 사용량

1. Setup에서 연결된 Codex의 사용량 확인을 실행한다.
2. 실제 `account/rateLimits/read`가 성공하고 usage readiness가 `ready`로 바뀌며 잔여량과 reset 정보가 나타나는지만 확인한다.
3. 실제 quota 숫자, plan, 계정명 또는 workspace는 보고서와 screenshot에 남기지 않는다.
4. 이전 성공 cache가 아니라 현재 요청 결과인지 UI 시각과 상태로 확인한다.
5. 실패하면 auth 성공과 usage 성공을 분리해 기록하고 safe error code를 남긴다.

`login status`가 exit `0`이어도 이 단계가 실패하면 “credential 확인, usage unsupported/error”로 기록한다. API-key 또는 method를 raw 출력에서 추정하거나 account identity를 보고서에 넣지 않는다.

### 6.5 앱 재실행과 Windows 재부팅

1. tray 메뉴로 앱을 완전히 종료한다.
2. 앱을 다시 실행하고 동일한 standalone source/version과 authenticated 상태가 복구되는지 확인한다.
3. Windows를 재부팅한다.
4. standard tester로 다시 로그인한다.
5. Setup에서 CLI 재탐지와 auth 재확인을 수행한다.
6. 첫 사용량 확인을 한 번 더 실행한다.
7. 이 단계가 끝날 때까지 `node`, `npm`, `rustc`가 계속 absent인지 다시 확인한다. 하나라도 중간에 설치됐다면 pristine baseline은 `FAIL`이다.

재부팅 전 결과만으로 T3를 PASS 처리하지 않는다.

### 6.6 legacy npm 충돌

이 단계는 standalone 설치, 사람 OAuth, 첫 사용량, 앱 재실행과 Windows 재부팅의 pristine baseline이 모두 PASS한 뒤에만 시작한다. 그 전에는 Node.js, npm 또는 Rust를 설치하지 않는다.

Compatibility matrix가 지정한 `@openai/codex@0.144.5`, Node.js `22.12.0` x64, npm `10.9.0`으로만 진행한다. 다른 version을 썼으면 Release gate를 충족하지 못한 것으로 기록한다. Rust는 이 단계에도 설치하지 않는다.

1. 승인된 Node.js/npm 조합을 설치한다.
2. `node --version`과 `npm --version`이 각각 정확히 `v22.12.0`, `10.9.0`인지 확인한다.
3. `npm view '@openai/codex@0.144.5' dist.integrity`가 compatibility matrix의 승인된 integrity와 일치하는지 확인한다. 다른 값이면 설치하지 않고 `FAIL`이다.
4. `npm install --global '@openai/codex@0.144.5'`를 실행한다.

   ```powershell
   $legacyVersion = '0.144.5'
   $expectedIntegrity = 'sha512-jjB+K+OMv572mKhS+2QuLxWXDJNdpwbPenf+V+8bdq7wg4Scqt3cn6WEekD8wPqDVZqck0HSX17K9rD9kbDJQA=='
   $actualIntegrity = npm view "@openai/codex@$legacyVersion" dist.integrity
   if ($actualIntegrity -ne $expectedIntegrity) {
     throw 'Approved legacy package integrity mismatch.'
   }
   npm install --global "@openai/codex@$legacyVersion"
   ```

5. Setup에서 상태를 다시 확인한다.
6. 공식 standalone과 npm legacy 후보가 모두 발견되는지 확인한다.
7. 결정적 우선순위에 따라 standalone이 선택되고 conflict warning이 표시되는지 확인한다.
8. 로그인 probe와 사용량 수집이 같은 선택 후보를 사용하는지 확인한다.
9. 보고서에는 두 전체 경로 대신 source, version과 privacy-safe candidate tag만 기록한다.

### 6.7 기존 1.2.7 설치 고객 업그레이드

이 시나리오는 fresh-install T3와 분리된 새 standard user 또는 pre-auth snapshot에서 수행한다. 공개 `v1.2.7` installer와 draft의 exact candidate를 사용하며, production `latest.json`을 draft로 바꾸거나 공개 asset을 덮어쓰지 않는다.

1. 공개 `v1.2.7` tag commit, installer byte size와 SHA-256이 release gate에 고정된 값과 일치하는지 확인한다.
2. `v1.2.7`을 standard user의 기본 위치에 설치하고 앱 설정·history marker를 만든다.
3. 같은 QA 계정으로 Codex CLI 인증을 완료하고, 전체 credential 내용 대신 VM 안에서만 credential 파일의 SHA-256을 기록한다.
4. 앱 설치 위치, uninstall entry, Codex CLI file hash, `CODEX_HOME` credential hash와 process/HKCU/HKLM PATH를 기록한다. 보고서에는 full path와 credential hash 자체를 옮기지 않고 PASS/FAIL만 기록한다.
5. draft candidate를 `Start-Process .\Codex-Claude-Usage-Setup-<version>.exe -ArgumentList '/P','/UPDATE' -Wait`로 실행한다.
6. 업데이트 진행 중 Codex 설치 질문, OpenAI 설치 script terminal 또는 별도 로그인 terminal이 나타나면 즉시 `FAIL`이다.
7. 설치 위치와 uninstall entry가 유지되고 DisplayVersion, app binary와 재시작 앱 version만 candidate로 바뀌는지 확인한다.
8. 기존 설정·history marker, CLI 선택, Codex CLI bytes, credential hash와 세 PATH가 모두 유지되는지 확인한다.
9. Setup을 열어 CLI와 인증을 다시 확인한다. 이미 인증된 고객에게 재로그인을 요구하거나 onboarding을 강제로 다시 시작하면 `FAIL`이다.
10. 이 시나리오의 candidate installer SHA-256이 fresh-install T3 및 `release-evidence.json`에 묶인 installer와 같아야 한다.

이 시험은 unpublished draft를 production updater endpoint로 발견하는 시험이 아니다. stock `1.2.7`의 실제 production updater 발견·서명 다운로드는 공개 후 disposable Windows canary에서 별도로 확인하며, 실패 시 published asset을 바꾸지 않고 후속 patch release로 복구한다.

### 6.8 앱 제거와 공급자 보존

1. tray에서 앱을 종료한다.
2. Windows **설치된 앱**에서 Codex Claude Usage만 제거한다.
3. Codex CLI가 계속 실행 가능한지 확인한다.
4. 원문을 숨긴 `codex login status`가 계속 성공하는지 확인한다.
5. Codex CLI, npm package, credential과 PATH가 모니터 제거 대상이 아니었는지 기록한다.
6. `~\.codex-usage-wrapper`의 보존/수동 삭제 동작이 개인정보 문서와 일치하는지 확인한다.

## 7. 선택 확장 시나리오

Microsoft Store를 사용할 수 있는 image라면 pre-auth snapshot에서 별도 분기로 다음을 확인한다.

1. Codex desktop만 설치한다.
2. 실제 App Execution Alias가 생겼는지 VM 안에서 확인한다.
3. 모니터가 이를 standalone `ready`로 오인하지 않고 `desktop_bundle_only`로 표시하는지 확인한다.
4. 공식 standalone 설치 뒤 alias를 건너뛰고 standalone을 선택하는지 확인한다.

Store를 사용할 수 없어 실행하지 못했다면 T1 fake alias 검증과 혼동하지 말고 `NOT RUN — Store unavailable`로 기록한다.

## 8. 보고·검토·폐기

1. template의 전체 구조를 사용해 상세 보고서를 작성한다.
2. 모든 placeholder를 채우고 미실행 항목은 이유와 Release 영향까지 적는다.
3. [Release gate](RELEASE_GATE.md)의 T3 Issue를 만들고 상세 보고서 전문을 Issue 본문에 직접 붙인 뒤 `T3_DETAIL_REPORT: EMBEDDED`와 exact-byte marker를 모두 확정한다. 저장소 문서는 보조 링크일 뿐 Issue 본문의 authoritative report를 대신하지 않는다. Issue를 `completed`로 닫고 `release:t3-approved` label을 붙인 다음 독립 reviewer에게 넘긴다.
4. screenshot은 필요한 영역만 잘라 계정, 사용자명, 경로, quota 숫자를 영구적으로 가린다. 단순 blur보다 완전한 단색 마스킹을 사용한다.
5. redaction 전 screenshot과 원문 log는 VM 밖으로 내보내지 않는다.
6. `PASS WITH ISSUES`는 blocker가 없고 owner·기한·Issue가 있는 경우에만 허용한다.
7. tester와 독립 reviewer가 installer SHA-256, T2 run, 상태 전이와 redaction을 확인한다. reviewer는 GitHub API가 반환한 현재 Issue 본문 UTF-8 SHA-256을 계산해 approval comment의 `T3_REPORT_BODY_SHA256` marker에 넣는다.
8. review comment 뒤 Issue 본문이 바뀌면 기존 승인은 무효다. 수정된 최종 본문을 다시 검토해 새 본문 hash가 있는 새 approval comment를 남긴다.
9. 보고서가 참조한 SHA-256이 최종 draft asset과 일치하는지 Release 직전에 다시 확인한다.
10. 필요하면 QA 계정에서 `codex logout`을 수행한다. 출력은 저장하지 않는다.
11. VM, 모든 disk/snapshot, public IP, 임시 방화벽 규칙과 browser profile을 폐기한다.
12. 클라우드 콘솔에서 자원이 삭제됐음을 확인한 뒤 T3를 종료한다.

## 9. 즉시 No-Go 조건

- GitHub-hosted runner 결과를 실제 OAuth 시험이라고 표현함
- ChatGPT credential 또는 MFA 정보를 CI secret에 넣음
- fake CLI만으로 공식 installer 또는 실제 Codex를 통과했다고 표현함
- installer terminal 또는 login terminal을 연 것만 성공으로 기록함
- T3가 시험한 installer와 공개하려는 installer SHA-256이 다름
- 재부팅, 첫 실제 사용량, conflict 또는 uninstall 보존 중 하나라도 미실행
- 계정 정보, token, raw auth 출력 또는 전체 home path가 evidence에 포함됨
- T3 뒤 installer를 다시 빌드하고도 기존 보고서를 재사용함
- 독립 review 뒤 Issue 본문을 수정하고 새 `T3_REPORT_BODY_SHA256` 승인 없이 공개하려 함
- pristine baseline 시작 시 `codex`, `node`, `npm`, `rustc` 중 하나라도 존재했는데도 고객 무의존 시험으로 PASS 처리함
- standalone OAuth·첫 사용량·restart/reboot가 끝나기 전에 legacy 시험용 Node/npm을 설치함
- credential 인증만 확인하고 현재 `account/rateLimits/read` 실패를 사용량 연결 성공으로 표시함
