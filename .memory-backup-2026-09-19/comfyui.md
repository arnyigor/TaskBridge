# Проект: comfyui | Срез от 2026-09-13 13:55

# Проект ComfyUI (G:\AIModels\ComfyUI) — рабочая база ComfyUI Desktop

Железо: RTX 5070 Ti, VRAM 16303 MB, RAM 106 GB. GPU одна → прогоны последовательные.
Диск: G: ~175 GB free, C: ~29 GB free. Качать модели ТОЛЬКО на G:.

## Запуск сервера (проверено)
Обязательно `PYTHONIOENCODING=utf-8` + `PYTHONUTF8=1` — иначе логгер падает
`UnicodeEncodeError: charmap cp1251` при загрузке custom_nodes и процесс умирает.
Команда (аналог Desktop, порт 8188):
`G:\AIModels\ComfyUI\.venv\Scripts\python.exe C:\Users\ArnyPC\AppData\Local\Programs\ComfyUI\resources\ComfyUI\main.py
 --user-directory G:\AIModels\ComfyUI\user --input-directory ...\input --output-directory ...\output
 --base-directory G:\AIModels\ComfyUI --database-url sqlite:///G:/AIModels/ComfyUI/user/comfyui.db
 --extra-model-paths-config %APPDATA%\ComfyUI\extra_models_config.yaml --log-stdout --listen 127.0.0.1 --port 8188`
Скрипт: `agent_tests/start_comfyui_8188.ps1`. Задачи через HTTP API `/prompt` (+ `/history/<id>`).
Скрипты прогонов: `agent_tests/seedvr2_run2.py tag model seed offload res blocks_to_swap debug [image]`.
Desktop GUI обычно на порту 8000. Нота: нода UpscaleModelLoader (не LoadUpscaleModel).

## SeedVR2 (нода SeedVR2VideoUpscaler v2.5.24, numz/ComfyUI-SeedVR2)
Модели в `models/SEEDVR2/`: `seedvr2_ema_3b_fp8_e4m3fn` (3.39GB), `seedvr2_ema_7b_fp8_e4m3fn_mixed_block35_fp16`
(8.47GB), `seedvr2_ema_7b_sharp_fp8_e4m3fn_mixed_block35_fp16` (8.47GB), VAE `ema_vae_fp16` (обязателен).
7b fp16 (16.48GB, numz/SeedVR2_comfyUI) — НЕ влезает целиком (пик ~18.5GB).

Замеры (фото 1024x680 → 1626x1080, seed 42):
| вариант | время | peak VRAM |
| 3B fp8 GPU-only | 8.1 s | ~5.5 GB |
| 7B fp8 mixed GPU-only | 12.1 s | 10452 MB |
| 7B sharp fp8 GPU-only | 12.2 s | 10572 MB |
| 7B fp16 + blocks_to_swap=8 + offload cpu | 18.3 s | 14993 MB |
`blocks_to_swap` и `offload_device` НЕ меняют пиксели (bit-identical); 36 блоков ≈ 0.46 GB/блок.
7B fp8 без swap: peak 10.45GB → запас 5.85GB; fp16 без swap не влезет.

## Что лучше для чего (выводы тестов)
- Фото/кожа/пейзаж: **7B sharp fp8** — та же acutance краёв (46.5 против 47.1), но меньше ringing
  (41.97 против 59.30) и меньше отклонение от источника.
- Текст/мелкие надписи: **3B fp8 ≈ 7B fp8 mixed > 7B sharp** (7B sharp заметно хуже: фраз 4.2 vs 6.8).
- Классика (bicubic, 4x-UltraSharp) текст не восстанавливает вообще; ESRGAN даёт звон.

## Текст-тест (контрольный, 400x250 → 1600x1000, метрика = Windows OCR)
Скрипты: `agent_tests/make_text_test.py`, `agent_tests/ocr_win.ps1` (WinRT OCR, без пакетов, -Out пишет UTF-8),
`agent_tests/score_text_ocr.py`. Результаты (4 сида): bicubic F1 .13/фраз 1/чисел 2; UltraSharp .09/1/2 (+2 выдум.);
3B .40/6.8/7.8; 7B fp8 .38/5.8/7.8; 7B sharp .35/4.2/7.8; эталон 1.0/11/12.
Текст у SeedVR2 — РЕКОНСТРУКЦИЯ (7-10 «лишних» чисел), критичные цифры проверять глазами.

## Грабли
- Плагин SeedVR2 **сам скачивает** отсутствующие модели с HF при выборе в ноде; список в ноде
  статичный (из MODEL_REGISTRY, 10 позиций) — удалённые файлы всё равно показаны.
- В `input/` нет картинок с OCR-распознаваемым текстом (проверено 19 шт).
- Картинки для сравнения делать ОТДЕЛЬНЫМИ файлами 1:1, без склейки/ресайза — иначе искажение.

## Артефакты и доки
Артефакты: `agent_tests/` (индивидуальные кропы individual*/ , text_test/, ocr_text_*.txt, манифест удалённых моделей).
Доки проекта: `krea2_edit_demo/*.md` (UPSCALE.md, KREA2_GUIDE.md, BENCHMARK.md, HOWTO.md, PROMPTS.md) + новый `SEEDVR2.md`.