; StorePOS installer additions (included by electron-builder, UTF-8).
;
; The installer starts with a language choice: Georgian, English, Russian or Spanish.
; The chosen language ($LANGUAGE, a Windows language id) is written next to StorePOS.exe;
; StorePOS shows its sign-in and first-start screens in that language until someone picks
; another language in the program (see src/main/deviceLanguage.ts).

!define MUI_LANGDLL_WINDOWTITLE "StorePOS"
!define MUI_LANGDLL_INFO "ენა / Language / Язык / Idioma"

; NSIS's Georgian language file has no texts for the "install for whom" page. Georgian is the
; first installer language, so these defines become its texts (NSIS's LangFile takes an
; existing define instead of falling back to English); the other languages use their own.
!define MULTIUSER_TEXT_INSTALLMODE_TITLE "მომხმარებლების არჩევა"
!define MULTIUSER_TEXT_INSTALLMODE_SUBTITLE "აირჩიეთ, ვისთვის დაინსტალირდეს $(^NameDA)."
!define MULTIUSER_INNERTEXT_INSTALLMODE_TOP "აირჩიეთ, დააინსტალიროთ $(^NameDA) მხოლოდ თქვენთვის თუ ამ კომპიუტერის ყველა მომხმარებლისთვის. $(^ClickNext)"
!define MULTIUSER_INNERTEXT_INSTALLMODE_ALLUSERS "ყველასთვის, ვინც ამ კომპიუტერს იყენებს"
!define MULTIUSER_INNERTEXT_INSTALLMODE_CURRENTUSER "მხოლოდ ჩემთვის"

!macro customInstall
  ClearErrors
  FileOpen $0 "$INSTDIR\install-language.txt" w
  ${IfNot} ${Errors}
    FileWrite $0 "$LANGUAGE"
    FileClose $0
  ${EndIf}
!macroend

!macro customUnInstall
  Delete "$INSTDIR\install-language.txt"
!macroend
