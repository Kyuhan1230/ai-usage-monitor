# Windows 코드 서명 설정

## Tauri updater 서명

Tauri updater 서명은 Windows 게시자를 표시하는 Authenticode와 별개다. updater 기능은 이 서명을 필수로 검증한다.

1. `npx tauri signer generate -w <안전한 저장소의 key 경로>`로 저장소 전용 키를 만든다.
2. 생성된 `.pub` 파일 내용을 `src-tauri/tauri.conf.json`의 `plugins.updater.pubkey`에 넣는다. 이 값은 공개해도 된다.
3. 개인키 내용과 암호를 GitHub Actions secret에 등록한다.
   - `TAURI_SIGNING_PRIVATE_KEY`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
4. 개인키와 암호는 `.env`, 저장소 파일, workflow 로그 또는 Release asset에 넣지 않는다.
5. Release workflow가 만든 installer를 공개키로 검증하고, `.exe`, `.exe.sig`, `latest.json` 세 asset이 모두 맞을 때만 공개한다.

현재 개인키는 암호화되어 GitHub secret에 등록되어 있으며, 로컬 백업의 암호는 Windows 사용자 범위 DPAPI로 보호한다. 키 교체는 기존 설치본이 새 키를 신뢰하지 않으므로 첫 updater 릴리스 이후 임의로 하면 안 된다.

## 무료 경로: SignPath Foundation 재신청

이 프로젝트는 MIT 오픈소스이며 SignPath Foundation의 무료 오픈소스 코드 서명 프로그램에 신청했지만 2026-07-23 외부 신뢰와 공개 인지도 신호 부족으로 승인되지 않았다. 현재 릴리스는 Authenticode 미서명 상태로 명확히 표시하고, 실제 사용자·외부 언급·기여와 지속적인 릴리스 기록을 확보한 뒤 재신청한다.

재신청 및 승인 후 확인 사항:

1. GitHub와 SignPath 계정에 다중 인증을 켠다.
2. 이 저장소의 Release에서 현재 형태의 Windows 설치 파일을 최소 한 번 공개한다.
3. README의 기능·설치·제거 설명, `Code signing policy`, 개인정보 처리방침을 공개 상태로 유지한다.
4. SignPath 신청서에는 저장소, 릴리스 URL, MIT 라이선스, 담당자 `Kyuhan1230`과 첫 신청 뒤 확보한 공개 신뢰 근거를 적는다.
5. 승인 후 SignPath GitHub App을 이 저장소에 연결하고 프로젝트·artifact configuration·signing policy를 만든다.
6. GitHub Actions secret `SIGNPATH_API_TOKEN`을 등록한다. 조직 ID와 각 slug는 승인된 SignPath 프로젝트 값으로 설정한다.
7. unsigned artifact를 `actions/upload-artifact`로 먼저 올린 뒤, 승인 시점에 SignPath가 안내하는 현재 GitHub Action과 artifact configuration으로 서명 요청을 연결한다.
8. 애플리케이션 EXE와 최종 NSIS 설치 파일의 Authenticode 서명을 모두 검증한 뒤, 최종 installer 바이트에 Tauri updater 서명을 다시 적용하고 `latest.json`을 생성한 경우에만 GitHub Release를 공개한다.

SignPath 설정값은 계정 승인 뒤 발급되므로 저장소에 가짜 ID나 토큰을 넣지 않는다. 현재 Release workflow는 Tauri updater 서명을 구현했지만 Authenticode는 아직 적용하지 않는다. 재신청이 승인되면 아래 식별자를 실제 값으로 등록하고, Authenticode와 그 이후 재생성한 Tauri updater 서명 검증이 실패하면 Release도 실패하도록 workflow를 변경한다.

승인 후 GitHub 저장소의 Actions secret에 다음 값을 등록한다.

- `SIGNPATH_API_TOKEN`

Actions variable에는 다음 값을 등록한다.

- `SIGNPATH_ORGANIZATION_ID`
- `SIGNPATH_PROJECT_SLUG`
- `SIGNPATH_SIGNING_POLICY_SLUG`
- `SIGNPATH_APP_ARTIFACT_CONFIGURATION_SLUG`
- `SIGNPATH_INSTALLER_ARTIFACT_CONFIGURATION_SLUG`

앱 실행 파일용 artifact configuration의 root는 GitHub artifact ZIP이므로 다음 구조를 사용한다.

```xml
<artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
  <zip-file>
    <pe-file path="Codex Claude Usage.exe">
      <authenticode-sign/>
    </pe-file>
  </zip-file>
</artifact-configuration>
```

설치 파일용 artifact configuration은 버전이 달라져도 정확히 한 파일만 선택하도록 다음 구조를 사용한다.

```xml
<artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
  <zip-file>
    <pe-file path="Codex-Claude-Usage-Setup-*.exe" min-matches="1" max-matches="1">
      <authenticode-sign/>
    </pe-file>
  </zip-file>
</artifact-configuration>
```

첫 서명 릴리스를 수동 확인한 뒤 Actions variable `REQUIRE_CODE_SIGNING=true`를 추가한다. 이후에는 SignPath 설정이나 토큰이 빠지면 Release가 중단되어야 한다. workflow는 앱 실행 파일과 최종 NSIS 설치 파일을 각각 서명하고 `Get-AuthenticodeSignature`로 두 결과를 검증해야 한다.

## 대안: OV/EV 인증서

상용 Authenticode 인증서를 사용하는 경우 GitHub Actions secret에 인증서와 암호를 저장하고, Tauri의 Windows 서명 명령 또는 `signtool` 단계에서 사용한다.

- `WIN_CSC_LINK`: `.pfx`의 안전한 URL, 경로 또는 base64 값
- `WIN_CSC_KEY_PASSWORD`: `.pfx` 암호

저장소나 workflow 파일에 인증서와 암호를 직접 기록하지 않는다. 서명 적용 뒤에는 애플리케이션 EXE와 NSIS 설치 파일 양쪽의 Authenticode 상태를 Release 필수 게이트로 두며, 어느 한쪽이라도 미서명이면 게시하지 않는다.
