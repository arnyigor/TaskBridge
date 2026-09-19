# Проект: taskbridge_disk_cleanup | Срез от 2026-09-17 00:51

Disk cleanup session (2026-09-16), project G:/Android/AndroidStudioProjects/Taskbridge/downloads-sort.
PRINCIPLE: archive type by CONTENT (detect_engine.py), dups by content/md5, not names.
TOOLS: detect_engine.py, archive_cmp.py, content_plan.py, apply-move-list.ps1, delete-dups.ps1 (Recycle Bin), restore-recycle.ps1 (restore by name), merge-into.ps1, replace-addons.ps1/rollback.
ALL scripts read lists with -Encoding UTF8 (PS5.1 Cyrillic fix). Paths passed absolute (PSScriptRoot empty with -File).
DONE: Downloads→5 folders(_Docs/_Media/_Private/_Projects/_Soft); Soft; Learning; F:\3D Models/Textures/UE/Blender/Assets/Megascans; Blender Addons repo. ~150GB freed (Recycle Bin).
DEST RULES: UE→F:\3D\UE\<cat>; Blender assets→F:\3D\Blender; models→F:\3D\Models; textures→F:\3D\Textures; addons→F:\Install\Soft\3D\Blender\Blender Addons; software→F:\Install\Soft; courses→F:\Install\Learning.
ADDONS: installed in F:\3D\Blender\scripts\addons (99). Repo has 1214 archives, ~1053 not installed (unused candidates). User on Blender 5.2.
SPECIAL: Interniq→F:\3D\Blender\Assets\polygoniq_asset_packs; ERCO→F:\3D\Textures\IES; GAEA dup in F:\Install\Soft\3D\Gaea.
NEXT: decide unused addons; group/sort for display; delete confirmed-unused.
KEY DOCS: downloads-sort/FOLDER-MAP.md, FINAL-REPORT.md, REPORT.md.