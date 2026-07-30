!macro NSIS_HOOK_POSTINSTALL
  Push $0
  Push $1
  Push $2
  Push $3

  ; 무인 설치는 질문이나 네트워크 요청 없이 끝내야 합니다.
  IfSilent cli_offer_done

  ; OpenAI 독립 실행 설치본과 npm 전역 설치본 중 하나라도 있으면 다시 묻지 않습니다.
  ReadEnvStr $1 CODEX_INSTALL_DIR
  StrCmp $1 "" cli_check_default
  IfFileExists "$1\codex.exe" cli_offer_done
  IfFileExists "$1\codex.cmd" cli_offer_done

  cli_check_default:
  IfFileExists "$LOCALAPPDATA\Programs\OpenAI\Codex\bin\codex.exe" cli_offer_done
  IfFileExists "$APPDATA\npm\codex.cmd" cli_offer_done
  IfFileExists "$PROFILE\.local\bin\codex.exe" cli_offer_done
  ; 임의 PATH 위치는 여기서 성공으로 판정하지 않고, 중복 설치 질문만 피한다.
  ; 단, WindowsApps 실행 별칭과 Codex desktop 번들은 독립 CLI가 아니므로 질문을
  ; 건너뛰는 근거로 쓰지 않는다. 실제 실행·version·capability 검증은 첫 실행
  ; Setup의 공통 resolver가 수행한다.
  StrCpy $0 "exe"
  SearchPath $1 "codex.exe"
  StrCmp $1 "" cli_check_path_cmd cli_classify_search_path

  cli_check_path_cmd:
  StrCpy $0 "cmd"
  SearchPath $1 "codex.cmd"
  StrCmp $1 "" cli_offer_prompt cli_classify_search_path

  cli_classify_search_path:
  ; SearchPath의 정확한 App Execution Alias는 독립 CLI 설치 증거가 아니다.
  StrCmp $1 "$LOCALAPPDATA\Microsoft\WindowsApps\codex.exe" cli_search_path_is_desktop

  StrLen $2 "$LOCALAPPDATA\Microsoft\WindowsApps\"
  StrCpy $3 $1 $2
  StrCmp $3 "$LOCALAPPDATA\Microsoft\WindowsApps\" cli_search_path_is_desktop

  StrLen $2 "$PROGRAMFILES\WindowsApps\OpenAI.Codex_"
  StrCpy $3 $1 $2
  StrCmp $3 "$PROGRAMFILES\WindowsApps\OpenAI.Codex_" cli_search_path_is_desktop

  StrLen $2 "$PROGRAMFILES64\WindowsApps\OpenAI.Codex_"
  StrCpy $3 $1 $2
  StrCmp $3 "$PROGRAMFILES64\WindowsApps\OpenAI.Codex_" cli_search_path_is_desktop cli_offer_done

  cli_search_path_is_desktop:
  StrCmp $0 "exe" cli_check_path_cmd cli_offer_prompt

  cli_offer_prompt:
  MessageBox MB_ICONQUESTION|MB_YESNO|MB_DEFBUTTON2 \
    "Codex CLI가 설치되어 있지 않습니다.$\r$\n$\r$\nOpenAI 공식 설치 프로그램으로 지금 설치할까요?$\r$\n인터넷에서 OpenAI 설치 스크립트와 CLI를 내려받습니다.$\r$\n$\r$\n아니요를 눌러도 Codex Claude Usage 설치는 계속됩니다." \
    IDNO cli_offer_done

  DetailPrint "OpenAI 공식 설치 프로그램으로 Codex CLI를 설치하는 중..."
  ; 사용자가 이미 승인했으므로 숨겨진 NSIS child에서는 추가 prompt 없이 설치한다.
  nsExec::ExecToLog 'powershell.exe -NoLogo -NoProfile -ExecutionPolicy ByPass -Command "$$env:CODEX_NON_INTERACTIVE=''1''; irm https://chatgpt.com/codex/install.ps1 | iex"'
  Pop $0
  StrCmp $0 "0" codex_installer_exited codex_cli_failed

  codex_installer_exited:
    ; exit 0은 installer process 결과일 뿐 CLI 성공 판정이 아니다.
    ; 첫 실행 Setup이 fresh PATH와 후보 전체를 읽고 실제 CLI를 검증한다.
    DetailPrint "Codex installer가 종료되었습니다. 첫 실행 Setup에서 CLI를 검증합니다."
    MessageBox MB_ICONINFORMATION|MB_OK \
      "Codex 설치 프로그램이 종료되었습니다.$\r$\n첫 실행 Setup에서 실제 CLI 설치와 로그인 상태를 검증합니다."
    Goto cli_offer_done

  codex_cli_failed:
    DetailPrint "Codex CLI 설치가 완료되지 않았습니다. PowerShell 종료 코드: $0"
    MessageBox MB_ICONEXCLAMATION|MB_OK \
      "Codex CLI 설치를 완료하지 못했습니다. (종료 코드: $0)$\r$\n$\r$\n모니터 설치는 정상적으로 계속됩니다.$\r$\n첫 실행 Setup에서 다시 설치할 수 있습니다."

  cli_offer_done:
    Pop $3
    Pop $2
    Pop $1
    Pop $0
!macroend
