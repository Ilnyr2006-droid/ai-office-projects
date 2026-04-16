# AI Office: сборка desktop .exe для Windows

## Вариант 1: локально на Windows
1. Открой `cmd` или `PowerShell` в папке проекта.
2. Запусти:
   ```bat
   build_exe.bat
   ```
3. Готовый файл будет здесь:
   ```
   dist\\AIOffice.exe
   ```

Запуск:
```bat
AIOffice.exe --host 127.0.0.1 --port 8787
```
После запуска открывается отдельное окно приложения (не браузерная вкладка).

## Вариант 2: через GitHub Actions
1. Запушь изменения в репозиторий.
2. В GitHub открой `Actions` -> `Build Windows EXE`.
3. Нажми `Run workflow`.
4. Скачай артефакт `AIOffice-windows-exe`.

## Примечание
Собирать Windows `.exe` на macOS напрямую обычно неудобно и нестабильно, поэтому рекомендуются способы выше.
Собранный `.exe` основан на `ai_office_desktop.py` + `pywebview`.
